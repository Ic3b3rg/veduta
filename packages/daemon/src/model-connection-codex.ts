import { join } from 'node:path'
import type { ConnectionLifecycleState, DeviceChallenge, ModelCatalogEntry } from '@veduta/protocol'
import {
  CODEX_BINARY_MISSING_REASON,
  CODEX_PINNED_VERSION,
  ensureCodexHome,
  resolveCodexBinary,
  spawnCodexAppServer,
  type CodexTransport,
} from './codex-app-server.ts'
import {
  AccountReadResponseSchema,
  AgentMessageDeltaNotificationSchema,
  CODEX_REASONING_ITEM_TYPE,
  CODEX_TEXT_ITEM_TYPE,
  CODEX_USER_ITEM_TYPE,
  InitializeResponseSchema,
  ItemNotificationSchema,
  LoginStartResponseSchema,
  ModelListResponseSchema,
  parseCodexNotification,
  parseCodexResponse,
  ThreadStartResponseSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
  type LoginCompletedNotification,
} from './codex-app-server-protocol.ts'
import {
  ModelConnectionError,
  connectionErrorFrom,
  type AdapterContext,
  type AdapterAvailability,
  type AdapterEnv,
  type AuthorizeResult,
  type ModelConnectionAdapter,
  type RefreshResult,
} from './model-connection-adapter.ts'
import { sanitizeErrorText } from './model-routing.ts'
import type { SubscriptionStreamRequest } from './pi-provider-bridge.ts'
import { renderSubscriptionPrompt } from './subscription-prompt.ts'
import { resolveInstalledVersion } from './version.ts'

/**
 * The ChatGPT/Codex Model connection method (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment): a
 * device-code login against the pinned `codex app-server` 0.146.1 child
 * process, `model/list` for the catalog, `account/logout` to disconnect.
 * Every verb but `availability()` reaches the connection's own pooled
 * transport through `ctx.codexTransport` (wired by
 * `model-connection-registry.ts`'s `contextFor`, ultimately backed by
 * `server.ts`'s `CodexSessionPool`) — this module never spawns a process
 * itself. `availability()` has no `AdapterContext` to work with (it runs
 * before any connection exists), so it is injected its own throwaway
 * transport factory via `CodexAdapterDeps`, letting tests substitute the
 * deterministic fake without ever touching a real binary. `server.ts`'s pool
 * factory calls `initializeCodexTransport` on every transport it hands out
 * (issue #47) — `authorize()` no longer sends its own `initialize`, so a
 * respawned or reconnected process is version-pinned before any verb ever
 * reaches it, not only the one that happened to run `authorize()` first.
 *
 * `stream` (issue #47's inference seam,
 * docs/adr/0014-subscription-inference-boundary.md) is a fresh
 * `thread/start` + `turn/start` per call — never reused, never resumed —
 * and acquires exactly ONE `transport.notifications()` subscription for the
 * whole turn, before `turn/start` (issue #47): a concurrent
 * device-code poll on the same pooled transport reads through
 * `recentNotifications()` instead (see `loginCompleted` below) and can
 * never steal a frame this subscription still needs. Every item/turn frame
 * is checked against this call's own `threadId` (and `turnId` when the
 * frame carries one) before being acted on, so a frame from another turn
 * sharing the same pooled transport is ignored rather than misread as this
 * one's. `thread/start` carries the 0.146.1-valid restriction options this
 * transcription could confirm (`approvalPolicy: 'never'`, a read-only
 * sandbox, and disabled web search); the actual
 * fail-closed guarantee is a RUNTIME proof per streamed item, not a
 * start-time assertion (the pinned response carries no tool-set field to
 * assert against): any item that is not plain assistant text, reasoning,
 * or the inert echo of Veduta's own user input triggers `turn/interrupt`,
 * abandons the thread, and refuses. A turn that
 * runs longer than `CODEX_TURN_TIMEOUT_MS` is abandoned the same way.
 */

const METHOD_DISPLAY_NAME = 'ChatGPT subscription'

/** Veduta-imposed cap when the provider's own `account/login/start` response reports no expiry of its own (`DeviceChallenge.expirySource`). */
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000

/** A reserved, non-connection-id directory name for `availability()`'s own throwaway version probe — never collides with a UUID or a legacy provider id (`ModelConnectionIdSchema`). */
const AVAILABILITY_PROBE_DIR = '.availability-probe'

