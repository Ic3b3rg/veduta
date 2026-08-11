import {
  createNotificationHub,
  createServerRequestHub,
  type CodexRequestId,
  type CodexServerRequest,
  type CodexTransport,
} from './codex-app-server.ts'
import type {
  AccountReadResponse,
  CodexModelEntry,
  InitializeResponse,
  LoginStartResponse,
  ModelListResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from './codex-app-server-protocol.ts'
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
 *
 * The response factories below centralize the observed envelopes and their
 * load-bearing parsed fields from the pinned 0.146.1 binary. Their comments
 * distinguish directly observed fields from optional transcription-only
 * fields. Tests use these factories instead of repeating obsolete top-level
 * ids or other guessed protocol objects.
 */

/** Complete `initialize` result observed from the pinned binary, with only the embedded version varied for pin-mismatch tests. */
export function fakeCodexInitializeResponse(version = '0.146.1'): InitializeResponse {
  return {
    userAgent: `veduta/${version} (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)`,
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'macos',
  }
}

interface FakeCodexLoginStartOptions {
  loginId: string
  userCode: string
  expiresAt?: string
}

/** Complete device-code `account/login/start` result observed from the pinned binary; `expiresAt` exercises the adapter's documented optional provider-expiry path. */
export function fakeCodexLoginStartResponse({
  loginId,
  userCode,
  expiresAt,
}: FakeCodexLoginStartOptions): LoginStartResponse {
  return {
    type: 'chatgptDeviceCode',
    loginId,
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** The observed `account/read` envelope with the auth-gated, transcription-only plan field used by connected-state tests. */
export function fakeCodexConnectedAccountReadResponse(
  planType = 'ChatGPT Plus',
): AccountReadResponse {
  return { account: { planType }, requiresOpenaiAuth: false }
}

/** Complete unauthenticated `account/read` result observed from the pinned binary. */
export function fakeCodexSignedOutAccountReadResponse(): AccountReadResponse {
  return { account: null, requiresOpenaiAuth: true }
}

interface FakeCodexModelEntryOptions {
  id: string
  displayName?: string
  description?: string
  isDefault?: boolean
}

/** Complete `model/list` entry shape observed from the pinned binary, with load-bearing display fields varied by the test. */
export function fakeCodexModelEntry({
  id,
  displayName = id,
  description = `${displayName} description`,
  isDefault = false,
}: FakeCodexModelEntryOptions): CodexModelEntry {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      {
        reasoningEffort: 'medium',
        description: 'Balances speed and reasoning depth for everyday tasks',
      },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
    defaultServiceTier: null,
    isDefault,
  }
}

/** Complete cursor-paginated `model/list` envelope observed from the pinned binary. */
export function fakeCodexModelListResponse(
  data: CodexModelEntry[],
  nextCursor: string | null = null,
): ModelListResponse {
  return { data, nextCursor }
}

/** Load-bearing `thread/start` result shape observed against the pinned binary: the thread id is nested under `thread`. */
export function fakeCodexThreadStartResponse(id = 'thread-1'): ThreadStartResponse {
  return { thread: { id } }
}

/** Load-bearing `turn/start` result shape observed against the pinned binary: the turn id is nested under `turn`. */
export function fakeCodexTurnStartResponse(id = 'turn-1'): TurnStartResponse {
  return { turn: { id } }
}

export interface FakeCodexDynamicToolRoundTripOptions {
  threadId?: string
  turnId?: string
  callId?: string
  reverseRequestId?: CodexRequestId
  tool?: string
  input?: unknown
  resultText?: string
  finalText?: string
  success?: boolean
}

/** Complete frames observed for one 0.146.1 dynamic-tool call, with only deterministic test values parameterized. */
export function fakeCodexDynamicToolRoundTrip(options: FakeCodexDynamicToolRoundTripOptions = {}): {
  startNotification: { method: string; params: unknown }
  serverRequest: CodexServerRequest
  continuationNotifications: { method: string; params: unknown }[]
} {
  const threadId = options.threadId ?? 'thread-1'
  const turnId = options.turnId ?? 'turn-1'
  const callId = options.callId ?? 'call-1'
  const tool = options.tool ?? 'echo_value'
  const input = options.input ?? { value: 'hello' }
  const resultText = options.resultText ?? 'hello'
  const finalText = options.finalText ?? 'tool result: hello'
  const success = options.success ?? true
  return {
    startNotification: {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        startedAtMs: 1,
        item: {
          id: callId,
          type: 'dynamicToolCall',
          namespace: null,
          tool,
          arguments: input,
          status: 'inProgress',
          contentItems: null,
          success: null,
          durationMs: null,
        },
      },
    },
    serverRequest: {
      id: options.reverseRequestId ?? 0,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId,
        callId,
        namespace: null,
        tool,
        arguments: input,
      },
    },
    continuationNotifications: [
      {
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          completedAtMs: 2,
          item: {
            id: callId,
            type: 'dynamicToolCall',
            namespace: null,
            tool,
            arguments: input,
            status: success ? 'completed' : 'failed',
            contentItems: [{ type: 'inputText', text: resultText }],
            success,
            durationMs: 1,
          },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: 'agent-1',
          delta: finalText,
        },
      },
      {
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'completed' } },
      },
    ],
  }
}

