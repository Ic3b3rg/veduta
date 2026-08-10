import { describe, expect, it } from 'vitest'
import { createConnectionRuntimes, type RuntimeSourceRegistry } from './connection-inference.ts'
import { ModelConnectionError } from './model-connection-adapter.ts'
import { NonRetryableModelError } from './model-routing.ts'
import type { ModelConnectionRuntime } from './pi-provider-bridge.ts'

/**
 * `createConnectionRuntimes` depends on `RuntimeSourceRegistry` structurally
 * (`connection-inference.ts`'s own doc comment) — a plain object literal
 * satisfies it, with no need for `ModelConnectionRegistry`'s full
 * file-backed setup (adapters, vault, secrets, `isRoutableModel`, …) just to
 * prove the wrapping's own contract.
 */
function fakeRegistry(
  runtimes: ModelConnectionRuntime[],
  overrides: Partial<RuntimeSourceRegistry> = {},
): { registry: RuntimeSourceRegistry; ensureFreshCalls: string[]; noteCallFailureCalls: string[] } {
  const ensureFreshCalls: string[] = []
  const noteCallFailureCalls: string[] = []
  const registry: RuntimeSourceRegistry = {
    runtimes: () => runtimes,
    ensureFresh: async (connectionId) => {
      ensureFreshCalls.push(connectionId)
      return undefined
    },
    noteCallFailure: async (connectionId) => {
      noteCallFailureCalls.push(connectionId)
    },
    ...overrides,
  }
  return { registry, ensureFreshCalls, noteCallFailureCalls }
}

async function collect(
  stream: AsyncIterable<string>,
): Promise<{ deltas: string[]; error: unknown }> {
  const deltas: string[] = []
  try {
    for await (const delta of stream) deltas.push(delta)
    return { deltas, error: undefined }
  } catch (error) {
    return { deltas, error }
  }
}

describe('createConnectionRuntimes', () => {
  it('leaves a builtin-transport runtime untouched', () => {
    const builtinRuntime: ModelConnectionRuntime = {
      connectionId: 'anthropic',
      provider: 'anthropic',
      transport: 'builtin',
    }
    const { registry } = fakeRegistry([builtinRuntime])

    const runtimes = createConnectionRuntimes(registry)()

    expect(runtimes).toEqual([builtinRuntime])
  })

  it('ensureFresh runs before a subscription stream', async () => {
    const calls: string[] = []
    const runtime: ModelConnectionRuntime = {
      connectionId: 'codex-conn',
      provider: 'openai',
      transport: 'subscription',
      stream: async function* () {
        calls.push('stream')
        yield 'hello'
      },
    }
    const { registry, ensureFreshCalls } = fakeRegistry([runtime])

    const [wrapped] = createConnectionRuntimes(registry)()
    const { deltas, error } = await collect(
      wrapped!.stream!({ modelId: 'gpt-5-codex', prompt: { systemPrompt: '', messages: [] } }),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['hello'])
    expect(ensureFreshCalls).toEqual(['codex-conn'])
    expect(calls).toEqual(['stream'])
  })

  it('a connection ensureFresh finds expired never reaches the adapter stream', async () => {
    const calls: string[] = []
    const runtime: ModelConnectionRuntime = {
      connectionId: 'codex-conn',
      provider: 'openai',
      transport: 'subscription',
      stream: async function* () {
        calls.push('stream')
        yield 'should never run'
      },
    }
    const { registry, noteCallFailureCalls } = fakeRegistry([runtime], {
      ensureFresh: async () => 'expired',
    })

    const [wrapped] = createConnectionRuntimes(registry)()
    const { deltas, error } = await collect(
      wrapped!.stream!({ modelId: 'gpt-5-codex', prompt: { systemPrompt: '', messages: [] } }),
    )

    expect(deltas).toEqual([])
    expect(error).toBeInstanceOf(NonRetryableModelError)
    expect((error as Error).message).toContain('expired')
    expect(calls).toEqual([])
    // `ensureFresh`'s own refresh already persisted the expired state — no
    // second `noteCallFailure` for the same transition.
    expect(noteCallFailureCalls).toEqual([])
  })

  it('a revoked subscription throws NonRetryableModelError so the router never fails over', async () => {
    const runtime: ModelConnectionRuntime = {
      connectionId: 'codex-conn',
      provider: 'openai',
      transport: 'subscription',
      stream: () => {
        throw new ModelConnectionError('unauthorized', 'the provider rejected this credential')
      },
    }
    const { registry, noteCallFailureCalls } = fakeRegistry([runtime])

    const [wrapped] = createConnectionRuntimes(registry)()
    const { deltas, error } = await collect(
      wrapped!.stream!({ modelId: 'gpt-5-codex', prompt: { systemPrompt: '', messages: [] } }),
    )

    expect(deltas).toEqual([])
    expect(error).toBeInstanceOf(NonRetryableModelError)
    expect((error as Error).message).toBe('the provider rejected this credential')
    expect(noteCallFailureCalls).toEqual(['codex-conn'])
  })

  it('an expired subscription also marks the connection and rethrows as NonRetryableModelError', async () => {
    const runtime: ModelConnectionRuntime = {
      connectionId: 'codex-conn',
      provider: 'openai',
      transport: 'subscription',
      stream: () => {
        throw new ModelConnectionError('expired', 'the refresh call failed')
      },
    }
    const { registry, noteCallFailureCalls } = fakeRegistry([runtime])

    const [wrapped] = createConnectionRuntimes(registry)()
    const { error } = await collect(
      wrapped!.stream!({ modelId: 'gpt-5-codex', prompt: { systemPrompt: '', messages: [] } }),
    )

    expect(error).toBeInstanceOf(NonRetryableModelError)
    expect(noteCallFailureCalls).toEqual(['codex-conn'])
  })

  it('propagates any other error unchanged and never marks the connection', async () => {
    const runtime: ModelConnectionRuntime = {
      connectionId: 'codex-conn',
      provider: 'openai',
      transport: 'subscription',
      stream: () => {
        throw new ModelConnectionError('unsupported', 'the turn attempted a tool action')
      },
    }
    const { registry, noteCallFailureCalls } = fakeRegistry([runtime])

    const [wrapped] = createConnectionRuntimes(registry)()
    const { error } = await collect(
      wrapped!.stream!({ modelId: 'gpt-5-codex', prompt: { systemPrompt: '', messages: [] } }),
    )

    expect(error).toMatchObject({ code: 'unsupported' })
    expect(error).not.toBeInstanceOf(NonRetryableModelError)
    expect(noteCallFailureCalls).toEqual([])
  })
})