const DEVICE_CODE_DISABLED_REASON =
  'device-code login is disabled for this ChatGPT account: enable it in your ChatGPT security settings or ask your workspace administrator (https://developers.openai.com/codex/auth)'

const REVOKE_NOTE =
  'local credentials were cleared; the provider may still consider the session active — remove it in your OpenAI account settings to be certain'

function clientInfo(): { name: string; version: string } {
  return { name: 'veduta', version: resolveInstalledVersion() }
}

/**
 * Extracts a semver-shaped substring (e.g. `0.146.1`) out of the
 * `initialize` response's `userAgent` (issue #47) — the real v1 protocol
 * embeds the app-server's own version there, confirmed 2026-08-10 by direct
 * observation against the real, pinned binary
 * (`InitializeResponseSchema`'s own doc comment in
 * `codex-app-server-protocol.ts`); there is no separate `version` field to
 * read instead. `undefined` when no such substring is found — the caller
 * must then report the mismatch using the raw `userAgent` itself, never
 * guess a version out of it.
 */
export function codexVersionFromUserAgent(userAgent: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(userAgent)?.[1]
}

/** What `requestInitializeVersion` reports: the extracted version (`undefined` when `userAgent` carried nothing semver-shaped) alongside the raw `userAgent` a mismatch reason falls back to describing. */
interface CodexInitializeProbe {
  version: string | undefined
  userAgent: string
}

function versionMismatchReason(probe: CodexInitializeProbe): string {
  if (probe.version === undefined) {
    // The `userAgent` string is provider-controlled child output — never
    // embedded into a user-visible reason unsanitized (the same discipline
    // `codex-app-server.ts`'s JSON-RPC error handling applies to the
    // child's own `error.message`).
    return `the installed Codex binary's initialize response reported no recognizable version in its userAgent ("${sanitizeErrorText(probe.userAgent)}"); Veduta supports exactly ${CODEX_PINNED_VERSION} — install the pinned version`
  }
  return `the installed Codex binary reports version ${probe.version}; Veduta supports exactly ${CODEX_PINNED_VERSION} — install the pinned version`
}

async function getTransport(ctx: AdapterContext): Promise<CodexTransport> {
  if (ctx.codexTransport === undefined) {
    throw new ModelConnectionError(
      'internal',
      'the Codex transport was not wired into this connection context — this is a daemon wiring bug',
    )
  }
  return ctx.codexTransport({ codexHome: ctx.codexHome })
}

/** Sends `initialize` and returns the version extracted from its `userAgent` (plus the raw `userAgent` itself, for a mismatch reason to fall back on) — shared by `initializeCodexTransport` (throws on mismatch) and `availability()` (reports it instead). */
async function requestInitializeVersion(transport: CodexTransport): Promise<CodexInitializeProbe> {
  const raw = await transport.request('initialize', { clientInfo: clientInfo() })
  const { userAgent } = parseCodexResponse(InitializeResponseSchema, 'initialize', raw)
  return { version: codexVersionFromUserAgent(userAgent), userAgent }
}

/**
 * Sends `initialize` and enforces the exact `CODEX_PINNED_VERSION` pin
 * (issue #47). `server.ts`'s `CodexSessionPool` factory calls this on
 * every transport it creates, BEFORE handing it to any verb — the pool
 * used to hand out unhandshaked transports, so a process respawned after a
 * daemon restart never ran `initialize` at all until whichever verb
 * happened to be first (`authorize()`, always) reached it; a connection
 * that was already `connected` and never re-authorized skipped the version
 * check entirely. `authorize()` no longer sends its own `initialize` — the
 * pool's handshake covers it, and every other verb, the same way.
 */
export async function initializeCodexTransport(transport: CodexTransport): Promise<void> {
  const probe = await requestInitializeVersion(transport)
  if (probe.version !== CODEX_PINNED_VERSION) {
    throw new ModelConnectionError('unsupported', versionMismatchReason(probe))
  }
}

