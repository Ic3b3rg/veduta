import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  GatewayServerMessageSchema,
  SurfaceSchema,
  type GatewayClientMessage,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type AgentEvent, type ModelRef } from './agent-runner.ts'
import { createChatLoop, type ChatLoop } from './chat-loop.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { createFakeProvider, fakeText, fakeToolCall } from './fake-provider.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { GatewayHub, type GatewaySocket } from './gateway.ts'
import type { AdapterContext } from './model-connection-adapter.ts'
import { codexSubscriptionAdapter } from './model-connection-codex.ts'
import { ModelRouter, type RoutingConfig, type SecretResolver } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import {
  createProviderBridge,
  type ModelConnectionRuntime,
  type ProviderBridge,
} from './pi-provider-bridge.ts'
import {
  normalizeAgentEvents,
  normalizeSessionEntries,
  normalizeSpaceEvent,
} from './provider-parity-test-support.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { piToolParameters } from './tool-parameters.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000073'
const SPACE_ID = 'spc-health'
const SURFACE_ID = 'srf-hydration'
const FIXED_NOW = new Date('2026-08-11T10:00:00.000Z')

const createSurfaceInput = {
  id: SURFACE_ID,
  title: 'Hydration',
  tree: {
    id: 'root',
    type: 'Box' as const,
    children: [
      { id: 'title', type: 'Title' as const, props: { text: 'Hydration' } },
      { id: 'status', type: 'Stat' as const, binding: 'status', props: { label: 'Status' } },
    ],
  },
  state: { status: 'Needs water' },
}

const patchStateInput = {
  surfaceId: SURFACE_ID,
  operations: [
    { target: 'state' as const, op: 'replace' as const, path: '/status', value: 'On track' },
  ],
}

const dynamicToolsParamsSchema = z.object({
  dynamicTools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })),
})

const createdDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function routingConfig(
  model: ModelRef = {
    provider: 'openai',
    modelId: 'gpt-5-codex',
    tier: 'reasoning',
    connectionId: CONNECTION_ID,
  },
): RoutingConfig {
  const selected = {
    provider: model.provider,
    modelId: model.modelId,
    ...(model.connectionId === undefined ? {} : { connectionId: model.connectionId }),
  }
  return {
    tiers: { reasoning: [selected], triage: [selected] },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 20 },
  }
}

function globalChatNotifications(
  threadId: string,
  turnId: string,
  text: string,
): { method: string; params: unknown }[] {
  return [
    {
      method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: 'agent-global', delta: text },
    },
    {
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    },
  ]
}

function scriptedSurfaceTransport(): FakeCodexTransport {
  const createFixture = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-create',
    turnId: 'turn-create',
    callId: 'call-create',
    reverseRequestId: 0,
    tool: 'create_surface',
    input: createSurfaceInput,
    resultText: `created Surface ${SURFACE_ID}`,
    finalText: 'Hydration Surface created.',
  })
  const patchFixture = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-patch',
    turnId: 'turn-patch',
    callId: 'call-patch',
    reverseRequestId: 1,
    tool: 'patch_state',
    input: patchStateInput,
    resultText: `patched state for Surface ${SURFACE_ID}`,
    finalText: 'Hydration updated.',
  })
  const threadIds = ['thread-create', 'thread-patch', 'thread-global']
  const turnIds = ['turn-create', 'turn-patch', 'turn-global']

  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': (_params: unknown, callIndex: number) => {
        const threadId = threadIds[callIndex]
        if (threadId === undefined) throw new Error(`unexpected thread/start call ${callIndex}`)
        return fakeCodexThreadStartResponse(threadId)
      },
      'turn/start': (_params: unknown, callIndex: number) => {
        const turnId = turnIds[callIndex]
        if (turnId === undefined) throw new Error(`unexpected turn/start call ${callIndex}`)
        if (callIndex === 0) {
          transport.emit(createFixture.startNotification)
          transport.emitServerRequest(createFixture.serverRequest)
        } else if (callIndex === 1) {
          transport.emit(patchFixture.startNotification)
          transport.emitServerRequest(patchFixture.serverRequest)
        } else {
          for (const notification of globalChatNotifications(
            'thread-global',
            'turn-global',
            'Open a Space to work on a Surface.',
          )) {
            transport.emit(notification)
          }
        }
        return fakeCodexTurnStartResponse(turnId)
      },
    },
    serverResponseStages: [
      { notifications: createFixture.continuationNotifications },
      { notifications: patchFixture.continuationNotifications },
    ],
  })
  return transport
}

class FakeGatewaySocket implements GatewaySocket {
  readonly sent: GatewayServerMessage[] = []
  private readonly messageHandlers: ((raw: Buffer | string) => void)[] = []
  private readonly closeHandlers: (() => void)[] = []

