import {
  AuthSessionSchema,
  AuthStatusSchema,
  OneTimeCodeSchema,
  PairingCodeSchema,
  WebAuthnOptionsEnvelopeSchema,
} from '@veduta/protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import { AuthStoreError, type AuthStore } from './auth-store.ts'

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

export type ServerAuthOptions =
  | { mode: 'dev' }
  | {
      mode: 'production'
      store: AuthStore
      allowedOrigins: string[]
      hstsMaxAgeSeconds?: number
    }

export function registerRequestAuth(app: FastifyInstance, auth: ServerAuthOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    if (auth.mode !== 'production') return
    reply.header('strict-transport-security', hstsHeader(auth.hstsMaxAgeSeconds))
    if (isPublicUnauthenticatedPath(request.url)) return
    if (auth.store.verifySession(extractBearer(request.headers.authorization))) return
    return reply.status(401).send({ error: 'passkey session required' })
  })
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { auth: ServerAuthOptions; lockout: ProgressiveAuthLockout },
): void {
  const { auth, lockout } = deps

  app.get('/api/auth/status', () =>
    AuthStatusSchema.parse(
      auth.mode === 'production'
        ? auth.store.status()
        : { mode: 'dev', passkeyRegistered: false, bootstrapRequired: false },
    ),
  )

  app.post('/api/auth/register/options', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = RegistrationOptionsBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      return WebAuthnOptionsEnvelopeSchema.parse(
        await auth.store.startPasskeyRegistration(parsed.data),
      )
    })
  })

  app.post('/api/auth/register/verify', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = RegistrationVerifyBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      return AuthSessionSchema.parse(await auth.store.finishPasskeyRegistration(parsed.data))
    })
  })

  app.post('/api/auth/login/options', async (_request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return WebAuthnOptionsEnvelopeSchema.parse(await auth.store.startPasskeyLogin())
  })

  app.post('/api/auth/login/verify', async (request, reply) => {
    if (auth.mode !== 'production') return reply.status(404).send({ error: 'auth disabled' })
    return authAttempt(lockout, request, reply, async () => {
      const parsed = LoginVerifyBodySchema.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
      const login = { ceremonyId: parsed.data.ceremonyId, response: parsed.data.response }
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
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  return Boolean(origin && allowedOrigins.includes(origin))
}

export function extractBearer(value: string | undefined): string | undefined {
  if (!value) return undefined
  const [scheme, token] = value.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined
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
    path === '/ws/gateway' ||
    path.startsWith('/api/ingest/') ||
    path === '/api/auth/status' ||
    path === '/api/auth/register/options' ||
    path === '/api/auth/register/verify' ||
    path === '/api/auth/login/options' ||
    path === '/api/auth/login/verify'
  )
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
