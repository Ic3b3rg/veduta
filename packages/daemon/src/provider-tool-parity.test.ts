import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defineTool,
  type AgentEvent,
  type ModelRef,
  type SessionEntry,
  type SessionMessage,
} from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexDynamicToolRoundTripOptions,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { fakeText, fakeToolCall, createFakeProvider } from './fake-provider.ts'
import type { AdapterContext } from './model-connection-adapter.ts'
import { codexSubscriptionAdapter } from './model-connection-codex.ts'
import { defaultRoutingConfig, type SecretResolver } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import {
  createProviderBridge,
  type ModelConnectionRuntime,
  type ProviderBridge,
} from './pi-provider-bridge.ts'
import { piToolParameters } from './tool-parameters.ts'

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

interface ProviderOutcome {
  events: unknown[]
  sessionEntries: unknown[]
  handlerCalls: number
  persistedEffect: string
}

function normalizeEvents(events: AgentEvent[]): unknown[] {
  const normalized: unknown[] = []
  let text = ''
  const flushText = () => {
    if (text === '') return
    normalized.push({ type: 'text-delta', text })
    text = ''
  }

  for (const event of events) {
    if (event.type === 'text-delta') {
      text += event.text
      continue
    }
    flushText()
    if (event.type === 'tool-start') {
      normalized.push({ type: event.type, toolName: event.toolName, input: event.input })
      continue
    }
    if (event.type === 'tool-result') {
      normalized.push({
        type: event.type,
        toolName: event.toolName,
        content: event.content,
        details: event.details,
        isError: event.isError,
      })
      continue
    }
    if (event.type === 'turn-end') {
      normalized.push({ type: event.type, text: event.text })
      continue
    }
    normalized.push(event)
  }
  flushText()
  return normalized
}

function normalizeMessage(message: SessionMessage): unknown {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    ...(message.details === undefined ? {} : { details: message.details }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
  }
}

function normalizeSessionEntries(entries: SessionEntry[]): unknown[] {
  return entries.map((entry) => {
    if (entry.type === 'message') {
      return { type: entry.type, message: normalizeMessage(entry.message) }
    }
    if (entry.type === 'model-change') return { type: entry.type }
    return { type: entry.type, summary: entry.summary, details: entry.details }
  })
}

async function runProvider(
  model: ModelRef,
  provider: ProviderBridge,
  options: { handlerError?: Error } = {},
): Promise<ProviderOutcome> {
  const sessionStore = new PiJsonlSessionStore({
    cwd: tempDir('veduta-provider-parity-cwd-'),
    sessionsRoot: tempDir('veduta-provider-parity-sessions-'),
  })
  let handlerCalls = 0
  const effectPath = join(tempDir('veduta-provider-parity-effect-'), 'echo-values.log')
  const tool = defineTool({
    name: 'echo_value',
    description: 'Echo a value.',
    schema: z.object({ value: z.string() }),
    level: 'L0',
    egressDomains: [],
    handler: ({ value }) => {
      handlerCalls++
      if (options.handlerError) throw options.handlerError
      appendFileSync(effectPath, `${value}\n`)
      return { content: value, details: { echoed: value } }
    },
  })
  const runner = new PiAgentRunner({
    sessionStore,
    resolveModel: provider.resolveModel,
    getApiKey: provider.getApiKey,
    streamFn: provider.streamFn,
    toolParameters: piToolParameters([tool]),
    // Production keeps supplying the temporary capability gate from
    // server.ts until issue #79 removes the compatibility seam.
  })
  const events: AgentEvent[] = []
  runner.on((event) => {
    events.push(event)
  })
  await runner.start('provider-parity')
  await runner.prompt('echo hello', { model, tools: [tool] })
  const branch = await sessionStore.load('provider-parity')

  return {
    events: normalizeEvents(events),
    sessionEntries: normalizeSessionEntries(branch.entries),
    handlerCalls,
    persistedEffect: existsSync(effectPath) ? readFileSync(effectPath, 'utf8') : '',
  }
}

function createCodexProvider(options: FakeCodexDynamicToolRoundTripOptions = {}): {
  bridge: ProviderBridge
  transport: FakeCodexTransport
} {
  const fixture = fakeCodexDynamicToolRoundTrip(options)
  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': fakeCodexThreadStartResponse(),
      'turn/start': fakeCodexTurnStartResponse(),
    },
    notifications: [fixture.startNotification],
    serverRequests: [fixture.serverRequest],
    notificationsAfterServerResponse: fixture.continuationNotifications,
  })
  return createCodexBridge(transport)
}