export interface FakeCodexScript {
  /** One entry per JSON-RPC method this fake answers: a fixed value, a `Promise` that resolves to one (lets a test hold a call open to simulate a busy transport), or a factory computed from the call's params and how many times this method has been called so far (0-indexed) — lets a test script `model/list`'s cursor pagination. Returning (or throwing) an `Error` instance makes the call reject with it. */
  responses: Record<
    string,
    unknown | Promise<unknown> | ((params: unknown, callIndex: number) => unknown)
  >
  /** Notifications queued before the transport is ever used — a test rarely needs this; `emit()` covers the live case. */
  notifications?: { method: string; params: unknown }[]
  /** Child-initiated requests queued for the first live `serverRequests()` subscriber. */
  serverRequests?: CodexServerRequest[]
  /** Notifications emitted only after Veduta answers the first child-initiated request. */
  notificationsAfterServerResponse?: { method: string; params: unknown }[]
}

export interface FakeCodexTransport extends CodexTransport {
  /** Every call this fake received, in order — for asserting exactly what an adapter sent (e.g. `account/login/start`'s `type` param). */
  requests: { method: string; params: unknown }[]
  closed: boolean
  /** Queues a notification for every live subscription, and for any future subscription's ring replay. */
  emit(notification: { method: string; params: unknown }): void
  /** Every response Veduta sent to a child-initiated request, in order. */
  serverResponses: { id: CodexRequestId; result: unknown }[]
  /** Pushes one child-initiated request to every current request subscriber. */
  emitServerRequest(request: CodexServerRequest): void
}

export function createFakeCodexTransport(script: FakeCodexScript): FakeCodexTransport {
  const requests: { method: string; params: unknown }[] = []
  const callIndex = new Map<string, number>()
  const hub = createNotificationHub()
  const serverRequestHub = createServerRequestHub()
  for (const notification of script.notifications ?? []) hub.retain(notification)
  const queuedServerRequests = [...(script.serverRequests ?? [])]
  const notificationsAfterServerResponse = [...(script.notificationsAfterServerResponse ?? [])]
  let closed = false
  let pendingCount = 0
  const serverResponses: { id: CodexRequestId; result: unknown }[] = []

  function serverRequests(): AsyncIterable<CodexServerRequest> {
    const subscription = serverRequestHub.subscribe()
    return {
      [Symbol.asyncIterator]() {
        const iterator = subscription[Symbol.asyncIterator]()
        for (const request of queuedServerRequests.splice(0)) serverRequestHub.retain(request)
        return iterator
      },
    }
  }

  async function respond(id: CodexRequestId, result: unknown): Promise<void> {
    if (closed) {
      throw new Error('fake Codex transport is closed; cannot answer a server request')
    }
    serverResponses.push({ id, result })
    for (const notification of notificationsAfterServerResponse.splice(0)) {
      hub.retain(notification)
    }
  }

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
    return (
      pendingCount === 0 && hub.subscriberCount() === 0 && serverRequestHub.subscriberCount() === 0
    )
  }

  function close(): void {
    if (closed) return
    closed = true
    const error = new ModelConnectionError('unreachable', 'the Codex transport was closed')
    hub.endAll(error)
    serverRequestHub.endAll(error)
  }

  function emit(notification: { method: string; params: unknown }): void {
    hub.retain(notification)
  }

  function emitServerRequest(request: CodexServerRequest): void {
    serverRequestHub.retain(request)
  }

  return {
    request,
    serverRequests,
    respond,
    notifications: hub.subscribe,
    recentNotifications: hub.recent,
    idle,
    close,
    requests,
    serverResponses,
    get closed() {
      return closed
    },
    emit,
    emitServerRequest,
  }
}
