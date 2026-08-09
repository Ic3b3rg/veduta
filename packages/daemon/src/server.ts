import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  AuthSessionSchema,
  AuthStatusSchema,
  ActionInvocationSchema,
  OneTimeCodeSchema,
  PairingCodeSchema,
  PushSubscriptionSchema,
  UpdatePinningSchema,
  WebAuthnOptionsEnvelopeSchema,
} from '@veduta/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { z } from 'zod'
import type { ModelRef } from './agent-runner.ts'
import { AllowlistSurfaceManager } from './allowlist-surface.ts'
import { ApprovalSurfaceManager } from './approval-surface.ts'
import { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import { AuditSurfaceManager } from './audit-surface.ts'
import { AuthStoreError, type AuthStore } from './auth-store.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { chatToolRegistry as buildChatToolRegistry } from './chat-tool-registry.ts'
import { createChatLoop } from './chat-loop.ts'
import { appendConnectedDevicesSurface } from './connected-devices-surface.ts'
import { loadConnectionsConfig, type ConnectionsFile } from './connections-config.ts'
import { EgressPolicy, installEgressEnforcement } from './egress.ts'
import { EventIngestion, type FetchStage } from './event-ingestion.ts'
import type { ExternalEvent } from './external-event.ts'
import { promptFullText } from './full-text-flow.ts'
import { GatewayHub } from './gateway.ts'
import { CalendarSource, GmailSource, GoogleTokenProvider } from './google-sources.ts'
import { loadHeartbeatConfig } from './heartbeat-config.ts'
import { HeartbeatSurfaceManager } from './heartbeat-surface.ts'
import { Heartbeat } from './heartbeat.ts'
import { loadIngestionConfig } from './ingestion-config.ts'
import { loadMemoryConfig } from './memory-config.ts'
import { MemoryIndex, type MemoryIndexOptions } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { MockAgentRunner } from './mock-agent-runner.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import { mockReaderComplete } from './mock-provider.ts'
import { createMockReflectionDistiller } from './mock-reflection-distiller.ts'
import { createMockWorkerRunner, createMockWorkerReviewComplete } from './mock-worker-runner.ts'
import { BYOK_ADAPTERS } from './model-connection-byok.ts'
import { claudeSubscriptionAdapter } from './model-connection-claude.ts'
import { reconcileByokConnections } from './model-connection-migration.ts'
import { ModelConnectionRegistry } from './model-connection-registry.ts'
import { registerModelConnectionRoutes } from './model-connection-routes.ts'
import {
  deriveRoutingConfig,
  egressProvidersFor,
  RoutingState,
} from './model-connection-routing.ts'
import {
  ModelRouter,
  envSecretResolver,
  loadRoutingConfig,
  withMockFallback,
  type SecretResolver,
} from './model-routing.ts'
import { NotificationCenter } from './notification-center.ts'
import { NotificationSettingsSurfaceManager } from './notification-settings-surface.ts'
import { loadNotificationsConfig } from './notifications-config.ts'
import { registerOnboardingRoutes } from './onboarding-routes.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import { createProviderBridge, isBuiltinModel, probeModel } from './pi-provider-bridge.ts'
import { PushStore } from './push-store.ts'
import { QuarantinedReader } from './quarantined-reader.ts'
import { defaultRedactor } from './redaction.ts'
import { Reflection } from './reflection.ts'
import { ReflectionSurfaceManager } from './reflection-surface.ts'
import { Scheduler } from './scheduler.ts'
import {
  compositeSecretResolver,
  resolveVaultKeyMaterial,
  SecretsVault,
  VAULT_FILE_NAME,
} from './secrets-vault.ts'
import { WatchManager } from './watch-renewal.ts'
import { sendPwaAsset } from './static-assets.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { Store, SurfaceActionError } from './store.ts'
import { SurfaceNotPinnableError } from './surface-engine.ts'
import { appendSystemSurface, ensureSystemSpace } from './system-space.ts'
import { TemplateEngine } from './template-engine.ts'
import { TreeProposalSurfaceManager } from './tree-proposal.ts'
import { isTrustWrapped, TrustLayer } from './trust-layer.ts'
import { ensureDataVersion } from './update/data-version.ts'
import { UpdateManager } from './update-manager.ts'
import { usageSurface } from './usage-surface.ts'
import { resolveInstalledVersion } from './version.ts'
import {
  ensureVapidKeys,
  isAllowedPushEndpoint,
  WebPushTransport,
  type PushTransport,
} from './web-push-transport.ts'
import { WorkerPool } from './worker.ts'

// The client sends only node/action/payload: state keys come from declared
// Atom actions, never from the client (ADR-0003).
const SurfaceActionBodySchema = ActionInvocationSchema

// `POST /api/surfaces/:surfaceId/pin`'s body (issues/022-emergent-templates.md):
// pinning is a boolean user intent, nothing else the client can shape.
const PinSurfaceBodySchema = z.object({ pinned: z.boolean() })

const DeviceNameSchema = z.string().trim().min(1).max(80)

const RegistrationOptionsBodySchema = z.object({
  oneTimeCode: OneTimeCodeSchema,
  deviceName: DeviceNameSchema,
})

const WebAuthnResponseSchema = z.object({ id: z.string().min(1) }).passthrough()

const RegistrationVerifyBodySchema = z.object({
  ceremonyId: z.string().min(1),
  response: WebAuthnResponseSchema,
})

const LoginVerifyBodySchema = RegistrationVerifyBodySchema.extend({
  deviceName: DeviceNameSchema.optional(),
})

const PushSubscriptionDeleteBodySchema = z.object({ endpoint: z.string().min(1) })

export interface ServerOptions {
  pwaDistDir?: string
  dataDir?: string
  auth?: ServerAuthOptions
  https?: { key: string; cert: string }
  /** Injectable clock so tests drive the scheduler with a fake clock. */
  now?: () => Date
  /**
   * Egress allowlist (issue #15, docs/SECURITY.md §3.4). `enforce` installs
   * the policy as the process-wide dispatcher — only the production/VPS and
   * Local VPS profiles set this (`index.ts`); the loopback (mock) profile
   * and the test suite must never get a global denying dispatcher by default.
   */
  egress?: { enforce?: boolean; extraAllow?: readonly string[] }
  /**
   * Injectable Web Push transport (issue #18): tests and a future dev
   * profile inject a recording fake so no real push service is ever
   * contacted. Defaults to `WebPushTransport` with the daemon's own
   * generated-or-loaded VAPID keypair.
   */
  pushTransport?: PushTransport
  /**
   * The execution profile this daemon is running under (issue 023,
   * `docs/adr/0009-local-vps-profile.md`), identifying which onboarding
   * copy/behavior to show — `loopback` (dev, no auth), `local-vps` (real
   * passkey auth over `http://localhost`, supervised by the Local VPS
   * runner script), or `vps` (real deployment, `VEDUTA_PUBLIC_DOMAIN` set,
   * supervised by systemd). Defaults to today's derivation from `auth.mode`
   * (`auth.mode === 'production' ? 'vps' : 'loopback'`) so every existing
   * caller keeps its current behavior; only a caller that explicitly knows
   * it is the Local VPS profile (`index.ts`'s `startLocalVps` boot branch)
   * needs to set this.
   */
  profile?: 'loopback' | 'local-vps' | 'vps'
  /**
   * Onboarding wizard wiring (issue #19). `domain`/`tlsActive` are the
   * domain/TLS state the wizard's `domain` step confirms — the wizard never
   * accepts a domain value, it only reflects what this profile already
   * detected (`index.ts` knows `VEDUTA_PUBLIC_DOMAIN`; loopback has none).
   * `scheduleExit` is `POST /api/onboarding/finish`'s graceful-exit hook,
   * fired on the VPS and Local VPS profiles so their supervisor (systemd on
   * the VPS, the Local VPS runner loop, issue 023) restarts the daemon with
   * the new boot-time-immutable routing/vault/ingestion config; injectable
   * so tests can assert it fires (or doesn't) without actually killing the
   * process. `env` feeds `buildOnboardingStatus`'s
   * `VEDUTA_LEGACY_HOME`/`VEDUTA_ONBOARDING=force` reads. All four default
   * to the loopback profile's shape: no domain, no TLS, `process.env`, and a
   * real (unref'd, so it never keeps the event loop alive by itself) exit
   * scheduled ~500ms out.
   */
  onboarding?: {
    domain?: string
    tlsActive?: boolean
    scheduleExit?: () => void
    env?: NodeJS.ProcessEnv
  }
}

export type ServerAuthOptions =
  | { mode: 'dev' }
  | {
      mode: 'production'
      store: AuthStore
      allowedOrigins: string[]
      hstsMaxAgeSeconds?: number
    }

const defaultPwaDistDir = fileURLToPath(new URL('../../pwa/dist/', import.meta.url))

/**
 * The default `<rootDir>` when `options.dataDir` is not given, mirroring
 * `SpacesEngine`'s own default (`spaces-engine.ts`'s `defaultDataDir`): a
 * fresh mkdtemp under vitest/`NODE_ENV=test`, `<cwd>/.veduta` otherwise.
 * `buildServer` resolves this once and passes it explicitly to both
 * `ensureDataVersion` and `Store`, rather than letting `Store` fall back to
 * its own default internally — that default mints a brand-new temp
 * directory on every call, so calling it twice (once here, once inside
 * `Store`) would gate one directory and construct the Store in another.
 */
function resolveDataDir(dataDir: string | undefined): string {
  if (dataDir !== undefined) return dataDir
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return mkdtempSync(join(tmpdir(), 'veduta-daemon-'))
  }
  return join(process.cwd(), '.veduta')
}

