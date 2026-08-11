import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import { createProviderBridge, type ModelConnectionRuntime } from './pi-provider-bridge.ts'
import {
  ModelRouter,
  NonRetryableModelError,
  type RouterEvent,
  type RuntimeRoutingConfig,
  type SecretResolver,
} from './model-routing.ts'

/**
 * Integration coverage for preserving the non-retryable classification
 * across the pi stream boundary (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md's no-implicit-fallback
 * rule): without that fix, a `NonRetryableModelError` thrown inside
 * `connection-inference.ts`'s stream wrapper had its class identity dropped
 * the moment it crossed the pi stream boundary
 * (`pi-provider-bridge.ts`'s `streamSubscription`) — `PiAgentRunner.prompt()`
 * ended up throwing the RETRYABLE `TurnFailedError`, and `ModelRouter.execute`
 * would fail the turn over onto the next candidate in the SAME turn, exactly
 * the "subscription revoked -> silently answered by metered BYOK" bug the
 * ADR forbids.
 *
 * Wires the real `createProviderBridge` + `PiAgentRunner` + `ModelRouter` —
 * the same three pieces `chat-loop.ts`'s `runTurn` wires in production —
 * rather than a fake provider, so the assertion covers the actual pi stream
 * boundary the bug lived on.
 */

function freshSessionStore(): PiJsonlSessionStore {
  const cwd = mkdtempSync(join(tmpdir(), 'veduta-subscription-failover-cwd-'))
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'veduta-subscription-failover-sessions-'))
  return new PiJsonlSessionStore({ cwd, sessionsRoot })
}

const noKeysResolve: SecretResolver = { resolve: () => undefined }

/** Two connection-bound, keyless (subscription) candidates in the reasoning tier — both stay in `candidates()`'s attempt list (neither is the mock, so the mock-strip rule never removes either). */
function twoCandidateConfig(): RuntimeRoutingConfig {
  return {
    tiers: {
      triage: [],
      reasoning: [
        { provider: 'openai', modelId: 'gpt-5-codex', connectionId: 'sub-conn-1' },
        { provider: 'openai', modelId: 'gpt-5-codex-fallback', connectionId: 'sub-conn-2' },
      ],
    },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 1, reasoning: 5 },
  }
}

describe('subscription-turn failover (issue #47)', () => {
  it('a revoked subscription turn never reaches the BYOK fallback candidate in the same turn', async () => {
    const sessionStore = freshSessionStore()
    const attemptedModels: string[] = []
    const candidate2Calls: string[] = []
    const runtimes: ModelConnectionRuntime[] = [
      {
        connectionId: 'sub-conn-1',
        provider: 'openai',
        transport: 'subscription',
        stream: () => {
          throw new NonRetryableModelError('the subscription was revoked; reconnect and try again')
        },
      },
      {
        connectionId: 'sub-conn-2',
        provider: 'openai',
        transport: 'subscription',
        stream: async function* () {
          candidate2Calls.push('called')
          yield { type: 'text-delta' as const, text: 'this must never run' }
        },
      },
    ]
    const bridge = createProviderBridge({
      config: twoCandidateConfig(),
      secrets: noKeysResolve,
      connections: () => runtimes,
    })
    const runner = new PiAgentRunner({
      sessionStore,
      resolveModel: bridge.resolveModel,
      getApiKey: bridge.getApiKey,
      streamFn: bridge.streamFn,
      toolParameters: {},
    })
    await runner.start('session-1')

    const events: RouterEvent[] = []
    const router = new ModelRouter({
      config: twoCandidateConfig(),
      secrets: noKeysResolve,
      sleep: async () => {},
      onEvent: (event) => events.push(event),
    })

    const error = await router
      .execute({ purpose: 'chat-turn', origin: 'user' }, (model, attempt) => {
        attemptedModels.push(model.connectionId ?? model.provider)
        return runner.prompt('hello', { model, retryOfFailedTurn: attempt > 0 })
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(NonRetryableModelError)
    expect(attemptedModels).toEqual(['sub-conn-1'])
    expect(candidate2Calls).toEqual([])
    expect(events.filter((event) => event.type === 'model.failover')).toHaveLength(0)
  })

  it('a plain provider error on a subscription turn still fails over', async () => {
    const sessionStore = freshSessionStore()
    const attemptedModels: string[] = []
    const runtimes: ModelConnectionRuntime[] = [
      {
        connectionId: 'sub-conn-1',
        provider: 'openai',
        transport: 'subscription',
        stream: () => {
          throw new Error('a transient provider hiccup')
        },
      },
      {
        connectionId: 'sub-conn-2',
        provider: 'openai',
        transport: 'subscription',
        stream: async function* () {
          yield { type: 'text-delta' as const, text: 'answered by the fallback' }
        },
      },
    ]
    const bridge = createProviderBridge({
      config: twoCandidateConfig(),
      secrets: noKeysResolve,
      connections: () => runtimes,
    })
    const runner = new PiAgentRunner({
      sessionStore,
      resolveModel: bridge.resolveModel,
      getApiKey: bridge.getApiKey,
      streamFn: bridge.streamFn,
      toolParameters: {},
    })
    await runner.start('session-2')

    const events: RouterEvent[] = []
    const router = new ModelRouter({
      config: twoCandidateConfig(),
      secrets: noKeysResolve,
      sleep: async () => {},
      onEvent: (event) => events.push(event),
    })

    await router.execute({ purpose: 'chat-turn', origin: 'user' }, (model, attempt) => {
      attemptedModels.push(model.connectionId ?? model.provider)
      return runner.prompt('hello', { model, retryOfFailedTurn: attempt > 0 })
    })

    expect(attemptedModels).toEqual(['sub-conn-1', 'sub-conn-2'])
    expect(events.filter((event) => event.type === 'model.failover')).toHaveLength(1)
  })
})