async function authorize(ctx: AdapterContext): Promise<AuthorizeResult> {
  const transport = await getTransport(ctx)

  let raw: unknown
  try {
    raw = await transport.request('account/login/start', { type: 'chatgptDeviceCode' })
  } catch {
    // ref-11: device-code login is beta and administrator-gated; the
    // public protocol gives no separate, stable error shape for "disabled"
    // versus any other `account/login/start` failure, so every failure at
    // this exact call is surfaced as the one actionable, documented reason
    // rather than an unexplained provider error.
    throw new ModelConnectionError('unsupported', DEVICE_CODE_DISABLED_REASON)
  }

  const started = parseCodexResponse(LoginStartResponseSchema, 'account/login/start', raw)
  const challenge: DeviceChallenge =
    started.expiresAt !== undefined
      ? {
          loginId: started.loginId,
          verificationUrl: started.verificationUrl,
          userCode: started.userCode,
          expiresAt: started.expiresAt,
          expirySource: 'provider',
        }
      : {
          loginId: started.loginId,
          verificationUrl: started.verificationUrl,
          userCode: started.userCode,
          expiresAt: new Date(ctx.now().getTime() + DEVICE_CODE_TIMEOUT_MS).toISOString(),
          expirySource: 'veduta-default',
        }
  return { state: 'waiting-for-user', challenge }
}

/**
 * Reads whatever notifications this transport has retained so far, looking
 * for an `account/login/completed` matching `loginId` — via
 * `recentNotifications()`, never `notifications()` (issue #47): this
 * poll and an in-flight chat turn can share the same pooled transport, and
 * a one-shot login-completed check must never consume a frame the turn's
 * own live subscription still needs. A completion for a different login is
 * seen and ignored — never mistaken for this one.
 */
function loginCompleted(transport: CodexTransport, loginId: string): boolean {
  return transport.recentNotifications().some((frame) => {
    const notification = parseCodexNotification(frame.method, frame.params)
    if (notification.method !== 'account/login/completed') return false
    const params = notification.params as LoginCompletedNotification
    return params.loginId === loginId
    // `account/updated` and any unrecognized method are seen and ignored
    // here: the connected account's label comes from `account/read` below,
    // not from this notification stream.
  })
}

async function readAccount(
  transport: CodexTransport,
  options: {
    refreshToken: boolean
    signedOutState: 'expired' | 'waiting-for-user'
  } = { refreshToken: true, signedOutState: 'expired' },
): Promise<RefreshResult> {
  try {
    const raw = await transport.request('account/read', { refreshToken: options.refreshToken })
    const parsed = parseCodexResponse(AccountReadResponseSchema, 'account/read', raw)
    if (parsed.account === null) {
      if (options.signedOutState === 'waiting-for-user') return { state: 'waiting-for-user' }
      // Observed 2026-08-10 against the real 0.146.1 binary: `account/read`
      // answers successfully (never a JSON-RPC error) with `account: null,
      // requiresOpenaiAuth: true` when no ChatGPT account is signed in — a
      // completed login this build's own poll (`loginCompleted` above)
      // somehow missed, or a session the provider ended without ever
      // rejecting a request outright. Treated as `'expired'`, matching this
      // function's existing fallback below for a refresh that failed for
      // any reason other than an explicit `unauthorized`.
      return {
        state: 'expired',
        reason: 'the Codex app-server reports no signed-in ChatGPT account',
      }
    }
    const label = parsed.account.planType ?? parsed.account.email ?? 'ChatGPT'
    return { state: 'connected', account: { label } }
  } catch (error) {
    const err = connectionErrorFrom(error)
    // The public account API distinguishes "the provider rejected this
    // credential" from "a refresh attempt failed" only loosely (ref-11);
    // an explicit `unauthorized` from the transport means the former,
    // everything else (a network failure, a timed-out refresh) the latter.
    const state: ConnectionLifecycleState = err.code === 'unauthorized' ? 'revoked' : 'expired'
    return { state, reason: err.message }
  }
}

async function refresh(ctx: AdapterContext, challenge?: DeviceChallenge): Promise<RefreshResult> {
  const transport = await getTransport(ctx)
  if (challenge !== undefined) {
    const completed = loginCompleted(transport, challenge.loginId)
    if (!completed) {
      // The notification is an optimization, not the source of truth: a
      // transport restart can discard its in-memory notification ring after
      // Codex has already persisted the successful login. A non-refreshing
      // account read recovers that state without rotating tokens on every
      // two-second PWA poll; a still-null account means the user simply has
      // not completed the device flow yet.
      return readAccount(transport, {
        refreshToken: false,
        signedOutState: 'waiting-for-user',
      })
    }
  }
  return readAccount(transport)
}

