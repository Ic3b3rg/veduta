import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  AuthSessionSchema,
  AuthStatusSchema,
  OneTimeCodeSchema,
  PairingCodeSchema,
  WebAuthnOptionsEnvelopeSchema,
} from '@veduta/protocol'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { fileURLToPath } from 'node:url'
import { ActionInvocationSchema, JsonValueSchema, findDeclaredFastAction } from '@veduta/protocol'
import Fastify from 'fastify'
import { z } from 'zod'
import { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import { AuthStoreError, type AuthStore } from './auth-store.ts'
import { appendConnectedDevicesSurface } from './connected-devices-surface.ts'
import { GatewayHub } from './gateway.ts'
import { sendPwaAsset } from './static-assets.ts'
import { Store } from './store.ts'

// The client sends only (nodeId, action name, value): the state key comes
// from the Atom's declared action, never from the client (ADR-0003).
const FastActionBodySchema = ActionInvocationSchema.extend({
  payload: z.object({ value: JsonValueSchema }),
})

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
  auth?: ServerAuthOptions
  https?: { key: string; cert: string }
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
  const store = new Store()
  const auth = options.auth ?? { mode: 'dev' as const }
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
      : {},
  )
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

  app.get('/assets/*', (request, reply) => {
    const asset = (request.params as { '*': string })['*']
    return sendPwaAsset(reply, pwaDistDir, `assets/${asset}`)
  })

  app.get('/api/spaces', (request) => {
    const snapshot = store.snapshot()
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
    const parsed = FastActionBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues })
    }
    const target = store.getSurface(surfaceId)
    if (!target) {
      return reply.status(404).send({ error: `unknown surface: ${surfaceId}` })
    }
    const declared = findDeclaredFastAction(target.tree, parsed.data.nodeId, parsed.data.name)
    if (!declared) {
      return reply.status(403).send({
        error: `action "${parsed.data.name}" is not declared as fast by node "${parsed.data.nodeId}"`,
      })
    }
    const mutation = store.applyFastAction(surfaceId, declared.stateKey, parsed.data.payload.value)
    gateway.broadcastSurfacePatch(mutation.event)
    return { surface: mutation.surface }
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

  return { app, store, gateway }
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
    path.startsWith('/assets/') ||
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
