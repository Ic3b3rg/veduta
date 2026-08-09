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
  CODEX_REASONING_ITEM_TYPE,
  CODEX_TEXT_ITEM_TYPE,
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
 * deterministic fake without ever touching a real binary.
 *
 * `stream` (issue #47's inference seam,
 * docs/adr/0014-subscription-inference-boundary.md) is a fresh
 * `thread/start` + `turn/start` per call — never reused, never resumed.
 * `thread/start` carries the 0.146.1-valid restriction options this
 * transcription could confirm (`approvalPolicy: 'never'`, a read-only
 * sandbox); the actual fail-closed guarantee is a RUNTIME proof per
 * streamed item, not a start-time assertion (the pinned response carries no
 * tool-set field to assert against): any item that is not plain assistant
 * text or reasoning triggers `turn/interrupt`, abandons the thread, and
 * refuses.
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

function versionMismatchReason(found: string): string {
  return `the installed Codex binary reports version ${found}; Veduta supports exactly ${CODEX_PINNED_VERSION} — install the pinned version`
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

async function authorize(ctx: AdapterContext): Promise<AuthorizeResult> {
  const transport = await getTransport(ctx)
  const initializeRaw = await transport.request('initialize', { clientInfo: clientInfo() })
  parseCodexResponse(InitializeResponseSchema, 'initialize', initializeRaw)

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

/** Drains whatever notifications are currently buffered, looking for an `account/login/completed` matching `loginId`. A completion for a different login is drained and ignored — never mistaken for this one. */
async function loginCompleted(transport: CodexTransport, loginId: string): Promise<boolean> {
  let completed = false
  for await (const frame of transport.notifications()) {
    const notification = parseCodexNotification(frame.method, frame.params)
    if (notification.method === 'account/login/completed') {
      const params = notification.params as LoginCompletedNotification
      if (params.loginId === loginId) completed = true
    }
    // `account/updated` and any unrecognized method are drained and
    // ignored here: the connected account's label comes from `account/read`
    // below, not from this notification stream.
  }
  return completed
}

async function readAccount(transport: CodexTransport): Promise<RefreshResult> {
  try {
    const raw = await transport.request('account/read', { refreshToken: true })
    const account = parseCodexResponse(AccountReadResponseSchema, 'account/read', raw)
    const label = account.planType ?? account.email ?? 'ChatGPT'
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
    const completed = await loginCompleted(transport, challenge.loginId)
    if (!completed) return { state: 'waiting-for-user' }
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
    for (const model of page.models) {
      entries.push({
        id: model.id,
        label: model.label ?? model.id,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
        // Always true: the registry's `applyRoutable` overrides this for
        // every non-api-key method regardless (M5) — a subscription
        // connection's catalog is never curated down.
        routable: true,
      })
    }
    cursor = page.nextCursor
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

/** How long `stream()` waits before re-polling `transport.notifications()` when a drain came back empty and the turn has not completed — the real transport's notifications arrive asynchronously as the child process writes them; a test that pre-loads its whole scripted sequence before calling `stream()` never reaches this path at all. */
const NOTIFICATION_POLL_INTERVAL_MS = 25

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Real chat inference through a tool-less turn (issue #47): a fresh
 * `thread/start` + `turn/start` per call, NEVER a `thread/resume` — every
 * call abandons its own thread on completion, interruption, or refusal. The
 * fail-closed guarantee is the per-item check inside the notification loop
 * below, not anything asserted on `thread/start`'s response — the pinned
 * 0.146.1 response carries no tool-set field to assert against.
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
    // own filesystem sandbox read-only. Neither field's value is itself the
    // fail-closed guarantee — the per-item check below is.
    approvalPolicy: 'never',
    // transcription note: field name/value per 0.146.1 — the read-only
    // sandbox policy.
    sandboxPolicy: 'readOnly',
    cwd: ctx.codexHome,
  })
  const { threadId } = parseCodexResponse(ThreadStartResponseSchema, 'thread/start', threadStartRaw)

  const abandonThread = async (): Promise<void> => {
    try {
      await transport.request('turn/interrupt', { threadId })
    } catch {
      // Best-effort: the thread is abandoned regardless — never reused,
      // never resumed (thread-per-turn, issue #47).
    }
  }

  if (request.signal?.aborted) {
    await abandonThread()
    throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
  }

  const turnStartRaw = await transport.request('turn/start', {
    threadId,
    input: renderSubscriptionPrompt(request.prompt),
  })
  parseCodexResponse(TurnStartResponseSchema, 'turn/start', turnStartRaw)

  while (true) {
    if (request.signal?.aborted) {
      await abandonThread()
      throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
    }

    let sawNotification = false
    for await (const frame of transport.notifications()) {
      sawNotification = true

      if (frame.method === 'turn/completed') {
        parseCodexResponse(TurnCompletedNotificationSchema, 'turn/completed', frame.params)
        return
      }

      if (frame.method === 'item/updated' || frame.method === 'item/completed') {
        const { item } = parseCodexResponse(ItemNotificationSchema, frame.method, frame.params)
        if (item.type === CODEX_TEXT_ITEM_TYPE) {
          const text = item.delta ?? item.text
          if (text) yield text
          continue
        }
        if (item.type === CODEX_REASONING_ITEM_TYPE) continue // silently dropped, never fatal
        // Any other item type — command execution, patch application, web
        // search, an MCP tool call, or a type this build has never seen —
        // is the runtime-observable proof the turn attempted to act outside
        // Veduta.
        await abandonThread()
        throw new ModelConnectionError('unsupported', TOOL_ACTION_REFUSED_MESSAGE)
      }

      // An unrelated notification method (e.g. `account/updated`, drained
      // while a turn happens to be in flight) is ignored here — only
      // item/turn notifications are this loop's concern.
    }

    if (!sawNotification) await delay(NOTIFICATION_POLL_INTERVAL_MS)
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
 * dependencies (issue #47). `availability()`'s result is cached in this
 * call's own closure — "once per process" in production, where exactly one
 * `codexSubscriptionAdapter` instance ever exists, and per-test-instance in
 * `model-connection-codex.test.ts`, where each test builds its own via this
 * factory instead of sharing the module-level singleton.
 */
export function createCodexAdapter(deps: CodexAdapterDeps): ModelConnectionAdapter {
  let cached: AdapterAvailability | undefined

  async function availability(env: AdapterEnv): Promise<AdapterAvailability> {
    if (cached) return cached
    const binary = deps.resolveBinary(env.env, env.rootDir)
    if (binary === undefined) {
      cached = { available: false, reason: CODEX_BINARY_MISSING_REASON }
      return cached
    }
    const codexHome = join(env.rootDir, 'codex', AVAILABILITY_PROBE_DIR)
    let transport: CodexTransport | undefined
    try {
      transport = await deps.probeTransport({ binary, codexHome })
      const raw = await transport.request('initialize', { clientInfo: clientInfo() })
      const initialized = parseCodexResponse(InitializeResponseSchema, 'initialize', raw)
      cached =
        initialized.version === CODEX_PINNED_VERSION
          ? { available: true }
          : { available: false, reason: versionMismatchReason(initialized.version) }
    } catch (error) {
      cached = { available: false, reason: connectionErrorFrom(error).message }
    } finally {
      transport?.close()
    }
    return cached
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