async function catalog(ctx: AdapterContext): Promise<ModelCatalogEntry[]> {
  const transport = await getTransport(ctx)
  const entries: ModelCatalogEntry[] = []
  let cursor: string | undefined
  do {
    const raw = await transport.request('model/list', {
      includeHidden: false,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const page = parseCodexResponse(ModelListResponseSchema, 'model/list', raw)
    for (const model of page.data) {
      entries.push({
        id: model.id,
        label: model.displayName ?? model.id,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
        // Always true: `model-connection-registry.ts`'s `applyRoutable`
        // overrides this for every non-api-key method regardless — a
        // subscription connection's catalog is never curated down.
        routable: true,
      })
    }
    // Observed 2026-08-10: an exhausted `model/list` reports `nextCursor` as
    // `null`, not simply absent — both end pagination the same way.
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return entries
}

async function verify(ctx: AdapterContext, modelId: string): Promise<void> {
  await ctx.probe(modelId)
}

async function revoke(ctx: AdapterContext): Promise<{ providerRevoked: boolean; note: string }> {
  const transport = await getTransport(ctx)
  await transport.request('account/logout', {})
  // ref-11: `account/logout` attempts best-effort remote revocation but
  // always clears local credentials even when that remote call fails —
  // Veduta must never equate "cleared locally" with "revoked at OpenAI".
  return { providerRevoked: false, note: REVOKE_NOTE }
}

const TOOL_ACTION_REFUSED_MESSAGE =
  'the Codex turn attempted a tool action; refusing to run a turn that could act outside Veduta'

const TURN_ABORTED_MESSAGE = 'the Codex turn was aborted before it completed'

/** How long one `stream()` turn may run before it is abandoned outright (issue #47) — bounds a turn whose app-server process never emits `turn/completed` (a hang, a runaway generation) so a chat request can never wait on it forever. */
export const CODEX_TURN_TIMEOUT_MS = 600_000

const TURN_TIMEOUT_MESSAGE = `the Codex turn exceeded its ${CODEX_TURN_TIMEOUT_MS / 60_000}-minute bound and was abandoned`

/**
 * Real chat inference through a tool-less turn (issue #47): a fresh
 * `thread/start` + `turn/start` per call, NEVER a `thread/resume` — every
 * call abandons its own thread on completion, interruption, refusal, or a
 * `CODEX_TURN_TIMEOUT_MS` timeout. The fail-closed guarantee is the
 * per-item check inside the notification loop below, not anything asserted
 * on `thread/start`'s response — the pinned 0.146.1 response carries no
 * tool-set field to assert against. Exactly ONE `transport.notifications()`
 * subscription is acquired for the whole turn, before `turn/start` (issue
 * #47) — never re-subscribed mid-loop, so a device-code poll sharing
 * this connection's pooled transport (`loginCompleted`, reading through
 * `recentNotifications()` instead) can never steal a frame this
 * subscription still needs, and every frame this turn does not itself own
 * (a stale frame from an earlier turn on the same pooled transport) is
 * filtered by `threadId`/`turnId` rather than acted on.
 */
async function* stream(
  ctx: AdapterContext,
  request: SubscriptionStreamRequest,
): AsyncGenerator<string, void, void> {
  const transport = await getTransport(ctx)

  const threadStartRaw = await transport.request('thread/start', {
    model: request.modelId,
    // The 0.146.1-valid restriction options this transcription could
    // confirm: never let the app-server auto-approve anything, and keep its
    // own filesystem sandbox read-only. Neither field's value nor `config`
    // below is itself the fail-closed guarantee — the
    // per-item check in the loop below is; every field here is best-effort
    // defense in depth and the turn must still work if the app-server
    // ignores any of them.
    approvalPolicy: 'never',
    // transcription note: field name/value per 0.146.1 — `ThreadStartParams`'
    // own read-only sandbox enum (`read-only`/`workspace-write`/
    // `danger-full-access`). Corrected from an earlier `sandboxPolicy: 'readOnly'`
    // guess: `codex app-server generate-json-schema --experimental` against
    // a locally installed 0.146.0 binary confirms `ThreadStartParams` names
    // this field `sandbox`, not `sandboxPolicy` — `sandboxPolicy` is
    // `TurnStartParams`' own, differently-shaped field. `permissions` (a
    // named profile id) is deliberately NOT sent alongside `sandbox`: the
    // same schema documents the two as mutually exclusive on this call.
    sandbox: 'read-only',
    // transcription note: field name/value per 0.146.1 — `Config.web_search`
    // (enum `disabled`/`cached`/`indexed`/`live`), confirmed the same way as
    // `sandbox` above; turns off the app-server's native web-search tool.
    // `disabled_tools` targets the app-server's remaining default tool set;
    // this build could not independently confirm its exact value shape, so
    // it is sent best-effort only — `Config`'s own schema declares
    // `additionalProperties: true`, so an unrecognized override key is
    // inert rather than a `thread/start` failure.
    config: { web_search: 'disabled', disabled_tools: true },
    // Do not send `dynamicTools`, even as `[]`: the pinned 0.146.1 server
    // rejects that experimental field unless `initialize` opted into its
    // `experimentalApi` capability. Veduta needs no dynamic tools and does
    // not widen its protocol capabilities merely to transmit an empty set
    // (issue #47); the runtime item guard below remains the fail-closed
    // boundary for every tool-shaped item.
    cwd: ctx.codexHome,
  })
  const {
    thread: { id: threadId },
  } = parseCodexResponse(ThreadStartResponseSchema, 'thread/start', threadStartRaw)

  let turnId: string | undefined
  const abandonThread = async (): Promise<void> => {
    if (turnId === undefined) return
    try {
      await transport.request('turn/interrupt', { threadId, turnId })
    } catch {
      // Best-effort: the thread is abandoned regardless — never reused,
      // never resumed (thread-per-turn, issue #47).
    }
  }

  if (request.signal?.aborted) {
    await abandonThread()
    throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
  }

  // Acquired BEFORE `turn/start` (issue #47) so no frame the app-server
  // emits between `turn/start` and this loop's first read is ever missed —
  // and never re-acquired below, so this turn's own subscription is the
  // only reader competing for its frames.
  const subscription = transport.notifications()[Symbol.asyncIterator]()

  // The try/finally that releases `subscription` starts IMMEDIATELY after
  // it is acquired (issue #47) — `turn/start` itself is inside it, not
  // before it: a rejected `turn/start` call, or a response that fails
  // `parseCodexResponse`, used to leave this subscription open forever
  // (the transport's own `idle()` never seeing it go away) because the
  // finally block used to start only after `turn/start` had already
  // succeeded.
  let turnTimer: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined
  try {
    const turnStartRaw = await transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: renderSubscriptionPrompt(request.prompt) }],
    })
    const parsedTurnStart = parseCodexResponse(TurnStartResponseSchema, 'turn/start', turnStartRaw)
    const currentTurnId = parsedTurnStart.turn.id
    turnId = currentTurnId
    const streamedItemIds = new Set<string>()

    const turnTimedOut = new Promise<'timeout'>((resolve) => {
      turnTimer = setTimeout(() => resolve('timeout'), CODEX_TURN_TIMEOUT_MS)
    })

    // Races the abort signal against the notification wait itself (issue
    // #47), rather than only checking `request.signal?.aborted` at the top
    // of each loop iteration: a signal that fires while `subscription.next()`
    // is still pending on a silent turn (no further frame ever arrives) used
    // to go unnoticed until the NEXT frame woke the loop up, or — absent
    // one — the full `CODEX_TURN_TIMEOUT_MS` bound. The listener is added
    // once, here, and removed in the `finally` below regardless of how the
    // turn ends.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (request.signal === undefined) return
      if (request.signal.aborted) {
        resolve('aborted')
        return
      }
      abortListener = () => resolve('aborted')
      request.signal.addEventListener('abort', abortListener)
    })

    while (true) {
      const outcome = await Promise.race([
        subscription.next().then((result) => ({ kind: 'frame' as const, result })),
        turnTimedOut.then(() => ({ kind: 'timeout' as const })),
        aborted.then(() => ({ kind: 'aborted' as const })),
      ])

      if (outcome.kind === 'aborted') {
        await abandonThread()
        throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
      }

      if (outcome.kind === 'timeout') {
        await abandonThread()
        throw new ModelConnectionError('unreachable', TURN_TIMEOUT_MESSAGE)
      }

      if (outcome.result.done) {
        // The subscription's own contract (`codex-app-server.ts`'s
        // `createNotificationHub`) throws rather than completing normally —
        // this is unreachable in practice, kept only so the generic
        // `IteratorResult` type is exhaustively handled.
        throw new ModelConnectionError(
          'unreachable',
          'the Codex transport ended its notification stream',
        )
      }
      const frame = outcome.result.value

      if (frame.method === 'turn/completed') {
        const completed = parseCodexResponse(
          TurnCompletedNotificationSchema,
          'turn/completed',
          frame.params,
        )
        if (completed.threadId !== threadId) continue
        if (completed.turn.id !== currentTurnId) continue
        return
      }

      if (frame.method === 'item/agentMessage/delta') {
        const parsed = parseCodexResponse(
          AgentMessageDeltaNotificationSchema,
          frame.method,
          frame.params,
        )
        if (parsed.threadId !== threadId || parsed.turnId !== currentTurnId) continue
        streamedItemIds.add(parsed.itemId)
        if (parsed.delta) yield parsed.delta
        continue
      }

      if (frame.method === 'item/started' || frame.method === 'item/completed') {
        const parsed = parseCodexResponse(ItemNotificationSchema, frame.method, frame.params)
        if (parsed.threadId !== threadId) continue
        if (parsed.turnId !== currentTurnId) continue
        const { item } = parsed
        if (item.type === CODEX_TEXT_ITEM_TYPE) {
          if (frame.method === 'item/completed' && !streamedItemIds.has(item.id) && item.text) {
            yield item.text
          }
          continue
        }
        if (item.type === CODEX_USER_ITEM_TYPE) continue // echo of the request we just sent
        if (item.type === CODEX_REASONING_ITEM_TYPE) continue // silently dropped, never fatal
        // Any other item type — command execution, patch application, web
        // search, an MCP tool call, or a type this build has never seen —
        // is the runtime-observable proof the turn attempted to act outside
        // Veduta.
        await abandonThread()
        throw new ModelConnectionError('unsupported', TOOL_ACTION_REFUSED_MESSAGE)
      }

      // An unrelated notification method (e.g. `account/updated`, seen
      // while a turn happens to be in flight) is ignored here — only
      // item/turn notifications are this loop's concern.
    }
  } finally {
    if (turnTimer) clearTimeout(turnTimer)
    if (abortListener) request.signal?.removeEventListener('abort', abortListener)
    await subscription.return?.()
  }
}

