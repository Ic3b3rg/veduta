import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  AuthSessionSchema,
  AuthStatusSchema,
  ActionInvocationSchema,
  OneTimeCodeSchema,
  PairingCodeSchema,
  WebAuthnOptionsEnvelopeSchema,
} from '@veduta/protocol'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { z } from 'zod'
import { AllowlistSurfaceManager } from './allowlist-surface.ts'
import { ApprovalSurfaceManager } from './approval-surface.ts'
import { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import { AuditSurfaceManager } from './audit-surface.ts'
import { AuthStoreError, type AuthStore } from './auth-store.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { reminderFromChat } from './chat.ts'
import { appendConnectedDevicesSurface } from './connected-devices-surface.ts'
import { createDevDispatch } from './dev-dispatch.ts'
import { EventIngestion, type FetchStage } from './event-ingestion.ts'
import type { ExternalEvent } from './external-event.ts'
import { promptFullText } from './full-text-flow.ts'
import { GatewayHub } from './gateway.ts'
import { CalendarSource, GmailSource, GoogleTokenProvider } from './google-sources.ts'
import { loadIngestionConfig } from './ingestion-config.ts'
import { MockAgentRunner } from './mock-agent-runner.ts'
import { mockReaderComplete } from './mock-provider.ts'
import { ModelRouter, envSecretResolver, loadRoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { QuarantinedReader } from './quarantined-reader.ts'
import { Scheduler } from './scheduler.ts'
import { WatchManager } from './watch-renewal.ts'
import { sendPwaAsset } from './static-assets.ts'
import { Store, SurfaceActionError } from './store.ts'
import { appendSystemSurface, ensureSystemSpace } from './system-space.ts'
import { isTrustWrapped, TrustLayer } from './trust-layer.ts'
import { usageSurface } from './usage-surface.ts'

// The client sends only node/action/payload: state keys come from declared
// Atom actions, never from the client (ADR-0003).
const SurfaceActionBodySchema = ActionInvocationSchema

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

export interface ServerOptions {
  pwaDistDir?: string
  dataDir?: string
  auth?: ServerAuthOptions
  https?: { key: string; cert: string }
  /** Injectable clock so tests drive the scheduler with a fake clock. */
  now?: () => Date
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
  const store = new Store({
    now,
    ...(options.dataDir === undefined ? {} : { rootDir: options.dataDir }),
  })
  // The trust layer's admin Surfaces (allowlist, audit) need a durable home
  // (issue #14, D8): materialize the System Space before anything else so
  // it exists no matter which subsystem writes to it first.
  ensureSystemSpace(store.spacesEngine)
  const auth = options.auth ?? { mode: 'dev' as const }
  // Dev-profile stand-in for the Agent's arm_timer decision (scheduler is
  // assigned right after the gateway; chat frames only arrive once both exist).
  const armReminderFromChat = (event: NormalizedChannelEvent) => {
    const reminder = reminderFromChat(event.text, now())
    if (!reminder) return
    const spaceId = event.spaceId ?? 'spc-health'
    if (!store.getSpace(spaceId)) return
    try {
      scheduler.armTimer({
        spaceId,
        when: reminder.fireAtIso,
        condition: { kind: 'event-logged', textIncludes: reminder.conditionNeedle },
        action: reminder.action,
      })
    } catch {
      // A malformed demo reminder must never take the chat socket down.
    }
  }
  // Late binding: the Gateway exists before event ingestion (which owns the
  // queue the full-text flow reads from), so the handler is assigned further
  // down, once the ingestion pipeline is constructed. Chat frames can only
  // arrive after buildServer returns, so the binding is always in place.
  let fullTextHandler: (queueId: number) => Promise<string> = () =>
    Promise.reject(new Error('full-text flow not ready'))
  const onFullTextRequest = (queueId: number) => fullTextHandler(queueId)
  // Late binding, same reasoning as `fullTextHandler`: the dev dispatcher
  // (issue #14, D12) needs `gateway.replyToClient`, so it can only be built
  // once the Gateway exists; chat frames can only arrive after buildServer
  // returns, so the binding is always in place by then.
  let devDispatchHandler: (event: NormalizedChannelEvent) => void = () => {}
  const gateway = new GatewayHub(
    store,
    auth.mode === 'production'
      ? {
          auth: {
            verifySession: (token) => auth.store.verifySession(token),
            onSessionRevoked: (listener) =>
              auth.store.onSessionRevoked((event) => listener({ deviceId: event.deviceId })),
          },
          onFullTextRequest,
        }
      : // Only the dev profile gets the deterministic chat→Surface demo; a
        // production deployment waits for the real Agent loop.
        {
          mockChatEffects: true,
          onDevChatEffect: (event) => {
            armReminderFromChat(event)
            devDispatchHandler(event)
          },
          onFullTextRequest,
        },
  )
  // The scheduler (issue #11): timers and jobs fire as visible Automations.
  // The judgment path stays a deterministic "unknown" (fail-safe: escalate)
  // stub because the daemon has no provider client yet — chat itself still
  // answers via the mock provider. It lands with the real Agent loop wiring
  // as router.execute({ purpose: 'classification', origin: 'proactive' })
  // so the daily spending caps govern scheduler judgments too.
  const scheduler = new Scheduler({
    rootDir: store.spacesEngine.rootDir,
    store,
    now,
    onEscalation: (_spaceId, text) => gateway.broadcastSystemNotice(text),
    judge: () => 'unknown',
  })
  scheduler.start()
  app.addHook('onClose', async () => scheduler.stop())

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

  // The two example outbound tools (D11): registered with the trust layer,
  // then wrapped so every call decides allow/card/deny before any effect.
  // The mock transport records deliveries as Space events — there is no
  // real mail/bank backend (issue #15 is network egress enforcement).
  const outboundTransport = createMockOutboundTransport(store.spacesEngine)
  const outboundTools = createOutboundTools(outboundTransport)
  for (const { tool, meta } of outboundTools) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundTools.map(({ tool }) => tool))

  // Admin Surfaces (D8): pre-created at boot, rebuilt on every trust-layer
  // change. Both live in the System Space materialized above.
  const allowlistSurfaces = new AllowlistSurfaceManager({ store, trust })
  allowlistSurfaces.start()
  const auditSurfaces = new AuditSurfaceManager({ store, trust })
  auditSurfaces.start()

  // Boot recovery (D7/A2): overdue pending rows expire, interrupted
  // `executing` rows re-run through the same effectId. Fire-and-forget,
  // same reasoning as `ingestion.recoverAtBoot()` below — nothing else
  // waits on it, and a failure here must never take the daemon down. A
  // click on a persisted card is correct the instant the store can be read
  // (Fix A: `handleFastMutation` resolves against `trust.hasPendingCardSurface`,
  // never an in-memory cache), so this ordering is not a correctness
  // requirement any more — kept because `approvalSurfaces.start()` must
  // still never repair a Surface for a row `recoverAtBoot()` is about to
  // expire or mark indeterminate.
  trust
    .start()
    .then(() => approvalSurfaces.start())
    .catch((error) => {
      console.error('trust layer boot recovery failed', error)
    })
  app.addHook('onClose', async () => {
    allowlistSurfaces.dispose()
    auditSurfaces.dispose()
    approvalSurfaces.dispose()
    trust.dispose()
  })

  // Dev-profile chat dispatcher (D12): a deterministic stand-in for the
  // future Agent loop, parsing two fixed command shapes straight to the
  // trust-wrapped outbound tools above. Real Agent loop wiring replaces
  // this handler outright.
  devDispatchHandler = createDevDispatch({
    spacesEngine: store.spacesEngine,
    tools: wrappedOutboundTools,
    isTrustWrapped,
    reply: (clientId, text) => gateway.replyToClient(clientId, text),
    now,
  })

  // Model routing (issue #10): per-tier config from <dataDir>/routing.json,
  // spend persisted under <dataDir>/usage/. Past a daily cap the router
  // shuts proactivity off; the user hears about it in chat. Live spend
  // recording (turn-end costUsd -> recordSpend) lands with the real Agent
  // loop wiring — chat still answers via the mock provider.
  const routingConfig = loadRoutingConfig(store.spacesEngine.rootDir)
  const triageKeyResolves = routingConfig.tiers.triage.some((entry) => {
    const secretRef = routingConfig.providerKeys[entry.provider]
    return secretRef === undefined || envSecretResolver.resolve(secretRef) !== undefined
  })
  if (!triageKeyResolves) {
    // Dev profile without provider keys (by design): keep one keyless mock
    // candidate so the quarantined reader still has a triage model to route
    // to. It disappears as soon as a real key resolves; the real provider
    // client replaces `mockReaderComplete` with the Agent loop wiring.
    routingConfig.tiers.triage = [
      ...routingConfig.tiers.triage,
      { provider: 'mock', modelId: 'reader-mock' },
    ]
  }
  const router = new ModelRouter({
    rootDir: store.spacesEngine.rootDir,
    config: routingConfig,
    onEvent: (event) => {
      if (event.type !== 'spending.cap-exceeded') return
      gateway.broadcastSystemNotice(
        `Daily ${event.tier} spending cap reached ($${event.spentUsd.toFixed(2)} of ` +
          `$${event.capUsd.toFixed(2)}). Proactivity is paused until tomorrow; chat stays available.`,
      )
    },
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
    const tokens = new GoogleTokenProvider({ ...google, secrets: envSecretResolver, now })
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
            const channelToken = envSecretResolver.resolve(source.secret)
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

  app.get('/api/health', () => ({ ok: true }))

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
    const snapshot = appendSystemSurface(
      store.snapshot(),
      usageSurface(router.usage(), new Date().toISOString()),
    )
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

  return {
    app,
    store,
    gateway,
    router,
    scheduler,
    ingestion,
    watchManager,
    trust,
    approvalSurfaces,
    allowlistSurfaces,
    auditSurfaces,
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
    path.startsWith('/app/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/icons/') ||
    path === '/manifest.webmanifest' ||
    path === '/service-worker.js' ||
    path.startsWith('/.well-known/acme-challenge/') ||
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
