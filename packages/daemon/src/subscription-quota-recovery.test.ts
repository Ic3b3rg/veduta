import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
} from './codex-app-server-fake.ts'
import { createConnectionRuntimes } from './connection-inference.ts'
import { loadConnectionsConfig, saveConnectionsConfig } from './connections-config.ts'
import { codexSubscriptionAdapter } from './model-connection-codex.ts'
import { ModelConnectionRegistry } from './model-connection-registry.ts'
import { buildRuntimeRouting } from './model-connection-routing.ts'
import { ModelRouter, NonRetryableModelError, type RouteRequest } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import { createProviderBridge } from './pi-provider-bridge.ts'

const connectionId = 'aaaaaaaa-0000-4000-8000-000000000231'
const now = () => new Date('2026-10-10T10:00:00.000Z')
const secrets = { resolve: () => undefined }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('subscription allowance recovery (issue #231)', () => {
  it.each([
    { name: 'global', kind: 'usage-limit', request: { purpose: 'chat-turn', origin: 'user' } },
    {
      name: 'focused',
      kind: 'usage-limit',
      request: { purpose: 'chat-turn', origin: 'user', spaceId: 'spc-work' },
    },
    {
      name: 'System Space',
      kind: 'usage-limit',
      request: { purpose: 'chat-turn', origin: 'user', spaceId: 'spc-system' },
    },
    {
      name: 'global rate limit',
      kind: 'rate-limit',
      request: { purpose: 'chat-turn', origin: 'user' },
    },
  ] satisfies { name: string; kind: 'usage-limit' | 'rate-limit'; request: RouteRequest }[])(
    'preserves limit feedback and recovers on a new $name turn without reauthorization',
    async ({ request, kind }) => {
      const rootDir = mkdtempSync(join(tmpdir(), 'veduta-quota-recovery-'))
      roots.push(rootDir)
      saveConnectionsConfig(rootDir, {
        version: 1,
        mockEnabled: false,
        selection: { connectionId, modelId: 'gpt-5-codex' },
        connections: [
          {
            id: connectionId,
            method: 'chatgpt-codex',
            provider: 'openai',
            label: 'Personal ChatGPT',
            state: 'connected',
            stateAt: now().toISOString(),
            lastRefreshAt: now().toISOString(),
            createdAt: now().toISOString(),
            selectedModelId: 'gpt-5-codex',
            enabledForFallback: false,
          },
        ],
      })
      let exhausted = true
      let turnCount = 0
      const transport: ReturnType<typeof createFakeCodexTransport> = createFakeCodexTransport({
        responses: {
          'thread/start': () => fakeCodexThreadStartResponse(`thread-${++turnCount}`),
          'turn/start': () => {
            const threadId = `thread-${turnCount}`
            const turnId = `turn-${turnCount}`
            if (exhausted) {
              transport.emit({
                method: 'account/rateLimits/updated',
                params: {
                  rateLimits: {
                    primary: { usedPercent: 100, resetsAt: 1791630000 },
                    secondary: null,
                  },
                },
              })
              transport.emit({
                method: 'error',
                params: {
                  threadId,
                  turnId,
                  willRetry: false,
                  error: {
                    message: "You've hit your usage limit. Try again later.",
                    codexErrorInfo:
                      kind === 'usage-limit' ? 'usageLimitExceeded' : 'rateLimitExceeded',
                  },
                },
              })
            } else {
              transport.emit({
                method: 'item/agentMessage/delta',
                params: { threadId, turnId, itemId: 'reply', delta: 'Available again.' },
              })
              transport.emit({
                method: 'turn/completed',
                params: { threadId, turn: { id: turnId, status: 'completed', error: null } },
              })
            }
            return fakeCodexTurnStartResponse(turnId)
          },
        },
      })
      const failureWrites: Promise<unknown>[] = []
      const registryOptions = {
        rootDir,
        adapters: [
          { ...codexSubscriptionAdapter, availability: async () => ({ available: true as const }) },
        ],
        vault: undefined,
        secrets,
        profile: 'vps' as const,
        fetchImpl: vi.fn<typeof fetch>(),
        now,
        probe: async () => {},
        isRoutableModel: () => true,
        env: {},
        codexSession: async () => transport,
        onRoutingChanged: () => router?.setConfig(config()),
      }
      let registry = new ModelConnectionRegistry(registryOptions)
      const config = () =>
        buildRuntimeRouting({
          rootDir,
          file: loadConnectionsConfig(rootDir),
          secrets,
          profile: 'vps',
          primaryRoutableMethods: registry.primaryRoutableMethods(),
        })
      const router: ModelRouter = new ModelRouter({
        config: config(),
        secrets,
        sleep: async () => {},
        onCallError: (model, error) => {
          failureWrites.push(registry.noteCallFailure(model.connectionId ?? model.provider, error))
        },
      })
      const bridge = createProviderBridge({
        config,
        secrets,
        connections: () => createConnectionRuntimes(registry)(),
      })
      const runner = new PiAgentRunner({
        sessionStore: new PiJsonlSessionStore({
          cwd: rootDir,
          sessionsRoot: join(rootDir, 'sessions'),
        }),
        resolveModel: bridge.resolveModel,
        getApiKey: bridge.getApiKey,
        streamFn: bridge.streamFn,
        toolParameters: {},
      })
      const events: AgentEvent[] = []
      runner.on((event) => {
        events.push(event)
      })
      await runner.start('quota-recovery')
      const send = (text: string) =>
        router!.execute(request, (model, attempt) =>
          runner.prompt(text, { model, retryOfFailedTurn: attempt > 0 }),
        )

      try {
        const firstError = await send('Hello').catch((error: unknown) => error)
        await Promise.all(failureWrites)
        expect(loadConnectionsConfig(rootDir).connections[0]?.state).toBe('connected')
        expect(firstError).toBeInstanceOf(NonRetryableModelError)
        const expectedMessage =
          kind === 'usage-limit' ? /subscription allowance/i : /temporarily rate limited/i
        expect(firstError).toMatchObject({
          message: expect.stringMatching(expectedMessage),
        })
        expect(loadConnectionsConfig(rootDir).connections[0]?.inferenceIssue).toMatchObject({
          kind,
        })
        const issue = (await registry.snapshot()).connections[0]?.inferenceIssue
        expect(issue?.resetsAt).toEqual(
          kind === 'usage-limit' ? ['2026-10-10T11:00:00.000Z'] : undefined,
        )
        expect(firstError).toMatchObject({ message: issue?.message })
        expect(turnCount).toBe(1)

        // A new registry represents reload/restart: temporary inference feedback is durable.
        registry = new ModelConnectionRegistry(registryOptions)
        registry.normalizeStatesOnBoot()
        router.setConfig(config())
        const secondError = await send('Does it work again?').catch((error: unknown) => error)
        await Promise.all(failureWrites)
        expect(secondError).toMatchObject({
          message: expect.stringMatching(expectedMessage),
        })
        expect(turnCount).toBe(2)

        exhausted = false
        await send('Try a new message now')
        expect(turnCount).toBe(3)
        expect((await registry.snapshot()).connections[0]?.inferenceIssue).toBeUndefined()
        expect(events.filter((event) => event.type === 'turn-end')).toMatchObject([
          { text: 'Available again.' },
        ])
        expect(loadConnectionsConfig(rootDir).selection).toEqual({
          connectionId,
          modelId: 'gpt-5-codex',
        })
        expect(transport.requests.some((call) => call.method.startsWith('account/login'))).toBe(
          false,
        )
      } finally {
        transport.close()
      }
    },
  )
})