export interface CodexAdapterDeps {
  /** Resolves the pinned binary path; production passes `resolveCodexBinary`. */
  resolveBinary: (env: NodeJS.ProcessEnv, rootDir: string) => string | undefined
  /** Spawns (or, in tests, fakes) a throwaway transport for `availability()`'s one-time version probe — the only verb with no `AdapterContext`/pooled connection to reuse. */
  probeTransport: (options: { binary: string; codexHome: string }) => Promise<CodexTransport>
}

function defaultProbeTransport(options: {
  binary: string
  codexHome: string
}): Promise<CodexTransport> {
  ensureCodexHome(options.codexHome)
  return Promise.resolve(
    spawnCodexAppServer({
      binary: options.binary,
      codexHome: options.codexHome,
      clientInfo: clientInfo(),
    }),
  )
}

/**
 * Builds the Codex adapter with injectable binary-resolution/probe
 * dependencies (issue #47). `availability()` runs its probe on every call —
 * it does NOT cache its own result (issue #47): `model-connection-registry.ts`'s
 * `getAvailability` is the one process-lifetime availability cache, keyed
 * per adapter method id, and a second cache here would only let this
 * adapter's own probe result silently outlive whatever invalidated the
 * registry's copy.
 */
export function createCodexAdapter(deps: CodexAdapterDeps): ModelConnectionAdapter {
  async function availability(env: AdapterEnv): Promise<AdapterAvailability> {
    const binary = deps.resolveBinary(env.env, env.rootDir)
    if (binary === undefined) {
      return { available: false, reason: CODEX_BINARY_MISSING_REASON }
    }
    const codexHome = join(env.rootDir, 'codex', AVAILABILITY_PROBE_DIR)
    let transport: CodexTransport | undefined
    try {
      transport = await deps.probeTransport({ binary, codexHome })
      const probe = await requestInitializeVersion(transport)
      return probe.version === CODEX_PINNED_VERSION
        ? { available: true }
        : { available: false, reason: versionMismatchReason(probe) }
    } catch (error) {
      return { available: false, reason: connectionErrorFrom(error).message }
    } finally {
      transport?.close()
    }
  }

  return {
    methodId: 'chatgpt-codex',
    providerName: 'openai',
    providerDisplayName: 'OpenAI',
    methodDisplayName: METHOD_DISPLAY_NAME,
    capabilities: {
      authorization: 'device-code',
      refresh: 'automatic',
      revocation: 'provider',
      vedutaTools: false,
      metered: false,
    },
    availability,
    authorize,
    refresh,
    catalog,
    verify,
    revoke,
    stream,
  }
}

/** The production singleton — registered once in `server.ts`'s adapters array, exactly like `claudeSubscriptionAdapter`. */
export const codexSubscriptionAdapter: ModelConnectionAdapter = createCodexAdapter({
  resolveBinary: resolveCodexBinary,
  probeTransport: defaultProbeTransport,
})