  send(data: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(data)))
  }

  on(event: 'message', handler: (raw: Buffer | string) => void): void
  on(event: 'close', handler: () => void): void
  on(event: 'message' | 'close', handler: ((raw: Buffer | string) => void) | (() => void)): void {
    if (event === 'message') {
      this.messageHandlers.push(handler as (raw: Buffer | string) => void)
      return
    }
    this.closeHandlers.push(handler as () => void)
  }

  receive(frame: GatewayClientMessage): void {
    const raw = JSON.stringify(frame)
    for (const handler of this.messageHandlers) handler(raw)
  }
}

interface SurfaceProviderOutcome {
  events: unknown[]
  sessionEntries: unknown[]
  surface: unknown
  provenance: unknown
  eventLog: unknown[]
}

async function runSurfaceProvider(
  provider: ProviderBridge,
  model: ModelRef,
): Promise<SurfaceProviderOutcome> {
  const store = new Store({
    rootDir: tempDir('veduta-subscription-parity-root-'),
    now: () => FIXED_NOW,
  })
  const sessionStore = new PiJsonlSessionStore({
    cwd: tempDir('veduta-subscription-parity-cwd-'),
    sessionsRoot: tempDir('veduta-subscription-parity-sessions-'),
  })
  const space = store.spacesEngine.createSpace({ name: 'Empty Authoring' })
  const tools = createFocusedSurfaceTools({
    store,
    templateEngine: new TemplateEngine({ store }),
    spaceId: space.id,
  })
  const runner = new PiAgentRunner({
    sessionStore,
    resolveModel: provider.resolveModel,
    getApiKey: provider.getApiKey,
    streamFn: provider.streamFn,
    toolParameters: piToolParameters(tools),
  })
  const events: AgentEvent[] = []
  runner.on((event) => {
    events.push(event)
  })
  await runner.start(`space:${space.id}`)
  await runner.prompt('Create a hydration Surface', {
    model,
    tools,
    origin: 'trusted:user',
    spaceId: space.id,
  })
  await runner.prompt('Update its status', {
    model,
    tools,
    origin: 'trusted:user',
    spaceId: space.id,
  })
  const session = await sessionStore.load(`space:${space.id}`)

  return {
    events: normalizeAgentEvents(events, { includeTurnOrigins: true }),
    sessionEntries: normalizeSessionEntries(session.entries),
    surface: SurfaceSchema.parse(store.getSurface(SURFACE_ID)),
    provenance: store.surfaceProvenance(SURFACE_ID),
    eventLog: store
      .eventLog(space.id)
      .filter((event) => event.type === 'surface.create' || event.type === 'surface.patch_state')
      .map(({ type, text, origin, payload }) => ({ type, text, origin, payload })),
  }
}

function codexProvider(transport: FakeCodexTransport): ProviderBridge {
  const rootDir = tempDir('veduta-subscription-parity-codex-')
  const noSecrets: SecretResolver = { resolve: () => undefined }
  const context = fromPartial<AdapterContext>({
    connectionId: CONNECTION_ID,
    rootDir,
    vault: undefined,
    secrets: noSecrets,
    fetchImpl: fromPartial<typeof fetch>({}),
    now: () => FIXED_NOW,
    probe: async () => {},
    codexHome: join(rootDir, 'codex', CONNECTION_ID),
    codexTransport: async () => transport,
  })
  const runtime: ModelConnectionRuntime = {
    connectionId: CONNECTION_ID,
    provider: 'openai',
    transport: 'subscription',
    stream: (request) => codexSubscriptionAdapter.stream!(context, request),
  }
  return createProviderBridge({
    config: routingConfig(),
    secrets: noSecrets,
    connections: () => [runtime],
  })
}

