import { createNotificationHub, type CodexTransport } from './codex-app-server.ts'
import { ModelConnectionError } from './model-connection-adapter.ts'

/**
 * Deterministic `CodexTransport` for tests (issue #47) — the same footing
 * as `fake-provider.ts`: a normal `src` module, not a `*.test.ts` file, so
 * `model-connection-codex.test.ts`, `model-connection-adapter-contract.test.ts`
 * and `model-connection-registry.test.ts` can all script the exact same
 * shape a real app-server would return without ever spawning one.
 *
 * `notifications()`/`recentNotifications()`/`idle()` are built on the same
 * `createNotificationHub` the real transport uses (issue #47), so this
 * fake mirrors the real transport's per-consumer-subscription semantics
 * exactly: every `notifications()` call is an INDEPENDENT subscription that
 * replays retained history then live frames, never draining what another
 * subscription still needs. `emit()` is how a test pushes a notification
 * for every live subscription — and every future one's ring replay — to
 * see; it is the device-code poll loop's live case. `close()` ends every
 * live subscription, the same as the real transport's own `close()`.
 */

export interface FakeCodexScript {
  /** One entry per JSON-RPC method this fake answers: a fixed value, a `Promise` that resolves to one (lets a test hold a call open to simulate a busy transport), or a factory computed from the call's params and how many times this method has been called so far (0-indexed) — lets a test script `model/list`'s cursor pagination. Returning (or throwing) an `Error` instance makes the call reject with it. */
  responses: Record<
    string,
    unknown | Promise<unknown> | ((params: unknown, callIndex: number) => unknown)
  >
  /** Notifications queued before the transport is ever used — a test rarely needs this; `emit()` covers the live case. */
  notifications?: { method: string; params: unknown }[]
}

export interface FakeCodexTransport extends CodexTransport {
  /** Every call this fake received, in order — for asserting exactly what an adapter sent (e.g. `account/login/start`'s `type` param). */
  requests: { method: string; params: unknown }[]
  closed: boolean
  /** Queues a notification for every live subscription, and for any future subscription's ring replay. */
  emit(notification: { method: string; params: unknown }): void
}

export function createFakeCodexTransport(script: FakeCodexScript): FakeCodexTransport {
  const requests: { method: string; params: unknown }[] = []
  const callIndex = new Map<string, number>()
  const hub = createNotificationHub()
  for (const notification of script.notifications ?? []) hub.retain(notification)
  let closed = false
  let pendingCount = 0

  async function request(method: string, params?: unknown): Promise<unknown> {
    if (closed) {
      throw new Error(`fake Codex transport is closed; cannot call "${method}"`)
    }
    requests.push({ method, params })
    const entry = script.responses[method]
    if (entry === undefined) {
      throw new Error(
        `no fake Codex response scripted for method "${method}" — add it to the test's FakeCodexScript`,
      )
    }
    const index = callIndex.get(method) ?? 0
    callIndex.set(method, index + 1)
    pendingCount++
    try {
      const produced =
        typeof entry === 'function'
          ? (entry as (p: unknown, i: number) => unknown)(params, index)
          : entry
      const value = await produced
      if (value instanceof Error) throw value
      return value
    } finally {
      pendingCount--
    }
  }

  function idle(): boolean {
    return pendingCount === 0 && hub.subscriberCount() === 0
  }

  function close(): void {
    if (closed) return
    closed = true
    hub.endAll(new ModelConnectionError('unreachable', 'the Codex transport was closed'))
  }

  function emit(notification: { method: string; params: unknown }): void {
    hub.retain(notification)
  }

  return {
    request,
    notifications: hub.subscribe,
    recentNotifications: hub.recent,
    idle,
    close,
    requests,
    get closed() {
      return closed
    },
    emit,
  }
}
