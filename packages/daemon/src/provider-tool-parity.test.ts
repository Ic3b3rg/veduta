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

async function runProvider(model: ModelRef, provider: ProviderBridge): Promise<ProviderOutcome> {
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
    // Issue #71 proves the structured AgentRunner path beneath the current
    // primary-routing capability gate. Production keeps supplying that gate
    // from server.ts until the later fail-closed hardening slice.
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

  it('leaves malformed dynamic arguments for AgentRunner validation', async () => {
    const { bridge, transport } = createCodexProvider({
      input: 'not-an-object',
      success: false,
      resultText: 'tool input validation failed',
      finalText: 'invalid tool input handled',
    })

    const outcome = await runProvider(
      {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      },
      bridge,
    )

    expect(outcome.handlerCalls).toBe(0)
    expect(outcome.persistedEffect).toBe('')
    expect(outcome.events).toEqual(
      expect.arrayContaining([
        { type: 'tool-start', toolName: 'echo_value', input: 'not-an-object' },
        expect.objectContaining({ type: 'tool-result', toolName: 'echo_value', isError: true }),
        { type: 'turn-end', text: 'invalid tool input handled' },
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
              text: expect.stringContaining('must be object'),
            },
          ],
        },
      },
    ])
  })
})
