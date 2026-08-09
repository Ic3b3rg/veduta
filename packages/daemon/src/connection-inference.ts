import { ModelConnectionError } from './model-connection-adapter.ts'
import { NonRetryableModelError } from './model-routing.ts'
import type { ModelConnectionRuntime, SubscriptionStreamRequest } from './pi-provider-bridge.ts'

/**
 * The one seam between `ModelConnectionRegistry` and the provider bridge's
 * live routing (issue #47, docs/adr/0014-subscription-inference-boundary.md
 * amendment). `registry.runtimes()` already builds the raw per-connection
 * `ModelConnectionRuntime[]` — provider, transport, and, for a Codex
 * connection, the adapter's own `stream` verb bound to that connection's
 * `AdapterContext`. This module wraps ONLY the `stream` member with the two
 * policies a live turn needs that the registry itself must not carry
 * (keeping `runtimes()` a plain synchronous snapshot, `model-connection-registry.ts`'s
 * own doc comment):
 *
 * - a pre-inference freshness check (`registry.ensureFresh`) before every
 *   call, the same discipline `ModelConnectionRegistry.ensureFresh`'s own
 *   doc comment describes for a subscription's automatic refresh;
 * - on an `unauthorized`/`expired` failure mid-turn, marking the connection
 *   `revoked`/`expired` (`registry.noteCallFailure`) and rethrowing as
 *   `NonRetryableModelError`, so `ModelRouter` never fails a text-only
 *   subscription turn over onto a metered fallback (the ADR amendment's
 *   "no implicit subscription → metered BYOK" rule).
 *
 * `server.ts` wires `createConnectionRuntimes(registry)` into the provider
 * bridge's `connections` option in place of a bare `() => registry.runtimes()`,
 * so every subscription runtime the bridge ever resolves already carries
 * this wrapping.
 */

/**
 * The narrow slice of `ModelConnectionRegistry` this module depends on,
 * expressed structurally rather than as `import type { ModelConnectionRegistry }`
 * (issue #47): a plain object literal satisfies this in a test, with no
 * need for the registry's full file-backed setup (adapters, vault, secrets,
 * `isRoutableModel`, …) just to prove the wrapping's own contract.
 * `ModelConnectionRegistry` itself satisfies this interface with no
 * changes.
 */
export interface RuntimeSourceRegistry {
  runtimes(): ModelConnectionRuntime[]
  ensureFresh(connectionId: string): Promise<void>
  noteCallFailure(connectionId: string, error: unknown): Promise<unknown>
}

export function createConnectionRuntimes(
  registry: RuntimeSourceRegistry,
): () => ModelConnectionRuntime[] {
  return () =>
    registry.runtimes().map((runtime) => {
      if (runtime.transport !== 'subscription' || !runtime.stream) return runtime
      const rawStream = runtime.stream
      return {
        ...runtime,
        stream: (request: SubscriptionStreamRequest) =>
          streamWithRecovery(registry, runtime.connectionId, rawStream, request),
      }
    })
}

async function* streamWithRecovery(
  registry: RuntimeSourceRegistry,
  connectionId: string,
  rawStream: (request: SubscriptionStreamRequest) => AsyncIterable<string>,
  request: SubscriptionStreamRequest,
): AsyncGenerator<string, void, void> {
  await registry.ensureFresh(connectionId)
  try {
    yield* rawStream(request)
  } catch (error) {
    if (
      error instanceof ModelConnectionError &&
      (error.code === 'unauthorized' || error.code === 'expired')
    ) {
      await registry.noteCallFailure(connectionId, error)
      throw new NonRetryableModelError(error.message)
    }
    throw error
  }
}