/**
 * Opens the vault once and derives the whole daemon's `secret://` resolver
 * from it (issue #15; issue #19). The vault is opened
 * whenever key material is available — even with no `secrets.vault` file
 * yet (`SecretsVault.open` starts an empty in-memory vault in that case) —
 * so the returned instance is the single one both `ModelRouter`'s secrets
 * resolver AND the onboarding BYOK/integrations routes write through;
 * opening a second `SecretsVault` over the same file would race on the
 * write-tmp-then-rename lock. With no key material at all, `vault` is
 * `undefined` and the resolver falls back to `secret://env/...` alone —
 * the loopback profile's default shape, since it never sets a vault
 * keyfile. Every
 * successful resolution registers the value with `defaultRedactor` so it
 * never survives into a durable sink or console output (issue #15).
 * Also returns the raw `keyMaterial` it resolved (issue 020): the
 * migration routes' `buildImportPlan`/`applyImport` need the same key
 * material `createBackup` requires, and re-deriving it a second way (or
 * skipping the backup pre-check entirely) would let the wizard and the CLI
 * disagree about whether a backup — and therefore an import — is possible.
 */
function openVaultAndSecrets(rootDir: string): {
  vault: SecretsVault | undefined
  secrets: SecretResolver
  keyMaterial: Buffer | undefined
} {
  const vaultPath = join(rootDir, VAULT_FILE_NAME)
  const keyMaterial = resolveVaultKeyMaterial()
  const vaultFileExists = existsSync(vaultPath)
  if (vaultFileExists && !keyMaterial) {
    // Fail closed (docs/SECURITY.md §4): a vault file with no key
    // material to open it is a misconfiguration, never a silent fall-back
    // to unresolved secret://vault/... references.
    throw new Error(
      `${vaultPath} exists but no vault key material is set (VEDUTA_VAULT_KEYFILE or VEDUTA_VAULT_KEY)`,
    )
  }
  const vault = keyMaterial ? SecretsVault.open(rootDir, keyMaterial) : undefined
  const inner: SecretResolver = vault
    ? compositeSecretResolver(vault, envSecretResolver)
    : envSecretResolver
  const secrets: SecretResolver = {
    resolve(secretRef: string) {
      const value = inner.resolve(secretRef)
      if (typeof value === 'string') defaultRedactor.register(value)
      return value
    },
  }
  return { vault, secrets, keyMaterial }
}

/**
 * Opens the `MemoryIndex` over `<rootDir>/memory.sqlite`, recovering once
 * from a file `DatabaseSync` cannot open at all — a corrupt header, a
 * truncated write, a file restored mid-copy — rather than letting that
 * failure crash the whole daemon before `reconcile()` even gets a chance to
 * run. `memory-index.ts`'s own module doc documents deleting the file (plus
 * its `-wal`/`-shm` companions) and rebuilding as a fully supported recovery
 * path: this is that path, run automatically, since the Event log and FACTS
 * on disk were always the only truth this index caches. If the retry itself
 * still throws (e.g. the directory is not writable), that failure is a real
 * boot-blocking problem and is left to propagate rather than hidden.
 */
function openMemoryIndex(
  rootDir: string,
  spacesEngine: MemoryIndexOptions['spacesEngine'],
  now: () => Date,
): MemoryIndex {
  try {
    return new MemoryIndex({ rootDir, spacesEngine, now })
  } catch (error) {
    console.error('memory index open failed; rebuilding from a fresh file', error)
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = join(rootDir, `memory.sqlite${suffix}`)
      if (existsSync(candidate)) rmSync(candidate)
    }
    return new MemoryIndex({ rootDir, spacesEngine, now })
  }
}

/**
 * `POST /api/onboarding/finish`'s default graceful-exit hook (fired on the
 * VPS and Local VPS profiles, whose supervisors — systemd, the Local VPS
 * runner loop — restart the daemon): after a 500ms grace period (so the
 * HTTP response has time to actually flush to the client), close `app` —
 * draining open connections, stopping the scheduler/gateway — THEN exit,
 * instead of killing the process out from under any in-flight work. A ~3s unref'd
 * fallback force-exits regardless, in case `app.close()` itself hangs (e.g.
 * a socket that never drains): systemd (`Restart=always`) must still get
 * its restart even if graceful shutdown gets stuck. Both timers are
 * unref'd so neither keeps the event loop alive by itself.
 *
 * `exitCode` defaults to `0` (the onboarding wizard's own finish — a plain
 * restart) but `UpdateManager.applyUpdate` (issue #43,
 * `docs/adr/0013-signed-self-update.md`) wires a `75` variant instead: the
 * dedicated code the supervisor wrapper (`deploy/veduta-run`, a later task)
 * watches for to know a restart means "run the update transaction", not
 * "just come back up".
 */
function defaultScheduleExit(app: FastifyInstance, exitCode = 0): () => void {
  return () => {
    const graceTimer = setTimeout(() => {
      void app.close().finally(() => process.exit(exitCode))
    }, 500)
    graceTimer.unref()
    const forceExitTimer = setTimeout(() => process.exit(exitCode), 3_500)
    forceExitTimer.unref()
  }
}

/** The dedicated exit code `applyUpdate` requests a restart with (issue #43, `docs/adr/0013-signed-self-update.md`) — distinct from `0` (the onboarding wizard's own plain restart) so the wrapper can tell the two apart. */
const UPDATE_REQUESTED_EXIT_CODE = 75

/** Known egress hosts per LLM provider (issue #15). Providers outside this map have no fetch-based transport this daemon can enforce yet. */
const PROVIDER_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
}

/**
 * The label a `model.failover` system notice names the destination by
 * (issue #47): a connection-bound `ModelRef` resolves to that connection's
 * own user-facing label, read fresh off `connections.json` rather than
 * cached, so a renamed connection is announced under its current name; an
 * unbound legacy `ModelRef` (no `connectionId`) falls back to
 * `provider/modelId`, exactly as bare as the router's own log entries.
 */
function connectionLabel(rootDir: string, model: ModelRef): string {
  if (model.connectionId !== undefined) {
    const record = loadConnectionsConfig(rootDir).connections.find(
      (candidate) => candidate.id === model.connectionId,
    )
    if (record) return record.label
  }
  return `${model.provider}/${model.modelId}`
}

const EgressConfigSchema = z.object({ allow: z.array(z.string()) })

/**
 * Builds the process-wide egress allowlist (issue #15, docs/SECURITY.md
 * §3.4) from everything the daemon is actually configured to reach:
 * configured LLM providers, Google's OAuth/API hosts (when ingestion has a
 * Google source), the ACME directory host, every registered tool's declared
 * `egressDomains`, operator-supplied extra hosts, and `<rootDir>/egress.json`
 * if present. A configured provider outside `PROVIDER_HOSTS` fails boot
 * outright — unsupported until its transport can be enforced (fail closed,
 * never a silent gap in the allowlist).
 */
export function assembleEgressPolicy(input: {
  rootDir: string
  providers: readonly string[]
  googleHosts?: readonly string[]
  acmeDirectoryUrl?: string
  toolDomains: readonly string[]
  extraAllow?: readonly string[]
  allowLoopback?: boolean
}): EgressPolicy {
  // Fail closed by default, matching `EgressPolicy`'s own default: the VPS
  // and Local VPS profiles — both of which must NOT trust loopback specially
  // — never set this; only the loopback profile's `buildServer` call site
  // (and the test suite) opts in.
  const policy = new EgressPolicy({ allowLoopback: input.allowLoopback ?? false })
  for (const provider of input.providers) {
    const host = PROVIDER_HOSTS[provider]
    if (!host) {
      throw new Error(
        `egress policy: provider "${provider}" has no known egress host — declare it in <rootDir>/egress.json (docs/SECURITY.md §3.4) before configuring it`,
      )
    }
    policy.allow(host)
  }
  if (input.googleHosts) policy.allow(input.googleHosts)
  if (input.acmeDirectoryUrl) {
    let acmeHost: string
    try {
      acmeHost = new URL(input.acmeDirectoryUrl).hostname
    } catch {
      throw new Error('egress policy: acmeDirectoryUrl is not a valid URL')
    }
    policy.allow(acmeHost)
  }
  policy.allow(input.toolDomains)
  if (input.extraAllow) policy.allow(input.extraAllow)
  const egressJsonPath = join(input.rootDir, 'egress.json')
  if (existsSync(egressJsonPath)) {
    const raw: unknown = JSON.parse(readFileSync(egressJsonPath, 'utf8'))
    policy.allow(EgressConfigSchema.parse(raw).allow)
  }
  // Push service hosts (issue #18) are deliberately absent from this
  // policy: `web-push` calls `https.request` directly, bypassing the
  // Undici dispatcher this policy installs into, so it cannot be the
  // enforcement point for push egress. That enforcement lives in
  // `web-push-transport.ts`'s static `isAllowedPushEndpoint` allowlist,
  // checked both at subscribe time and again before every send.
  return policy
}

/**
 * The Gateway in scaffold form (issue #1): HTTP API + chat WebSocket
 * on loopback, dev profile only. TLS/passkeys are issue #5, the real
 * ChannelAdapter surface sync is issue #4.
 */