function scriptedNativeProvider(): ProviderBridge {
  const native = createFakeProvider()
  native.setResponses([
    { message: fakeToolCall('create_surface', createSurfaceInput) },
    { message: fakeText('Hydration Surface created.') },
    { message: fakeToolCall('patch_state', patchStateInput) },
    { message: fakeText('Hydration updated.') },
  ])
  return native
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function runChatEventLog(provider: ProviderBridge, model: ModelRef): Promise<unknown[]> {
  const rootDir = tempDir('veduta-subscription-chat-parity-root-')
  const store = new Store({ rootDir, now: () => FIXED_NOW })
  const templateEngine = new TemplateEngine({ store })
  const router = new ModelRouter({ config: routingConfig(model), rootDir, now: () => FIXED_NOW })
  const chatLoop = createChatLoop({
    store,
    router,
    sessionStore: new PiJsonlSessionStore({
      cwd: tempDir('veduta-subscription-chat-parity-cwd-'),
      sessionsRoot: tempDir('veduta-subscription-chat-parity-sessions-'),
    }),
    bridge: provider,
    isTrustWrapped: () => false,
    toolsFor: (spaceId) =>
      spaceId === undefined ? [] : createFocusedSurfaceTools({ store, templateEngine, spaceId }),
    send: () => undefined,
  })

  try {
    await chatLoop.handleChatMessage({
      adapterId: 'pwa',
      clientId: 'parity-client',
      text: 'Create a hydration Surface',
      spaceId: SPACE_ID,
      receivedAt: FIXED_NOW.toISOString(),
    })
    await chatLoop.handleChatMessage({
      adapterId: 'pwa',
      clientId: 'parity-client',
      text: 'Update its status',
      spaceId: SPACE_ID,
      receivedAt: FIXED_NOW.toISOString(),
    })
    return store.eventLog(SPACE_ID).map(normalizeSpaceEvent)
  } finally {
    await chatLoop.stop()
  }
}

describe('ChatGPT subscription Surface authoring (issue #73)', () => {
  it('creates and patches a focused-Space Surface live while global chat receives no tools', async () => {
    const rootDir = tempDir('veduta-subscription-surface-root-')
    const store = new Store({ rootDir, now: () => FIXED_NOW })
    const config = routingConfig()
    const router = new ModelRouter({ config, rootDir, now: () => FIXED_NOW })
    const sessionStore = new PiJsonlSessionStore({
      cwd: tempDir('veduta-subscription-surface-cwd-'),
      sessionsRoot: tempDir('veduta-subscription-surface-sessions-'),
    })
    const transport = scriptedSurfaceTransport()
    const bridge = codexProvider(transport)

    const blockedAction = defineTool({
      name: 'unwrapped_action',
      description: 'An unwrapped outbound action that must fail the origin/trust gate.',
      schema: z.object({}),
      level: 'L1',
      egressDomains: ['example.com'],
      handler: () => ({ content: 'must not run' }),
    })
    const focusedSurfaceTools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: SPACE_ID,
    })
    const focusedTools = [...focusedSurfaceTools, blockedAction]
    const pendingTurns: Promise<void>[] = []
    const chatLoop: ChatLoop = createChatLoop({
      store,
      router,
      sessionStore,
      bridge,
      isTrustWrapped: () => false,
      toolsFor: (spaceId) => (spaceId === undefined ? [] : focusedTools),
      send: (clientId, frame) => gateway.sendToClient(clientId, frame),
    })
    const gateway = new GatewayHub(store, {
      onChatTurn: (event) => {
        pendingTurns.push(chatLoop.handleChatMessage(event))
      },
    })
    const socket = new FakeGatewaySocket()
    gateway.connect(socket)
    socket.receive({
      type: 'hello',
      clientId: 'pwa-subscription',
      surfaceCursor: store.latestSurfaceCursor(),
    })

    try {
      socket.receive({ type: 'chat.send', text: 'Create a hydration Surface', spaceId: SPACE_ID })
      await pendingTurns[0]
      socket.receive({ type: 'chat.send', text: 'Mark hydration on track', spaceId: SPACE_ID })
      await pendingTurns[1]
      socket.receive({ type: 'chat.send', text: 'What can you do globally?' })
      await pendingTurns[2]

      const createdFrame = socket.sent.find(
        (frame) => frame.type === 'surface.created' && frame.event.surface.id === SURFACE_ID,
      )
      expect(createdFrame?.type).toBe('surface.created')
      if (createdFrame?.type !== 'surface.created') throw new Error('missing created Surface frame')
      expect(SurfaceSchema.parse(createdFrame.event.surface).state['status']).toBe('Needs water')

      const patchFrame = socket.sent.find(
        (frame) => frame.type === 'surface.patch' && frame.event.patch.surfaceId === SURFACE_ID,
      )
      expect(patchFrame).toMatchObject({
        type: 'surface.patch',
        event: {
          patch: {
            operations: [{ target: 'state', op: 'replace', path: '/status', value: 'On track' }],
          },
        },
      })
      expect(SurfaceSchema.parse(store.getSurface(SURFACE_ID)).state['status']).toBe('On track')
      expect(store.surfaceProvenance(SURFACE_ID)).toEqual({ contentOrigin: 'trusted:system' })

      const focusedTurnEnds = socket.sent.flatMap((frame) =>
        frame.type === 'chat.turn-end' && frame.spaceId === SPACE_ID ? [frame.message.text] : [],
      )
      expect(focusedTurnEnds).toEqual(['Hydration Surface created.', 'Hydration updated.'])
      expect(
        socket.sent
          .flatMap((frame) =>
            frame.type === 'chat.turn-delta' && frame.spaceId === SPACE_ID ? [frame.text] : [],
          )
          .join(''),
      ).toBe('Hydration Surface created.Hydration updated.')

      const dynamicToolDefinitions = transport.requests
        .filter((request) => request.method === 'thread/start')
        .map((request) => dynamicToolsParamsSchema.parse(request.params).dynamicTools)
      const dynamicToolNames = dynamicToolDefinitions.map((tools) => tools.map((tool) => tool.name))
      const expectedFocusedTools = focusedSurfaceTools.map((tool) => tool.name)
      expect(dynamicToolNames).toEqual([expectedFocusedTools, expectedFocusedTools, []])
      expect(dynamicToolNames.flat()).not.toContain('unwrapped_action')
      for (const definitions of dynamicToolDefinitions.slice(0, 2)) {
        expect(definitions.filter((tool) => tool.name === 'list_surfaces')).toHaveLength(1)
        expect(definitions.filter((tool) => tool.name === 'read_surface')).toHaveLength(1)
        const createSchema = definitions.find((tool) => tool.name === 'create_surface')?.inputSchema
        expect(isRecord(createSchema)).toBe(true)
        if (!isRecord(createSchema)) throw new Error('missing create_surface input schema')
        const properties = createSchema['properties']
        expect(isRecord(properties)).toBe(true)
        if (!isRecord(properties)) throw new Error('missing create_surface properties')
        expect(properties['spaceId']).toBeUndefined()
      }

      expect(router.callLog().map((call) => call.model.connectionId)).toEqual([
        CONNECTION_ID,
        CONNECTION_ID,
        CONNECTION_ID,
      ])
      const session = await sessionStore.load(`space:${SPACE_ID}`)
      expect(
        session.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.toolName),
      ).toEqual(['create_surface', 'patch_state'])

      const relevantEvents = store
        .eventLog(SPACE_ID)
        .filter((event) => event.type === 'surface.create' || event.type === 'surface.patch_state')
      expect(relevantEvents.map((event) => [event.type, event.origin])).toEqual([
        ['surface.create', 'trusted:system'],
        ['surface.patch_state', 'trusted:system'],
      ])
    } finally {
      await chatLoop.stop()
      gateway.dispose()
      transport.close()
    }
  })

  it('matches BYOK events, session entries, provenance, and Event log entries', async () => {
    const nativeOutcome = await runSurfaceProvider(scriptedNativeProvider(), {
      provider: 'fake',
      modelId: 'fake-model',
      tier: 'reasoning',
    })

    const providerTransport = scriptedSurfaceTransport()
    const chatTransport = scriptedSurfaceTransport()
    try {
      const subscriptionModel: ModelRef = {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: CONNECTION_ID,
      }
      const nativeModel: ModelRef = {
        provider: 'fake',
        modelId: 'fake-model',
        tier: 'reasoning',
      }
      const subscriptionOutcome = await runSurfaceProvider(
        codexProvider(providerTransport),
        subscriptionModel,
      )
      const nativeEventLog = await runChatEventLog(scriptedNativeProvider(), nativeModel)
      const subscriptionEventLog = await runChatEventLog(
        codexProvider(chatTransport),
        subscriptionModel,
      )

      expect(subscriptionOutcome).toEqual(nativeOutcome)
      expect(subscriptionEventLog).toEqual(nativeEventLog)
      expect(subscriptionOutcome.provenance).toEqual({ contentOrigin: 'trusted:system' })
      expect(subscriptionOutcome.eventLog).toEqual([
        {
          type: 'surface.create',
          text: 'Created Surface "Hydration"',
          origin: 'trusted:system',
          payload: { surfaceId: SURFACE_ID },
        },
        {
          type: 'surface.patch_state',
          text: 'Patched state for Surface "Hydration"',
          origin: 'trusted:system',
          payload: { surfaceId: SURFACE_ID, operations: 1 },
        },
      ])
      expect(subscriptionEventLog).toEqual([
        {
          type: 'turn',
          text: 'Create a hydration Surface',
          origin: 'trusted:user',
          payload: { role: 'user' },
        },
        {
          type: 'surface.create',
          text: 'Created Surface "Hydration"',
          origin: 'trusted:system',
          payload: { surfaceId: SURFACE_ID },
        },
        {
          type: 'turn',
          text: 'Hydration Surface created.',
          origin: 'trusted:system',
          payload: { role: 'assistant', toolCalls: [{ toolName: 'create_surface' }] },
        },
        {
          type: 'turn',
          text: 'Update its status',
          origin: 'trusted:user',
          payload: { role: 'user' },
        },
        {
          type: 'surface.patch_state',
          text: 'Patched state for Surface "Hydration"',
          origin: 'trusted:system',
          payload: { surfaceId: SURFACE_ID, operations: 1 },
        },
        {
          type: 'turn',
          text: 'Hydration updated.',
          origin: 'trusted:system',
          payload: { role: 'assistant', toolCalls: [{ toolName: 'patch_state' }] },
        },
      ])
    } finally {
      providerTransport.close()
      chatTransport.close()
    }
  })
})
