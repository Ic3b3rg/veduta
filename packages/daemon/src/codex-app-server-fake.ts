import type { CodexTransport } from './codex-app-server.ts'

/**
 * Deterministic `CodexTransport` for tests (issue #47) — the same footing
 * as `fake-provider.ts`: a normal `src` module, not a `*.test.ts` file, so
 * `model-connection-codex.test.ts`, `model-connection-adapter-contract.test.ts`
 * and `model-connection-registry.test.ts` can all script the exact same
 * shape a real app-server would return without ever spawning one.
 *
 * `notifications()` matches the real transport's drain-only-what-has-
 * arrived semantics (`codex-app-server.ts`'s own doc comment): every call
 * takes whatever is currently queued and returns, never blocking waiting
 * for something new. `emit()` is how a test pushes a notification for the
 * *next* `notifications()` call to see — the device-code poll loop this
 * stands in for.
 */

export interface FakeCodexScript {
  /** One entry per JSON-RPC method this fake answers: a fixed value, or a factory computed from the call's params and how many times this method has been called so far (0-indexed) — lets a test script `model/list`'s cursor pagination. Returning (or throwing) an `Error` instance makes the call reject with it. */
  responses: Record<string, unknown | ((params: unknown, callIndex: number) => unknown)>
  /** Notifications queued before the transport is ever used — a test rarely needs this; `emit()` covers the live case. */
  notifications?: { method: string; params: unknown }[]
}

export interface FakeCodexTransport extends CodexTransport {
  /** Every call this fake received, in order — for asserting exactly what an adapter sent (e.g. `account/login/start`'s `type` param). */
  requests: { method: string; params: unknown }[]
  closed: boolean
  /** Queues a notification for the next `notifications()` drain. */
  emit(notification: { method: string; params: unknown }): void
}

export function createFakeCodexTransport(script: FakeCodexScript): FakeCodexTransport {
  const requests: { method: string; params: unknown }[] = []
  const callIndex = new Map<string, number>()
  const notificationQueue: { method: string; params: unknown }[] = [...(script.notifications ?? [])]
  let closed = false

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
    const value =
      typeof entry === 'function'
        ? (entry as (p: unknown, i: number) => unknown)(params, index)
        : entry
    if (value instanceof Error) throw value
    return value
  }

  function notifications(): AsyncIterable<{ method: string; params: unknown }> {
    const batch = notificationQueue.splice(0, notificationQueue.length)
    return {
      async *[Symbol.asyncIterator]() {
        for (const item of batch) yield item
      },
    }
  }

  function close(): void {
    closed = true
  }

  function emit(notification: { method: string; params: unknown }): void {
    notificationQueue.push(notification)
  }

  return {
    request,
    notifications,
    close,
    requests,
    get closed() {
      return closed
    },
    emit,
  }
}