function createCodexBridge(transport: FakeCodexTransport): {
  bridge: ProviderBridge
  transport: FakeCodexTransport
} {
  const rootDir = tempDir('veduta-provider-parity-codex-')
  const noSecrets: SecretResolver = { resolve: () => undefined }
  const ctx = fromPartial<AdapterContext>({
    connectionId: 'codex-conn',
    rootDir,
    vault: undefined,
    secrets: noSecrets,
    fetchImpl: fromPartial<typeof fetch>({}),
    now: () => new Date('2026-08-11T10:00:00.000Z'),
    probe: async () => {},
    codexHome: join(rootDir, 'codex', 'codex-conn'),
    codexTransport: async () => transport,
  })
  const runtime: ModelConnectionRuntime = {
    connectionId: 'codex-conn',
    provider: 'openai',
    transport: 'subscription',
    stream: (request) => codexSubscriptionAdapter.stream!(ctx, request),
  }
  return {
    transport,
    bridge: createProviderBridge({
      config: defaultRoutingConfig(),
      secrets: noSecrets,
      connections: () => [runtime],
    }),
  }
}

function createSequentialCodexProvider(): {
  bridge: ProviderBridge
  transport: FakeCodexTransport
} {
  const first = fakeCodexDynamicToolRoundTrip({
    callId: 'call-1',
    reverseRequestId: 0,
    input: { value: 'one' },
    resultText: 'one',
  })
  const second = fakeCodexDynamicToolRoundTrip({
    callId: 'call-2',
    reverseRequestId: 1,
    input: { value: 'two' },
    resultText: 'two',
    finalText: 'two calls complete',
  })
  return createCodexBridge(
    createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [first.startNotification],
      serverRequests: [first.serverRequest],
      serverResponseStages: [
        {
          notifications: [first.continuationNotifications[0]!, second.startNotification],
          serverRequests: [second.serverRequest],
        },
        { notifications: second.continuationNotifications },
      ],
    }),
  )
}

describe('AgentRunner dynamic-tool provider parity', () => {
  it('gives the native fake and Codex fake the same lifecycle, session, and tool effect', async () => {
    const native = createFakeProvider()
    native.setResponses([
      { message: fakeToolCall('echo_value', { value: 'hello' }) },
      { message: fakeText('tool result: hello') },
    ])
    const nativeOutcome = await runProvider(
      { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' },
      native,
    )

    const { bridge, transport } = createCodexProvider()
    const codexOutcome = await runProvider(
      {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      },
      bridge,
    )

    expect(nativeOutcome).toEqual(codexOutcome)
    expect(codexOutcome.handlerCalls).toBe(1)
    expect(transport.serverResponses).toEqual([
      {
        id: 0,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: 'hello' }],
        },
      },
    ])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
  })

  it('returns a sanitized handler failure and continues to final assistant text', async () => {
    const { bridge, transport } = createCodexProvider({
      success: false,
      resultText: 'handler failed with sk-***',
      finalText: 'handler failure handled',
    })

    const outcome = await runProvider(
      {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      },
      bridge,
      { handlerError: new Error('handler failed with sk-sensitive-value') },
    )

    expect(outcome.handlerCalls).toBe(1)
    expect(outcome.persistedEffect).toBe('')
    expect(outcome.events).toEqual(
      expect.arrayContaining([
        { type: 'tool-start', toolName: 'echo_value', input: { value: 'hello' } },
        expect.objectContaining({ type: 'tool-result', toolName: 'echo_value', isError: true }),
        { type: 'turn-end', text: 'handler failure handled' },
      ]),
    )
    expect(outcome.sessionEntries).toEqual(
      expect.arrayContaining([
        {
          type: 'message',
          message: expect.objectContaining({ role: 'tool', isError: true }),
        },
      ]),
    )
    expect(transport.serverResponses).toEqual([
      {
        id: 0,
        result: {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: expect.stringContaining('sk-***'),
            },
          ],
        },
      },
    ])
    expect(JSON.stringify(transport.serverResponses)).not.toContain('sk-sensitive-value')
  })

  it('executes each of two sequential accepted call ids exactly once', async () => {
    const { bridge, transport } = createSequentialCodexProvider()

    const outcome = await runProvider(
      {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      },
      bridge,
    )

    expect(outcome.handlerCalls).toBe(2)
    expect(outcome.persistedEffect).toBe('one\ntwo\n')
    expect(outcome.events).toEqual(
      expect.arrayContaining([{ type: 'turn-end', text: 'two calls complete' }]),
    )
    expect(transport.serverResponses.map((response) => response.id)).toEqual([0, 1])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
  })
})
