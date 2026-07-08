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
import { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import { AuthStoreError, type AuthStore } from './auth-store.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { reminderFromChat } from './chat.ts'
import { appendConnectedDevicesSurface } from './connected-devices-surface.ts'
import { GatewayHub } from './gateway.ts'
import { ModelRouter, loadRoutingConfig } from './model-routing.ts'
import { Scheduler } from './scheduler.ts'
import { sendPwaAsset } from './static-assets.ts'
import { Store, SurfaceActionError } from './store.ts'
import { appendSystemSurface } from './system-space.ts'
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
  const gateway = new GatewayHub(
    store,
    auth.mode === 'production'
      ? {
          auth: {
            verifySession: (token) => auth.store.verifySession(token),
            onSessionRevoked: (listener) =>
              auth.store.onSessionRevoked((event) => listener({ deviceId: event.deviceId })),
          },
        }
      : // Only the dev profile gets the deterministic chat→Surface demo; a
        // production deployment waits for the real Agent loop.
        { mockChatEffects: true, onDevChatEffect: armReminderFromChat },
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
    onSurfacePatch: (event) => gateway.broadcastSurfacePatch(event),
    judge: () => 'unknown',
  })
  scheduler.start()
  app.addHook('onClose', async () => scheduler.stop())
  // Model routing (issue #10): per-tier config from <dataDir>/routing.json,
  // spend persisted under <dataDir>/usage/. Past a daily cap the router
  // shuts proactivity off; the user hears about it in chat. Live spend
  // recording (turn-end costUsd -> recordSpend) lands with the real Agent
  // loop wiring — chat still answers via the mock provider.
  const router = new ModelRouter({
    rootDir: store.spacesEngine.rootDir,
    config: loadRoutingConfig(store.spacesEngine.rootDir),
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
      const result = store.invokeSurfaceAction(surfaceId, parsed.data)
      if (result.path === 'agent') return reply.status(202).send({ turn: result.turn })
      if (!result.mutation.duplicate) gateway.broadcastSurfacePatch(result.mutation.event)
      return { surface: result.mutation.surface }
    } catch (error) {
      if (error instanceof SurfaceActionError) {
        return reply.status(statusForSurfaceActionError(error)).send({ error: error.message })
      }
      throw error
    }
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

  return { app, store, gateway, router, scheduler }
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