export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({
    logger: false,
    ...(options.https ? { https: options.https } : {}),
  })
  const now = options.now ?? (() => new Date())
  // Resolved once, here — before the dataVersion gate and before `Store`
  // exists — so both agree on the same directory. Mirrors `SpacesEngine`'s
  // own default (`spaces-engine.ts`'s `defaultDataDir`): calling that
  // mkdtemp logic a second time would hand `Store` a different throwaway
  // temp dir than the one just gated.
  const dataDir = resolveDataDir(options.dataDir)
  // The dataVersion boot gate (issue #43, `docs/adr/0013-signed-self-update.md`):
  // must run before any store opens a single file. A throw here propagates
  // out of `buildServer` — `index.ts`'s top-level `start().catch` prints it
  // and exits 1, never a partially-booted daemon.
  const dataVersionGate = ensureDataVersion(dataDir)
  const store = new Store({
    now,
    rootDir: dataDir,
  })
  // The secrets resolver for the whole daemon (issue #15): the vault
  // when configured and openable, `secret://env/...` alone otherwise, with
  // every resolved value registered against the shared redactor. `vault` is
  // the one instance also threaded into the onboarding routes below (issue
  // #19) — never opened a second time over the same file.
  const {
    vault,
    secrets,
    keyMaterial: vaultKeyMaterial,
  } = openVaultAndSecrets(store.spacesEngine.rootDir)
  // The trust layer's admin Surfaces (allowlist, audit) need a durable home
  // (issue #14): materialize the System Space before anything else so
  // it exists no matter which subsystem writes to it first.
  ensureSystemSpace(store.spacesEngine)

  // File-based memory (issues/021-advanced-memory.md, ADR-0006): the Event
  // log and FACTS are already the truth on disk; `MemoryIndex` only makes
  // the long tail of them findable. Constructed early — right after the
  // Store exists — because it depends on nothing but `SpacesEngine` and the
  // Reflection further below needs it. `openMemoryIndex` and `reconcile()`
  // below are both wrapped so a corrupt or unreadable `memory.sqlite` (a
  // crash mid-write, a stale/corrupted file restored from a backup) can
  // never take the daemon down — the files are the truth regardless of
  // whether the index works, so boot continues with fast retrieval simply
  // unavailable until the next successful reconcile, the same fail-open
  // shape as the trust layer's own boot recovery below. The index itself
  // subscribes to `spacesEngine.onMemoryWrite` in its own constructor, so
  // nothing here has to refresh it again after this point.
  const memoryConfig = loadMemoryConfig(store.spacesEngine.rootDir)
  const memoryIndex = openMemoryIndex(store.spacesEngine.rootDir, store.spacesEngine, now)
  try {
    memoryIndex.reconcile()
  } catch (error) {
    console.error('memory index boot reconciliation failed', error)
  }
  const memoryRetrieval = new MemoryRetrieval({
    index: memoryIndex,
    spacesEngine: store.spacesEngine,
    config: memoryConfig,
    now,
  })
  app.addHook('onClose', async () => {
    memoryIndex.close()
  })
  // `memoryRetrieval` feeds the chat tool registry below
  // (`chat-tool-registry.ts`'s `chatToolRegistry`): it is what offers
  // `search_memory` to a live turn.

  const auth = options.auth ?? { mode: 'dev' as const }
  // Onboarding wizard profile (issue #19; widened to a third value by issue
  // 023): `options.profile` wins when a caller sets it explicitly (the
  // Local VPS boot branch does); otherwise this mirrors the historical
  // vps/loopback derivation — a production auth store means the VPS
  // profile, everything else (dev auth, tests) is loopback.
  const profile: 'loopback' | 'local-vps' | 'vps' =
    options.profile ?? (auth.mode === 'production' ? 'vps' : 'loopback')
  if (profile !== 'loopback' && auth.mode !== 'production') {
    // Fail loudly instead of composing an incoherent server: the vps and
    // local-vps profiles require the onboarding wizard, which is meaningless
    // behind the loopback profile's unauthenticated boot.
    throw new Error(`profile "${profile}" requires production auth`)
  }
  const onboardingOptions = options.onboarding ?? {}
  // Late binding: the Gateway exists before event ingestion (which owns the
  // queue the full-text flow reads from), so the handler is assigned further
  // down, once the ingestion pipeline is constructed. Chat frames can only
  // arrive after buildServer returns, so the binding is always in place.
  let fullTextHandler: (queueId: number) => Promise<string> = () =>
    Promise.reject(new Error('full-text flow not ready'))
  const onFullTextRequest = (queueId: number) => fullTextHandler(queueId)
  // Late binding, same reasoning as `fullTextHandler`: the real chat loop
  // (`createChatLoop`, chat-loop.ts) needs the ModelRouter, the provider
  // bridge, the session store, and the full tool registry — all constructed
  // further down — so it is assigned once they all exist. Chat frames can
  // only arrive after buildServer returns, so the binding is always in place
  // by then. Unconditional: every profile routes chat through this one
  // handler, with no parallel stand-in path — a profile without a provider
  // key gets deterministic behavior through the mock routing candidate
  // (`model-routing.ts`'s `withMockFallback`), never through a second
  // handler (issue #37).
  let chatTurnHandler: (event: NormalizedChannelEvent) => void = () => {}
  const gateway = new GatewayHub(store, {
    onFullTextRequest,
    onChatTurn: (event) => chatTurnHandler(event),
    ...(auth.mode === 'production'
      ? {
          auth: {
            verifySession: (token: string | undefined) => auth.store.verifySession(token),
            onSessionRevoked: (listener: (event: { deviceId: string }) => void) =>
              auth.store.onSessionRevoked((event) => listener({ deviceId: event.deviceId })),
          },
        }
      : {}),
  })

  // Web Push notifications (issue #18): the
  // daemon's one choke point for surfacing anything to the user outside a
  // Surface's own patches. Built before the Scheduler/Heartbeat below so
  // both can wire their escalations straight into it. VAPID keys are
  // generated-or-loaded once here regardless of whether `options.pushTransport`
  // overrides the transport itself, so `GET /api/push/vapid-public-key`
  // always answers with the daemon's real key.
  const pushStore = new PushStore({ rootDir: store.spacesEngine.rootDir })
  const notificationsConfig = loadNotificationsConfig(store.spacesEngine.rootDir)
  const vapid = ensureVapidKeys(store.spacesEngine.rootDir)
  const pushTransport: PushTransport = options.pushTransport ?? new WebPushTransport({ vapid })
  const notificationCenter = new NotificationCenter({
    store,
    pushStore,
    transport: pushTransport,
    config: notificationsConfig,
    now,
    onAttention: (spaceId, count, revision) =>
      gateway.broadcastSpaceAttention(spaceId, count, revision),
    // Late-binding reference, same idiom as `heartbeat`/`heartbeatSurfaces`
    // below: `notificationSettings` is declared right after this
    // constructor call, but `onStats` is never invoked before both exist.
    onStats: () => notificationSettings.refresh(),
  })
  const notificationSettings = new NotificationSettingsSurfaceManager({
    store,
    source: notificationCenter,
    rootDir: store.spacesEngine.rootDir,
    onConfigChanged: (config) => notificationCenter.updateConfig(config),
    now,
  })
  // Device lifecycle: a revoked device's push
  // subscriptions must not keep receiving pushes. Only the production
  // profile has a real AuthStore to revoke sessions on.
  const disposePushRevocationListener =
    auth.mode === 'production'
      ? auth.store.onSessionRevoked((event) =>
          pushStore.deleteSubscriptionsByDevice(event.deviceId),
        )
      : undefined
  app.addHook('onClose', async () => {
    disposePushRevocationListener?.()
    notificationCenter.dispose()
    notificationSettings.dispose()
    pushStore.close()
  })

  // The scheduler (issue #11): timers and jobs fire as visible Automations.
  // The judgment path stays a deterministic "unknown" (fail-safe: escalate)
  // stub because the daemon has no provider client yet — chat itself still
  // answers via the mock provider. It lands with the real Agent loop wiring
  // as router.execute({ purpose: 'classification', origin: 'proactive' })
  // so the daily spending caps govern scheduler judgments too.
  // Construction only: `scheduler.start()` is deferred until after the
  // Heartbeat (issue #16) has registered its handler and reconciled its
  // Automations, further down — the scheduler must never fire a job before
  // the handler it's for exists.
  const scheduler = new Scheduler({
    rootDir: store.spacesEngine.rootDir,
    store,
    now,
    onEscalation: (spaceId, text, context) => {
      gateway.broadcastSystemNotice(text)
      // Daemon-managed handler jobs carry no Agent decision — attributing
      // an "Agent-armed" justification to them would fabricate provenance,
      // so they surface as a badge, never a push.
      if (context?.managed) {
        notificationCenter.notify({
          level: 'badge',
          spaceId,
          text,
          ...(context.origin ? { origin: context.origin } : {}),
        })
        return
      }
      // Timer escalations are always urgent: the
      // Agent's explicit act of arming the timer is the decision, and the
      // justification traces straight back to it.
      notificationCenter.notify({
        level: 'push',
        spaceId,
        text,
        urgent: true,
        justification: `Agent-armed timer reached its deadline unsatisfied: ${text}`,
        ...(context?.surfaceId ? { surfaceId: context.surfaceId } : {}),
        ...(context?.origin ? { origin: context.origin } : {}),
        ...(context?.automationId !== undefined ? { automationId: context.automationId } : {}),
      })
    },
    judge: () => 'unknown',
  })

  // The trust layer (issue #14, ADR-0007): the code-level decision
  // authority for every L1/L2 tool call — approval cards, allowlists, the
  // append-only audit log. `ApprovalSurfaceManager` is built first (its
  // `ApprovalCardPort` is a TrustLayer constructor dependency); `setTrust`
  // connects the two once the layer exists.
  const approvalSurfaces = new ApprovalSurfaceManager({ store })
  const trust = new TrustLayer({
    rootDir: store.spacesEngine.rootDir,
    approvalCardPort: approvalSurfaces,
    onApprovalCard: (card) => gateway.broadcastApprovalCard(card),
    appendOutcomeEvent: (spaceId, payload) =>
      store.spacesEngine.appendEvent(spaceId, {
        type: 'approval.outcome',
        text: `${payload.tool}: ${payload.outcome}`,
        // A tool's outcome is always daemon-produced, never a genuine user
        // event (taint.ts's `toolWriteOrigin` doc): the human decision is
        // already captured in the audit log's `approval.decided` row
        // (`approvedBy`), so this must never launder as `trusted:user` —
        // the scheduler's condition rule must not be self-satisfiable by
        // an agent/daemon write.
        origin: 'trusted:system',
        payload,
      }),
    hasOutcomeEvent: (spaceId, effectId) =>
      store.spacesEngine
        .readRecent(spaceId, 500)
        .some(
          (event) => event.type === 'approval.outcome' && event.payload?.['effectId'] === effectId,
        ),
    onSystemNotice: (text) => gateway.broadcastSystemNotice(text),
    now,
  })
  approvalSurfaces.setTrust(trust)

  // The two example outbound tools: registered with the trust layer,
  // then wrapped so every call decides allow/card/deny before any effect.
  // The mock transport records deliveries as Space events — there is no
  // real mail/bank backend (issue #15 is network egress enforcement).
  const outboundTransport = createMockOutboundTransport(store.spacesEngine)
  const outboundTools = createOutboundTools(outboundTransport)
  for (const { tool, meta } of outboundTools) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundTools.map(({ tool }) => tool))

  // Admin Surfaces: pre-created at boot, rebuilt on every trust-layer
  // change. Both live in the System Space materialized above.
  const allowlistSurfaces = new AllowlistSurfaceManager({ store, trust })
  allowlistSurfaces.start()
  const auditSurfaces = new AuditSurfaceManager({ store, trust })
  auditSurfaces.start()

  // Emergent Templates (issues/022-emergent-templates.md,
  // docs/adr/0012-emergent-templates.md): `TemplateEngine` harvests stable
  // Surfaces into Templates and backs the pin route below;
  // `TreeProposalSurfaceManager` turns a pinned Surface's Agent tree patch —
  // which `SurfaceEngine.patchTree` already refuses to apply directly,
  // returning a Tree proposal instead — into a preview Surface with
  // Accept/Reject. Both need only `store` and the server's own clock, so
  // they are constructed here, next to the trust layer's own admin
  // Surfaces just above. `treeProposals.start()`'s boot recovery (recreating
  // a missing pending proposal's card at its deterministic id) is deferred
  // into the same `trust.start()` chain below as `approvalSurfaces.start()`:
  // nothing here depends on the trust layer, but running every "recreate a
  // missing daemon-owned Surface" boot pass in the same place keeps them
  // off the critical path the routes below sit on.
  const templateEngine = new TemplateEngine({ store, now })
  const treeProposals = new TreeProposalSurfaceManager({ store })

  // Boot recovery: overdue pending rows expire, interrupted
  // `executing` rows re-run through the same effectId. Fire-and-forget,
  // same reasoning as `ingestion.recoverAtBoot()` below — nothing else
  // waits on it, and a failure here must never take the daemon down. A
  // click on a persisted card is correct the instant the store can be read
  // (`handleFastMutation` resolves against `trust.hasPendingCardSurface`,
  // never an in-memory cache), so this ordering is not a correctness
  // requirement any more — kept because `approvalSurfaces.start()` must
  // still never repair a Surface for a row `recoverAtBoot()` is about to
  // expire or mark indeterminate.
  trust
    .start()
    .then(() => approvalSurfaces.start())
    .then(() => treeProposals.start())
    .catch((error) => {
      console.error('trust layer boot recovery failed', error)
    })
  app.addHook('onClose', async () => {
    allowlistSurfaces.dispose()
    auditSurfaces.dispose()
    approvalSurfaces.dispose()
    trust.dispose()
    // `treeProposals.dispose()` first, so no new fast-path click can enqueue
    // more resolution work, then `flush()` awaited so the serialized
    // resolution chain (tree-proposal.ts) fully settles before the process
    // exits, rather than leaving a pending promise chain behind.
    treeProposals.dispose()
    await treeProposals.flush()
  })

  // Model connection migration (issue #47, docs/adr/0014-subscription-inference-boundary.md
  // amendment): a pre-Model-connections install keeps its provider keys in
  // `routing.json`'s `providerKeys` with no `connections.json` record for
  // them at all. Runs once, here, before the registry below ever reads
  // `connections.json`, so a freshly migrated connection is already on disk
  // the first time anything asks for a snapshot. Writes only
  // `connections.json` and never sets a selection, so it changes nothing
  // about how this install currently routes (`model-connection-migration.ts`'s
  // own doc comment has the full argument).
  reconcileByokConnections({
    rootDir: store.spacesEngine.rootDir,
    routing: loadRoutingConfig(store.spacesEngine.rootDir),
    secrets,
    now,
  })

  // The registry below has to be constructed before `routingState`/`router`
  // (its initial config already needs the registry's freshly migrated
  // `connections.json`) and before `bridge` (whose `probe` needs the
  // router's routing config to run a real inference call) — but the
  // registry's own options need callbacks into both. Each gets one mutable
  // slot, assigned its real behavior once both sides exist a few lines
  // below; `const` everywhere else keeps `routingState`/`router`/`bridge`
  // themselves un-reassignable. `onRoutingChangedSlot`'s default is a
  // deliberate no-op: `registry.normalizeInFlightStatesOnBoot()` immediately
  // below can call it once, harmlessly, before the real callback is wired —
  // the very next lines rebuild `routingState`/`router` from the
  // now-normalized file regardless.
  const onRoutingChangedSlot: { current: (file: ConnectionsFile) => void } = {
    current: () => {},
  }
  const probeSlot: { current: (connectionId: string, modelId: string) => Promise<void> } = {
    current: () => {
      throw new Error('the provider bridge is not ready yet; this is a daemon boot-order bug')
    },
  }

  // The Model connection migration (issue #47, docs/adr/0014-subscription-inference-boundary.md
  // amendment): a pre-Model-connections install keeps its provider keys in
  // `routing.json`'s `providerKeys` with no `connections.json` record for
  // them at all. Runs once, here, before the registry below ever reads
  // `connections.json`, so a freshly migrated connection is already on disk
  // the first time anything asks for a snapshot. Writes only
  // `connections.json` and never sets a selection, so it changes nothing
  // about how this install currently routes (`model-connection-migration.ts`'s
  // own doc comment has the full argument).
  reconcileByokConnections({
    rootDir: store.spacesEngine.rootDir,
    routing: loadRoutingConfig(store.spacesEngine.rootDir),
    secrets,
    now,
  })

  // The Model connection registry (issue #47): owns `connections.json`,
  // adapter dispatch, and every routing rebuild that follows a connection
  // state change. `isRoutableModel: isBuiltinModel` (M5) marks a catalog
  // entry this build cannot actually route to as disabled rather than
  // letting it fail mid-turn.
  const registry = new ModelConnectionRegistry({
    rootDir: store.spacesEngine.rootDir,
    adapters: [...BYOK_ADAPTERS, claudeSubscriptionAdapter],
    vault,
    secrets,
    profile,
    fetchImpl: fetch,
    now,
    probe: (connectionId, modelId) => probeSlot.current(connectionId, modelId),
    isRoutableModel: isBuiltinModel,
    onRoutingChanged: (file) => onRoutingChangedSlot.current(file),
    env: process.env,
  })
  registry.normalizeInFlightStatesOnBoot()

  // Model routing (issue #10, widened by issue #47's Model connections):
  // per-tier config derived from `connections.json` over `<dataDir>/routing.json`'s
  // legacy fallback chain, spend persisted under `<dataDir>/usage/`. Past a
  // daily cap the router shuts proactivity off; the user hears about it in
  // chat. Live spend recording (turn-end costUsd -> recordSpend) is the chat
  // loop's own job (chat-loop.ts's `runTurn`), constructed below.
  const routingState = new RoutingState(
    withMockFallback(
      deriveRoutingConfig(
        loadRoutingConfig(store.spacesEngine.rootDir),
        loadConnectionsConfig(store.spacesEngine.rootDir),
      ),
      secrets,
      { profile, mockEnabled: loadConnectionsConfig(store.spacesEngine.rootDir).mockEnabled },
    ),
  )
  const router = new ModelRouter({
    rootDir: store.spacesEngine.rootDir,
    config: routingState.current(),
    secrets,
    onCallError: (model, error) => {
      // A migrated legacy connection's id IS its provider name, so an
      // unbound legacy `ModelRef` (no `connectionId`) still maps onto the
      // right record here — a BYOK 401/403 marks it `failed` and the next
      // routing rebuild drops it (issue #47).
      void registry.noteCallFailure(model.connectionId ?? model.provider, error)
    },
    onEvent: (event) => {
      if (event.type === 'spending.cap-exceeded') {
        gateway.broadcastSystemNotice(
          `Daily ${event.tier} spending cap reached ($${event.spentUsd.toFixed(2)} of ` +
            `$${event.capUsd.toFixed(2)}). Proactivity is paused until tomorrow; chat stays available.`,
        )
        return
      }
      if (event.type === 'model.failover') {
        gateway.broadcastSystemNotice(
          `Switched to ${connectionLabel(store.spacesEngine.rootDir, event.to)} after: ${event.reason}`,
        )
      }
    },
  })
  onRoutingChangedSlot.current = (file) => {
    const derived = withMockFallback(
      deriveRoutingConfig(loadRoutingConfig(store.spacesEngine.rootDir), file),
      secrets,
      { profile, mockEnabled: file.mockEnabled },
    )
    routingState.replace(derived)
    router.setConfig(derived)
  }

  // The provider bridge (issue #37, ADR-0004 amendment; widened by issue
  // #47): maps a routed `ModelRef` plus its resolved key onto pi-ai's
  // provider clients for every real turn, and onto the deterministic mock
  // model (`createMockChatResponder`) for the keyless routing candidate
  // `withMockFallback` appends above — the same loopback behavior the
  // pre-issue-37 chat stand-ins produced, now returned as tool calls the
  // gated registry below actually executes. `config`/`connections` are
  // getters, not snapshots, so the registry's live routing rebuilds are
  // visible to the very next call.
  const bridge = createProviderBridge({
    config: () => routingState.current(),
    connections: () => registry.runtimes(),
    secrets,
    mockResponder: createMockChatResponder({ store, now }),
  })
  // Issue #47's verify-then-commit selection flow and every adapter's
  // `verify` (`ctx.probe`, `model-connection-adapter.ts`)
  // share this ONE probe implementation. It deliberately does NOT reuse the
  // live `bridge` above: `bridge`'s config getter reads `routingState.current()`,
  // whose `connectionKeys` only ever contains the connection that is
  // ALREADY the active selection or an enabled fallback — a freshly created
  // or not-yet-selected connection has no entry there yet, so probing
  // through the live bridge would fail to resolve a key for exactly the
  // connection a caller is trying to verify. Instead, this derives a
  // throwaway candidate config as though `connectionId` WERE the selection
  // for `modelId` (regardless of what is actually stored) — that always
  // gives the target connection a `connectionKeys` entry — and builds a
  // one-off bridge over it. Nothing here touches `routingState`/`router`;
  // the caller (the registry's mutation queue, or the `/selection` route)
  // decides separately whether the probe's success gets committed.
  probeSlot.current = (connectionId, modelId) => {
    const file = loadConnectionsConfig(store.spacesEngine.rootDir)
    const record = file.connections.find((candidate) => candidate.id === connectionId)
    if (!record) throw new Error(`no such Model connection: ${connectionId}`)
    const candidateConfig = withMockFallback(
      deriveRoutingConfig(loadRoutingConfig(store.spacesEngine.rootDir), {
        ...file,
        selection: { connectionId, modelId },
      }),
      secrets,
      { profile, mockEnabled: file.mockEnabled },
    )
    const probeBridge = createProviderBridge({
      config: candidateConfig,
      connections: () => registry.runtimes(),
      secrets,
      mockResponder: createMockChatResponder({ store, now }),
    })
    return probeModel(probeBridge, {
      provider: record.provider,
      modelId,
      tier: 'reasoning',
      connectionId,
    })
  }
  // One JSONL session per Space plus one for the global chat (chat-loop.ts's
  // `sessionIdFor`), persisted under `<rootDir>/sessions` — `backup.ts` already
  // lists `sessions` among the plain-file-tree entries a backup copies
  // alongside the `*.sqlite` stores.
  const chatSessionStore = new PiJsonlSessionStore({
    cwd: store.spacesEngine.rootDir,
    sessionsRoot: join(store.spacesEngine.rootDir, 'sessions'),
  })

  // The Heartbeat (issue #16, ADR-0005): the daemon's own proactivity loop,
  // twice a day by default. It needs the ModelRouter above (triage/reasoning
  // calls go through the same daily spending caps as everything else) and
  // must register its handler and reconcile its Automations before
  // `scheduler.start()` fires anything.
  const heartbeatConfig = loadHeartbeatConfig(store.spacesEngine.rootDir)
  const heartbeat = new Heartbeat({
    store,
    scheduler,
    router,
    config: heartbeatConfig,
    now,
    // Dev stub, same rationale as the scheduler.judge stub and the mock
    // quarantined reader: the real Agent-loop wiring replaces this with a
    // live triage/reasoning completion.
    complete: () => Promise.resolve({ text: '{"status":"nothing"}' }),
    onEscalation: (spaceId, text, context) => {
      gateway.broadcastSystemNotice(text)
      // Heartbeat escalations are never urgent. The
      // triage model's own justification is the only acceptable one — the
      // daemon never fabricates a substitute. Should an escalation arrive
      // without one (schema-invalid fixtures, older data), it degrades to
      // a badge rather than pushing on fabricated provenance.
      const justification = context?.justification
      if (justification === undefined) {
        notificationCenter.notify({
          level: 'badge',
          spaceId,
          text,
          ...(context?.origin ? { origin: context.origin } : {}),
        })
        return
      }
      notificationCenter.notify({
        level: 'push',
        spaceId,
        text,
        justification,
        ...(context?.surfaceId ? { surfaceId: context.surfaceId } : {}),
        ...(context?.origin ? { origin: context.origin } : {}),
      })
    },
    onSwept: () => heartbeatSurfaces.refresh(),
  })
  const heartbeatSurfaces = new HeartbeatSurfaceManager({ store, heartbeat })
  heartbeat.register()
  heartbeat.reconcileJobs()
  heartbeatSurfaces.start()

  // The nightly Reflection (issues/021-advanced-memory.md,
  // docs/adr/0006-file-based-memory.md): "sleep-time compute" over the
  // MemoryIndex/config constructed near the top of this function. Mirrors
  // the Heartbeat immediately above in every way that matters for boot
  // ordering: `register()` and `reconcileJobs()` both run before
  // `scheduler.start()` below, so the Scheduler can never fire this
  // Automation before its handler exists, and a second `buildServer()` call
  // over the same data dir converges on the same one job instead of
  // creating a duplicate.
  const reflection = new Reflection({
    store,
    scheduler,
    index: memoryIndex,
    config: memoryConfig,
    // Dev stand-in, same rationale as the Heartbeat's own `complete` stub
    // above and the mock quarantined reader: no real Agent loop or
    // provider key is wired yet. Replaced outright once the Agent loop
    // lands.
    distiller: createMockReflectionDistiller(),
    now,
    // Same shape as the Heartbeat's `onSwept` above, and the same forward
    // reference to a manager declared just below: the callback body only runs
    // once a Reflection occurrence fires, long after both are constructed.
    // Without it the report Surface would keep serving whatever was true at
    // boot — the Reflection runs overnight, so on a daemon that stays up the
    // browsable report would never change.
    onReflected: (spaceId) => reflectionSurfaces.refresh(spaceId),
  })
  const reflectionSurfaces = new ReflectionSurfaceManager({
    store,
    reflection,
    low: memoryConfig.budget.low,
    now,
  })
  reflection.register()
  reflection.reconcileJobs()
  reflectionSurfaces.start()

  // The version this daemon reports and reasons about, resolved once so those
  // can never disagree: `/api/health` publishes it and the self-update feed
  // check compares against it. See `resolveInstalledVersion` (version.ts) for
  // why a stamped release always wins and an unstamped checkout becomes
  // `0.0.0`.
  const installedVersion = resolveInstalledVersion()

  // Signed self-update (issue #43, docs/adr/0013-signed-self-update.md):
  // wired only when both `VEDUTA_UPDATE_HOME` and `VEDUTA_UPDATE_PINNING`
  // are set AND the pinning file parses (`UpdatePiningSchema` — root-owned
  // trust anchors, `/etc/veduta/update.json` on a real install). Any other
  // profile (loopback dev, the test suite, a VPS/Local VPS instance that
  // hasn't opted in) gets zero behavior change: no `UpdateManager`, no
  // Update Surface, no daily "Check for updates" Automation. Registered and
  // started before `scheduler.start()`, the same ordering rule as the
  // Heartbeat/Reflection above.
  const updateHomeEnv = process.env['VEDUTA_UPDATE_HOME']
  const updatePinningEnv = process.env['VEDUTA_UPDATE_PINNING']
  let updateManager: UpdateManager | undefined
  let updateFeedHost: string | undefined
  if (updateHomeEnv && updatePinningEnv) {
    try {
      const pinning = UpdatePinningSchema.parse(JSON.parse(readFileSync(updatePinningEnv, 'utf8')))
      updateFeedHost = new URL(pinning.feedUrl).hostname
      updateManager = new UpdateManager({
        store,
        scheduler,
        notifications: notificationCenter,
        config: {
          updateHome: updateHomeEnv,
          pinningPath: updatePinningEnv,
          dataRootDir: store.spacesEngine.rootDir,
          // A dedicated exit code (75), distinct from the onboarding
          // wizard's own plain restart (`defaultScheduleExit`'s default
          // `0`) — the supervisor wrapper (`deploy/veduta-run`, a later
          // task) tells the two apart by exit code alone.
          scheduleExit: defaultScheduleExit(app, UPDATE_REQUESTED_EXIT_CODE),
          now,
          installedVersion,
        },
      })
      updateManager.register()
      updateManager.start()
    } catch (error) {
      // A present-but-unparseable pinning file is a misconfiguration, not a
      // boot-blocking failure: self-update stays unwired, exactly as if the
      // env vars were absent, and the reason is logged for the operator.
      console.error(
        `self-update: ${updatePinningEnv} does not parse as UpdatePinningSchema; self-update is not wired`,
        error,
      )
      updateManager = undefined
      updateFeedHost = undefined
    }
  }

  notificationSettings.start()
  notificationCenter.start()
  scheduler.start()
  app.addHook('onClose', async () => {
    scheduler.stop()
    heartbeatSurfaces.dispose()
    reflectionSurfaces.dispose()
    updateManager?.dispose()
  })

  // Background Workers (issue #17, ADR-0002, ARCHITECTURE §3.6): ephemeral
  // investigate-and-report steps, run in an isolated session under a
  // token/iteration budget, with a separate adversarial review before
  // delivery for high-risk briefings. `runnerFactory`/`reviewComplete` are
  // dev stand-ins, same rationale as the mock quarantined reader/Heartbeat
  // completion above — no provider key, deterministic, replaced outright by
  // the real `PiAgentRunner` factory once the Agent loop lands. `workerTools`
  // is empty in the dev profile: an L0-only registry (asserted in the
  // constructor) that the scripted runner never dispatches against; the
  // real Agent loop grows this alongside whatever L0 tools it offers.
  const workerPool = new WorkerPool({
    store,
    router,
    now,
    runnerFactory: () => createMockWorkerRunner(),
    // A dev stand-in with a small stateful fixture (mock-worker-runner.ts):
    // passes every review by default, except a goal containing the word
    // "unsupported" first rejects (with a caveat), then passes on the
    // corrective retry — enough to exercise acceptance C's reject → correct
    // flow via `pnpm dev` with no provider key. Replaced outright by the
    // real reviewer completion once the Agent loop lands.
    reviewComplete: createMockWorkerReviewComplete(),
    workerTools: [],
  })
  workerPool.recoverAtBoot()
  app.addHook('onClose', async () => {
    workerPool.dispose()
  })

  // `spawn_worker` (issue #17, issue #37): the Agent's own entry point for
  // starting a Worker, offered to every Space chat turn by
  // `chatToolRegistry` below.
  const spawnWorkerTool = createSpawnWorkerTool(workerPool)

  // The chat tool registry (issue #37, exact set per `chat-tool-registry.ts`'s
  // doc comment): built through the shared builder so this daemon's real
  // registry and `tool-parameters.test.ts`'s registry-shape assertions can
  // never drift apart.
  const chatToolRegistry = buildChatToolRegistry({
    store,
    wrappedOutboundTools,
    memoryRetrieval,
    templateEngine,
    scheduler,
    spawnWorkerTool,
  })

  // The real chat loop (issue #37): every chat entry point — the global
  // chat and every Space — routes through here, which threads the turn
  // through `ModelRouter.execute` (so BYOK failover, daily caps, and call
  // logging apply exactly as they do to every other model call), streams
  // the reply back frame by frame (`chat.turn-start`/`-delta`/`-end`/
  // `-error`), and appends the turn to the Space's Event log (ADR-0003).
  // Bound onto `chatTurnHandler` unconditionally: a profile with no
  // provider key still gets deterministic loopback behavior, through the
  // mock routing candidate this same loop calls into — never a second,
  // parallel handler.
  const chatLoop = createChatLoop({
    store,
    router,
    sessionStore: chatSessionStore,
    bridge,
    isTrustWrapped,
    toolsFor: chatToolRegistry,
    send: (clientId, frame) => gateway.sendToClient(clientId, frame),
  })
  chatTurnHandler = (event) => {
    void chatLoop.handleChatMessage(event)
  }
  // Graceful shutdown (issue #37 fix): every `onClose` hook above this one
  // (memory index, push store, trust layer/Tree proposals, scheduler/
  // Heartbeat/Reflection, WorkerPool) was registered earlier in this
  // function, and Fastify runs `onClose` hooks in reverse registration
  // order — so this one runs FIRST, before any of those start tearing down.
  // A live chat turn's tools reach every one of them (the scheduler's own
  // tools, `spawn_worker` against the WorkerPool, the trust-wrapped outbound
  // tools, `search_memory` against the memory index), so `chatLoop.stop()`
  // must finish — every runner aborted, every session's serialization chain
  // settled — before any of their own shutdown can safely start.
  app.addHook('onClose', async () => {
    await chatLoop.stop()
  })

  const pwaDistDir = options.pwaDistDir ?? defaultPwaDistDir
  const lockout = new ProgressiveAuthLockout()

  // Event ingestion (issue #12): the outside world becomes verified,
  // deduped, pre-filtered events with zero LLM calls. Survivors hand off
  // to the quarantined reader (issue #13) via `onAccepted`.
  const ingestionConfig = loadIngestionConfig(store.spacesEngine.rootDir)
  const watchManager = new WatchManager({
    rootDir: store.spacesEngine.rootDir,
    now,
    onAlert: (sourceName, message) => {
      gateway.broadcastSystemNotice(message)
      const spaceId = ingestionConfig.sources[sourceName]?.spaceId
      if (spaceId && store.getSpace(spaceId)) {
        store.spacesEngine.appendEvent(spaceId, {
          type: 'ingestion.watch-alert',
          text: message,
          origin: 'trusted:system',
          payload: { source: sourceName },
          at: now().toISOString(),
        })
      }
    },
  })
  const fetchStages: Record<string, FetchStage> = {}
  const gmailSources: Record<string, GmailSource> = {}
  const registerWatches: (() => void)[] = []
  for (const [sourceName, source] of Object.entries(ingestionConfig.sources)) {
    const { google, gmail, calendar } = source
    if (!google) continue
    const tokens = new GoogleTokenProvider({ ...google, secrets, now })
    if (source.adapter === 'gmail-push' && gmail) {
      const gmailSource = new GmailSource({ source: sourceName, tokens })
      gmailSources[sourceName] = gmailSource
      fetchStages[sourceName] = (cursor) => gmailSource.fetchNewMessages(cursor)
      registerWatches.push(() =>
        watchManager.register(sourceName, 'gmail', {
          renew: async () => {
            const renewal = await gmailSource.renewWatch(gmail.topicName)
            // First arm only: the watch's historyId catches messages that
            // arrive before the first push; later renewals must not move
            // an established cursor forward past unfetched history.
            if (ingestion.queue.cursor(sourceName) === undefined) {
              ingestion.queue.setCursor(sourceName, renewal.historyId)
            }
            return { expiresAt: renewal.expiresAt }
          },
        }),
      )
    }
    if (source.adapter === 'calendar-push' && calendar) {
      const calendarSource = new CalendarSource({ source: sourceName, tokens, now })
      fetchStages[sourceName] = (cursor) =>
        calendarSource.fetchChangedEvents(calendar.calendarId, cursor)
      registerWatches.push(() =>
        watchManager.register(sourceName, 'calendar', {
          renew: async (registration) => {
            const channelToken = secrets.resolve(source.secret)
            if (channelToken === undefined) {
              throw new Error(`channel token secret for source "${sourceName}" does not resolve`)
            }
            const renewal = await calendarSource.renewWatch({
              calendarId: calendar.calendarId,
              address: calendar.address,
              channelToken,
            })
            if (ingestion.queue.cursor(sourceName) === undefined) {
              ingestion.queue.setCursor(sourceName, now().toISOString())
            }
            // Best-effort: a stale channel is acknowledged-and-dropped by
            // the pipeline anyway, but stopping it saves the noise.
            if (registration.channelId && registration.resourceId) {
              await calendarSource
                .stopChannel(registration.channelId, registration.resourceId)
                .catch(() => {})
            }
            return renewal
          },
        }),
      )
    }
  }
  // The quarantined reader (issue #13, SECURITY.md §3.1): accepted events
  // become schema-validated, taint-marked structured fields — never raw
  // text — before anything reaches the Agent's context. The deterministic
  // mock completion stands in until the real provider client lands with
  // the Agent loop, same as chat.
  const fetchBody = (event: ExternalEvent) =>
    event.fetchRef?.provider === 'gmail'
      ? (gmailSources[event.source]?.fetchMessageBody(event.fetchRef.id) ??
        Promise.resolve(undefined))
      : Promise.resolve(undefined)
  const reader = new QuarantinedReader({
    router,
    complete: mockReaderComplete,
    store,
    now,
    fetchBody,
    onNotice: (text) => gateway.broadcastSystemNotice(text),
  })
  const ingestion = new EventIngestion({
    rootDir: store.spacesEngine.rootDir,
    config: ingestionConfig,
    store,
    now,
    onNotice: (text) => gateway.broadcastSystemNotice(text),
    fetchStages,
    onAccepted: (handoff) => reader.read(handoff),
    expectedChannelId: (sourceName) =>
      watchManager.registrations().find((registration) => registration.source === sourceName)
        ?.channelId,
  })
  // The "read me the full text" flow (SECURITY.md §3.3): a dedicated turn,
  // delimited and marked untrusted, gated to L0 tools by the runner itself.
  // The real Agent loop swaps the MockAgentRunner instance, nothing else.
  const fullTextRunner = new MockAgentRunner()
  const fullTextRunnerReady = fullTextRunner.start('full-text')
  // Requests are serialized: `promptFullText` resolves on the runner's next
  // `turn-end`, so two concurrent turns on the shared runner would
  // cross-wire replies. The chain keeps one turn in flight at a time.
  let fullTextChain: Promise<unknown> = fullTextRunnerReady
  fullTextHandler = (queueId) => {
    const next = fullTextChain
      .catch(() => {})
      .then(() => promptFullText(fullTextRunner, ingestion.queue, fetchBody, queueId))
    fullTextChain = next
    return next
  }
  // Boot redelivery is background work: `deliver` never throws, and its
  // ordering with watch registration below is immaterial (it only touches
  // already-accepted rows from a prior run). Queue/DB errors in the
  // re-decide loop must not become an unhandled rejection at boot.
  ingestion.recoverAtBoot().catch((error) => {
    console.error('ingestion boot recovery failed', error)
  })
  for (const register of registerWatches) register()
  watchManager.start()
  app.addHook('onClose', async () => watchManager.stop())

  // Dev profile: only the Vite dev server may call the daemon from a browser.
  void app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  })
  void app.register(websocket)

  app.addHook('onRequest', async (request, reply) => {
    if (auth.mode !== 'production') return
    reply.header('strict-transport-security', hstsHeader(auth.hstsMaxAgeSeconds))
    if (isPublicUnauthenticatedPath(request.url)) return
    if (auth.store.verifySession(extractBearer(request.headers.authorization))) return
    return reply.status(401).send({ error: 'passkey session required' })
  })

  app.get('/api/health', () => ({
    ok: true,
    version: installedVersion,
    dataVersion: dataVersionGate.dataVersion,
  }))

  app.get('/api/auth/status', () => {
    return AuthStatusSchema.parse(
      auth.mode === 'production'
        ? auth.store.status()
        : { mode: 'dev', passkeyRegistered: false, bootstrapRequired: false },
    )
  })

  app.post('/api/auth/register/options', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = RegistrationOptionsBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      const envelope = await auth.store.startPasskeyRegistration(parsed.data)
      return WebAuthnOptionsEnvelopeSchema.parse(envelope)
    })
  })

  app.post('/api/auth/register/verify', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = RegistrationVerifyBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      const session = await auth.store.finishPasskeyRegistration(parsed.data)
      return AuthSessionSchema.parse(session)
    })
  })

  app.post('/api/auth/login/options', async (_request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    const envelope = await auth.store.startPasskeyLogin()
    return WebAuthnOptionsEnvelopeSchema.parse(envelope)
  })

  app.post('/api/auth/login/verify', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = LoginVerifyBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      const login = {
        ceremonyId: parsed.data.ceremonyId,
        response: parsed.data.response,
      }
      const session = await auth.store.finishPasskeyLogin(
        parsed.data.deviceName === undefined
          ? login
          : { ...login, deviceName: parsed.data.deviceName },
      )
      return AuthSessionSchema.parse(session)
    })
  })

  app.get('/api/auth/devices', (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    const token = extractBearer(request.headers.authorization)
    if (!token) return reply.status(401).send({ error: 'passkey session required' })
    return { devices: auth.store.listDevices(token) }
  })

  app.post('/api/auth/pairing-codes', (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    const token = extractBearer(request.headers.authorization)
    if (!token) return reply.status(401).send({ error: 'passkey session required' })
    return PairingCodeSchema.parse(auth.store.createPairingCode(token))
  })

  app.post('/api/auth/devices/:deviceId/revoke', (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    const token = extractBearer(request.headers.authorization)
    if (!token) return reply.status(401).send({ error: 'passkey session required' })
    const { deviceId } = request.params as { deviceId: string }
    auth.store.revokeDevice(token, deviceId)
    return reply.status(204).send()
  })

  app.get('/', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))

  app.get('/app/*', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))

  // The onboarding wizard's pairing landing page (issue #19):
  // served as the SPA, same as `/app/*`, and public (below) so the printed
  // first-boot/pairing URL (`<origin>/setup?code=...`) works before any
  // session exists.
  app.get('/setup', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))

  app.get('/manifest.webmanifest', (_request, reply) =>
    sendPwaAsset(reply, pwaDistDir, 'manifest.webmanifest'),
  )

  app.get('/service-worker.js', (_request, reply) =>
    sendPwaAsset(reply, pwaDistDir, 'service-worker.js'),
  )

  app.get('/assets/*', (request, reply) => {
    const asset = (request.params as { '*': string })['*']
    return sendPwaAsset(reply, pwaDistDir, `assets/${asset}`)
  })

  app.get('/icons/*', (request, reply) => {
    const asset = (request.params as { '*': string })['*']
    return sendPwaAsset(reply, pwaDistDir, `icons/${asset}`)
  })

  app.get('/api/spaces', (request) => {
    const rawSnapshot = appendSystemSurface(
      store.snapshot(),
      usageSurface(router.usage(), new Date().toISOString()),
    )
    // Attention (issue #18): PushStore is the source of
    // truth (0/0 default for a Space `notify()` has never touched).
    const snapshot = {
      ...rawSnapshot,
      spaces: rawSnapshot.spaces.map((space) => {
        const attention = pushStore.getAttention(space.id)
        return { ...space, attention: attention.count, attentionRevision: attention.revision }
      }),
    }
    if (auth.mode !== 'production') return snapshot
    const token = extractBearer(request.headers.authorization)
    return token ? appendConnectedDevicesSurface(snapshot, auth.store.listDevices(token)) : snapshot
  })

  app.get('/api/spaces/:spaceId/events', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    return { events: store.eventLog(spaceId) }
  })

  // Web Push routes (issue #18): auth-gated by the same `onRequest` hook as
  // every other `/api/*` route above — deliberately NOT added to
  // `isPublicUnauthenticatedPath`, so a production deployment requires a
  // passkey session for all four.
  app.get('/api/push/vapid-public-key', () => ({ publicKey: vapid.publicKey }))

  app.post('/api/push/subscriptions', (request, reply) => {
    const parsed = PushSubscriptionSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (!isAllowedPushEndpoint(parsed.data.endpoint)) {
      return reply
        .status(422)
        .send({ error: 'push subscription endpoint host is not on the allowed push-service list' })
    }
    // Upsert by endpoint replaces any previous device binding: one
    // subscription per endpoint, a device may hold several
    // (one per browser/profile). Dev profile (no auth): deviceId stays NULL.
    const deviceId =
      auth.mode === 'production'
        ? auth.store.verifySession(extractBearer(request.headers.authorization))?.device.id
        : undefined
    pushStore.upsertSubscription({
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      ...(deviceId === undefined ? {} : { deviceId }),
    })
    return reply.status(204).send()
  })

  app.delete('/api/push/subscriptions', (request, reply) => {
    const parsed = PushSubscriptionDeleteBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (auth.mode === 'production') {
      const deviceId = auth.store.verifySession(extractBearer(request.headers.authorization))
        ?.device.id
      const subscription = pushStore
        .listSubscriptions()
        .find((candidate) => candidate.endpoint === parsed.data.endpoint)
      // A subscription bound to a different (or no) device may not be
      // deleted by this caller; an already-gone subscription is a no-op.
      if (subscription && subscription.deviceId !== deviceId) {
        return reply.status(403).send({ error: 'subscription does not belong to this device' })
      }
    }
    // Dev profile (no auth): unscoped delete by endpoint, documented.
    pushStore.deleteSubscription(parsed.data.endpoint)
    return reply.status(204).send()
  })

  app.post('/api/spaces/:spaceId/attention/seen', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    // `markSeen` is the no-silent-mutations gate (AGENTS.md): it appends a
    // `notification.seen` Space event, and broadcasts via `onAttention`
    // (wired to `gateway.broadcastSpaceAttention` above), only when the
    // count actually changes. A zero-to-zero clear returns the unchanged
    // current value instead.
    const result = notificationCenter.markSeen(spaceId) ?? pushStore.getAttention(spaceId)
    return { count: result.count, revision: result.revision }
  })

  // Onboarding wizard routes (issue #19): registered directly on `app`,
  // same as every route above, so the production `onRequest` auth hook
  // already installed covers them too — nothing here is added to
  // `isPublicUnauthenticatedPath` (only `/setup`, above, is).
  registerOnboardingRoutes(app, {
    rootDir: store.spacesEngine.rootDir,
    profile,
    domain: onboardingOptions.domain ?? null,
    tlsActive: onboardingOptions.tlsActive ?? false,
    vault,
    vaultKeyMaterial,
    spacesEngine: store.spacesEngine,
    env: onboardingOptions.env ?? process.env,
    scheduleExit: onboardingOptions.scheduleExit ?? defaultScheduleExit(app),
    secrets,
    // Issue #47: an imported provider key becomes a visible, usable Model
    // connection before the migration import route's response goes out,
    // with no daemon restart required.
    connections: { reconcileImportedByokKeys: (names) => registry.reconcileImportedKeys(names) },
  })

  // Model connections routes (issue #47): registered directly on `app`,
  // same as `registerOnboardingRoutes` above, so the production `onRequest`
  // auth hook already installed covers them too — nothing here is added to
  // `isPublicUnauthenticatedPath`. `probe` is the exact same closure the
  // registry itself calls through `AdapterContext.probe` (`probeSlot.current`
  // above) — one probe implementation, used both for a single connection's
  // `verify` and for `/selection`'s verify-then-commit flow.
  registerModelConnectionRoutes(app, {
    registry,
    profile,
    probe: (connectionId, modelId) => probeSlot.current(connectionId, modelId),
  })

  app.post('/api/surfaces/:surfaceId/actions', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = SurfaceActionBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues })
    }
    try {
      // The mutation's own commit already reached every connected client
      // through the Gateway's central Surface-event subscription; this
      // endpoint only reports the result to the caller.
      const result = store.invokeSurfaceAction(surfaceId, parsed.data)
      if (result.path === 'agent') return reply.status(202).send({ turn: result.turn })
      return { surface: result.mutation.surface }
    } catch (error) {
      if (error instanceof SurfaceActionError) {
        return reply.status(statusForSurfaceActionError(error)).send({ error: error.message })
      }
      throw error
    }
  })

  // `POST /api/surfaces/:surfaceId/pin` (issues/022-emergent-templates.md):
  // auth-gated exactly like the `/actions` route above (the shared
  // `onRequest` hook covers every `/api/*` route not listed in
  // `isPublicUnauthenticatedPath`). Pinning goes through
  // `TemplateEngine.pin`, not `store.setPinned` directly, so a pin also
  // captures the Surface as a Template. Existence is checked before the pin
  // is attempted so an unknown Surface (404) and a daemon-owned one refusing
  // the pin (`SurfaceNotPinnableError`, 409) are never conflated —
  // `SurfaceEngine.setPinned` raises that same error for both cases.
  // `{ origin: 'trusted:user', updatedBy: 'user' }` is hardcoded, not derived
  // from taint: reaching this route at all means an authenticated human
  // session made the request (the shared auth hook above), so this is a
  // genuine human act, exactly what `pin_surface` (the L0 Agent tool,
  // `template-engine.ts`) is barred from asserting for itself — that tool
  // derives its own write origin from the turn's live taint instead, and its
  // schema only ever allows `pinned: true`.
  app.post('/api/surfaces/:surfaceId/pin', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = PinSurfaceBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues })
    }
    if (!store.getSurface(surfaceId)) {
      return reply.status(404).send({ error: `unknown Surface: ${surfaceId}` })
    }
    try {
      // The pin itself already reached every connected client through the
      // Gateway's central Surface-event subscription (the `surface.pinned`
      // message mapped from `kind: 'pinned'`, gateway.ts) — this endpoint
      // only reports the result to the caller, the same shape as
      // `/actions` above.
      const { surface } = templateEngine.pin(surfaceId, parsed.data.pinned, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      return { surface }
    } catch (error) {
      if (error instanceof SurfaceNotPinnableError) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })

  // Ingestion lives in its own scope: signatures verify the exact raw
  // bytes, so body parsing is raw-buffer here and JSON everywhere else.
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body)
    })
    instance.post(
      '/api/ingest/:source',
      // External senders are untrusted: cap the body well below anything
      // a legitimate push notification needs.
      { bodyLimit: 256 * 1024 },
      async (request, reply) => {
        const { source } = request.params as { source: string }
        // Unknown source names are attacker-chosen: collapse them into one
        // lockout bucket per ip so a flood cannot grow the lockout map.
        const key = `ingest:${request.ip}:${source in ingestion.sources() ? source : 'unknown'}`
        const check = lockout.check(key)
        if (!check.allowed) {
          return reply
            .header('retry-after', String(check.retryAfterSeconds))
            .status(429)
            .send({ error: 'ingestion endpoint temporarily locked' })
        }
        const response = await ingestion.handleWebhook(source, {
          rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          headers: request.headers,
          query: request.query as Record<string, unknown>,
        })
        if (response.status === 401) lockout.recordFailure(key)
        else lockout.recordSuccess(key)
        if (response.retryAfterSeconds !== undefined) {
          reply.header('retry-after', String(response.retryAfterSeconds))
        }
        return reply.status(response.status).send(response.body)
      },
    )
  })

  void app.register(async (instance) => {
    instance.get('/ws/gateway', { websocket: true }, (socket, request) => {
      if (
        auth.mode === 'production' &&
        !isAllowedOrigin(request.headers.origin, auth.allowedOrigins)
      ) {
        socket.close()
        return
      }
      gateway.connect(socket)
    })
  })

  // Egress allowlist (issue #15, docs/SECURITY.md §3.4): assembled from
  // what this daemon is actually configured to reach — the configured LLM
  // providers, Google's hosts when ingestion has a Google source, every
  // registered outbound tool's declared `egressDomains`, and any
  // operator-supplied extra hosts. Denials are logged (redacted) to a
  // durable JSONL file and to console regardless of profile; only the
  // production/VPS and Local VPS profiles turn on enforcement
  // (`options.egress?.enforce`, set by `index.ts`) — the loopback (mock)
  // profile and the test suite must never inherit a global denying
  // dispatcher by default.
  // The update feed host (issue #43) joins the allowlist the same way any
  // other tool's declared domains do, only when self-update is actually
  // wired above — an unconfigured daemon never gains a new allowed host.
  const extraAllowHosts = [
    ...(options.egress?.extraAllow ?? []),
    ...(updateFeedHost ? [updateFeedHost] : []),
  ]
  const egress = assembleEgressPolicy({
    rootDir: store.spacesEngine.rootDir,
    // Maps every `providerKeys`/`connectionKeys` entry back onto its
    // canonical provider (issue #47): a migrated connection's id already IS
    // the provider name, a new connection's id is a uuid only
    // `connections.json` can resolve.
    providers: egressProvidersFor(
      routingState.current(),
      loadConnectionsConfig(store.spacesEngine.rootDir),
    ),
    ...(Object.values(ingestionConfig.sources).some((source) => Boolean(source.google))
      ? { googleHosts: ['oauth2.googleapis.com', 'www.googleapis.com'] }
      : {}),
    toolDomains: outboundTools.flatMap(({ tool }) => tool.egressDomains),
    ...(extraAllowHosts.length > 0 ? { extraAllow: extraAllowHosts } : {}),
    // The loopback (mock) profile and the test suite talk to loopback
    // constantly; the VPS and Local VPS profiles must not trust it specially.
    allowLoopback: auth.mode !== 'production',
  })
  egress.onDenial((denial) => {
    const line = defaultRedactor.redactText(JSON.stringify(denial))
    appendFileSync(join(store.spacesEngine.rootDir, 'egress-denials.jsonl'), `${line}\n`)
    console.error('egress denied', denial.host)
  })
  if (options.egress?.enforce === true) installEgressEnforcement(egress)

  return {
    app,
    store,
    gateway,
    router,
    connections: registry,
    scheduler,
    ingestion,
    watchManager,
    trust,
    approvalSurfaces,
    allowlistSurfaces,
    auditSurfaces,
    workerPool,
    egress,
    pushStore,
    notificationCenter,
    notificationSettings,
    memoryIndex,
    memoryRetrieval,
    reflection,
    reflectionSurfaces,
  }
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  return Boolean(origin && allowedOrigins.includes(origin))
}

