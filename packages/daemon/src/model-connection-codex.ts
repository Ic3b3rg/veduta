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
  InitializeResponseSchema,
  LoginStartResponseSchema,
  ModelListResponseSchema,
  parseCodexNotification,
  parseCodexResponse,
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
 * The `stream` verb (real chat inference through a tool-less
 * `thread/start`+`turn/start`) is deliberately absent — it lands with its
 * own fail-closed tool-set proof in the inference-seam slice that follows
 * this one.
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
  }
}

/** The production singleton — registered once in `server.ts`'s adapters array, exactly like `claudeSubscriptionAdapter`. */
export const codexSubscriptionAdapter: ModelConnectionAdapter = createCodexAdapter({
  resolveBinary: resolveCodexBinary,
  probeTransport: defaultProbeTransport,
})
