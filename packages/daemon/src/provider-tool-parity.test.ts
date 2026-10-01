import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  AtomNodeSchema,
  type ServiceConnection,
  type SpaceCapabilityGrant,
  SurfaceSchema,
} from '@veduta/protocol'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { defineTool, type AgentEvent, type ModelRef } from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexDynamicToolRoundTripOptions,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { fakeText, fakeToolCall, createFakeProvider } from './fake-provider.ts'
import { createGithubMcpTools } from './github-mcp-tools.ts'
import type { GithubMcpService } from './github-mcp-service.ts'
import type { AdapterContext } from './model-connection-adapter.ts'
import { codexSubscriptionAdapter } from './model-connection-codex.ts'
import { defaultRoutingConfig, type SecretResolver } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import {
  createProviderBridge,
  type ModelConnectionRuntime,
  type ProviderBridge,
} from './pi-provider-bridge.ts'
import { normalizeAgentEvents, normalizeSessionEntries } from './provider-parity-test-support.ts'
import { Store } from './store.ts'
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

async function runProvider(
  model: ModelRef,
  provider: ProviderBridge,
  options: { handlerError?: Error; schema?: z.ZodTypeAny } = {},
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
    schema: options.schema ?? z.object({ value: z.string() }),
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
  })
  const events: AgentEvent[] = []
  runner.on((event) => {
    events.push(event)
  })
  await runner.start('provider-parity')
  await runner.prompt('echo hello', { model, tools: [tool] })
  const branch = await sessionStore.load('provider-parity')

  return {
    events: normalizeAgentEvents(events),
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
    stream: (request) => codexSubscriptionAdapter.primaryInference.stream(ctx, request),
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
  it('runs the same reviewed GitHub read ToolDef through BYOK and subscription inference', async () => {
    const prompt = 'List open issues in example/disposable'
    const input = { owner: 'example', repo: 'disposable' }
    const run = async (method: 'byok' | 'subscription') => {
      const store = new Store({ rootDir: tempDir(`veduta-github-${method}-`) })
      const space = store.spacesEngine.createSpace({ name: 'Work' })
      const calls: string[] = []
      const github = fromPartial<GithubMcpService>({
        listOpenIssues: async ({
          spaceId,
          repository,
        }: Parameters<GithubMcpService['listOpenIssues']>[0]) => {
          calls.push(`${spaceId}:${repository.owner}/${repository.name}`)
          return {
            text: JSON.stringify({ issues: [{ number: 14, title: 'Disposable result' }] }),
            connection: fromPartial<ServiceConnection>({ id: 'svc-github-test' }),
            grant: fromPartial<SpaceCapabilityGrant>({ id: 'grant-test' }),
            origin: 'untrusted:github-mcp-svc-github-test',
          }
        },
      })
      const tools = createGithubMcpTools({
        store,
        github,
        spaceId: space.id,
        now: () => new Date('2026-10-01T12:00:00.000Z'),
      })
      const provider =
        method === 'byok'
          ? (() => {
              const fake = createFakeProvider()
              fake.setResponses([
                { message: fakeToolCall('list_github_issues', input) },
                { message: fakeText('done') },
              ])
              return fake
            })()
          : createCodexProvider({
              tool: 'list_github_issues',
              input,
              resultText: JSON.stringify({
                repository: 'example/disposable',
                count: 1,
                issues: [{ number: 14, title: 'Disposable result' }],
                surfaceId: `srf-github-issues-${createHash('sha256')
                  .update('github-subscription:call-1')
                  .digest('hex')
                  .slice(0, 24)}`,
              }),
              finalText: 'done',
            }).bridge
      const sessionStore = new PiJsonlSessionStore({
        cwd: tempDir(`veduta-github-${method}-cwd-`),
        sessionsRoot: tempDir(`veduta-github-${method}-sessions-`),
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
      await runner.start(`github-${method}`)
      await runner.prompt(prompt, {
        model:
          method === 'byok'
            ? { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' }
            : {
                provider: 'openai',
                modelId: 'gpt-5-codex',
                tier: 'reasoning',
                connectionId: 'codex-conn',
              },
        tools,
        spaceId: space.id,
        trigger: { kind: 'chat', id: `github-${method}` },
        initiatingTurn: { clientId: 'parity-client', turnId: `github-${method}` },
      })
      const surface = store.listSurfaces(space.id).find((item) => item.title === 'GitHub issues')
      expect(surface).toBeDefined()
      expect(SurfaceSchema.parse(surface).spaceId).toBe(space.id)
      expect(JSON.stringify(surface!.tree)).toContain('Disposable result')
      expect(store.eventLog(space.id).some((event) => event.type === 'surface.create')).toBe(true)
      return {
        calls: calls.map((call) => call.slice(call.indexOf(':') + 1)),
        toolResults: events
          .filter((event) => event.type === 'tool-result')
          .map((event) => ({ toolName: event.toolName, isError: event.isError })),
      }
    }
    const byok = await run('byok')
    const subscription = await run('subscription')
    expect(byok).toEqual({
      calls: ['example/disposable'],
      toolResults: [{ toolName: 'list_github_issues', isError: false }],
    })
    expect(subscription).toEqual(byok)
  })

  it('rejects malformed Atom arguments with precise shared diagnostics before either provider can execute', async () => {
    const input = { value: { id: 'text', type: 'Text', props: { text: 'Visible', fontSize: 20 } } }
    const error = JSON.stringify({
      code: 'invalid_tool_input',
      tool: 'echo_value',
      validationIssues: [
        {
          path: ['value', 'props', 'fontSize'],
          code: 'unrecognized_keys',
          message: 'Unrecognized key "fontSize"',
        },
      ],
    })
    const native = createFakeProvider()
    native.setResponses([
      { message: fakeToolCall('echo_value', input) },
      { message: fakeText('Invalid Atom was not saved') },
    ])
    const options = { schema: z.object({ value: AtomNodeSchema }) }
    const nativeOutcome = await runProvider(
      { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' },
      native,
      options,
    )
    expect(nativeOutcome.events).toContainEqual(
      expect.objectContaining({ type: 'tool-result', isError: true, content: error }),
    )
    const { bridge, transport } = createCodexProvider({
      input,
      success: false,
      resultText: error,
      finalText: 'Invalid Atom was not saved',
    })
    const codexOutcome = await runProvider(
      { provider: 'openai', modelId: 'gpt-5-codex', tier: 'reasoning', connectionId: 'codex-conn' },
      bridge,
      options,
    )
    expect(nativeOutcome).toEqual(codexOutcome)
    expect(codexOutcome.handlerCalls).toBe(0)
    expect(codexOutcome.persistedEffect).toBe('')
    expect(codexOutcome.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        isError: true,
        content: error,
      }),
    )
    expect(transport.serverResponses).toEqual([
      {
        id: 0,
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: error }],
        },
      },
    ])
  })

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