function hstsHeader(maxAgeSeconds = 31_536_000): string {
  return `max-age=${maxAgeSeconds}; includeSubDomains`
}

function isPublicUnauthenticatedPath(url: string): boolean {
  const path = url.split('?')[0] ?? url
  return (
    path === '/' ||
    path === '/setup' ||
    path.startsWith('/app/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/icons/') ||
    path === '/manifest.webmanifest' ||
    path === '/service-worker.js' ||
    path.startsWith('/.well-known/acme-challenge/') ||
    // The Gateway WebSocket authenticates per connection, not per request
    // (docs/SECURITY.md §6): a browser's WebSocket handshake cannot carry an
    // Authorization header, so the Bearer hook would 401 every upgrade before
    // the Gateway's own checks ever ran. The upgrade is exempted here and the
    // connection is gated instead by the origin check at the route and the
    // session token the first `hello` frame must carry (gateway.ts).
    path === '/ws/gateway' ||
    // Ingestion authenticates by per-source signature/token, not passkey.
    path.startsWith('/api/ingest/') ||
    path === '/api/auth/status' ||
    path === '/api/auth/register/options' ||
    path === '/api/auth/register/verify' ||
    path === '/api/auth/login/options' ||
    path === '/api/auth/login/verify'
  )
}

function extractBearer(value: string | undefined): string | undefined {
  if (!value) return undefined
  const [scheme, token] = value.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
}

function statusForSurfaceActionError(error: SurfaceActionError): number {
  if (error.code === 'unknown_surface') return 404
  if (error.code === 'missing_value') return 400
  return 403
}

async function authAttempt<T>(
  lockout: ProgressiveAuthLockout,
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<T> | T,
): Promise<T | FastifyReply> {
  const key = `${request.ip}:${request.routeOptions.url ?? request.url}`
  const check = lockout.check(key)
  if (!check.allowed) {
    return reply
      .header('retry-after', String(check.retryAfterSeconds))
      .status(429)
      .send({ error: 'auth endpoint temporarily locked' })
  }

  try {
    const result = await run()
    if (!reply.sent) lockout.recordSuccess(key)
    return result
  } catch (error) {
    if (error instanceof AuthStoreError) {
      lockout.recordFailure(key)
      return reply.status(401).send({ error: 'passkey authentication failed' })
    }
    throw error
  }
}
