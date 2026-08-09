import { describe, expect, it } from 'vitest'
import { AuthStore, type PasskeyRelyingParty, type StoredPasskey } from './auth-store.ts'
import { buildServer } from './server.ts'

/**
 * M7 (issue #47): a bare-Fastify `app.inject` test proves the ROUTE's own
 * logic, but only a real `buildServer` with production auth wired up proves
 * the shared `onRequest` hook (`server.ts`) actually covers
 * `/api/model-connections*` — the same gap issue #47's plan closed for the
 * onboarding routes in an earlier issue. One instance, one table, every
 * route: unauthenticated is always 401, authenticated is never 401/403.
 */

class FakePasskeys implements PasskeyRelyingParty {
  private registrationCount = 0

  async generateRegistrationOptions(): Promise<{ challenge: string }> {
    this.registrationCount += 1
    return { challenge: `registration-challenge-${this.registrationCount}` }
  }

  async verifyRegistrationResponse(input: {
    response: unknown
  }): Promise<{ verified: true; passkey: StoredPasskey }> {
    const credentialId = (input.response as { id?: string }).id ?? 'credential-phone'
    return {
      verified: true,
      passkey: {
        id: credentialId,
        publicKey: `public-key-${credentialId}`,
        counter: 1,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true,
        webAuthnUserID: `user-${credentialId}`,
      },
    }
  }

  async generateAuthenticationOptions(): Promise<{ challenge: string }> {
    return { challenge: 'authentication-challenge-1' }
  }

  async verifyAuthenticationResponse(input: {
    response: unknown
  }): Promise<{ verified: true; credentialId: string; newCounter: number }> {
    return {
      verified: true,
      credentialId: (input.response as { id?: string }).id ?? 'credential-phone',
      newCounter: 2,
    }
  }
}

function fixedNow(): Date {
  return new Date('2026-08-09T10:00:00.000Z')
}

function deterministicBytes(length: number): Buffer {
  return Buffer.alloc(length, 7)
}

async function readyAuthStore(): Promise<{ auth: AuthStore; token: string }> {
  const auth = new AuthStore({
    mode: 'production',
    bootstrapCode: '12345678',
    passkeys: new FakePasskeys(),
    now: fixedNow,
    randomBytes: deterministicBytes,
    publicOrigin: 'https://veduta.test',
  })
  const registration = await auth.startPasskeyRegistration({
    oneTimeCode: '12345678',
    deviceName: 'Silvio iPhone',
  })
  const session = await auth.finishPasskeyRegistration({
    ceremonyId: registration.ceremonyId,
    response: { id: 'credential-phone' },
  })
  return { auth, token: session.token }
}

const ID = 'some-connection-id'

interface RouteCase {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: string
  payload?: Record<string, unknown>
}

const ROUTES: readonly RouteCase[] = [
  { method: 'GET', url: '/api/model-connections' },
  { method: 'POST', url: '/api/model-connections', payload: { method: 'anthropic-api-key' } },
  { method: 'POST', url: `/api/model-connections/${ID}/authorize`, payload: {} },
  { method: 'GET', url: `/api/model-connections/${ID}` },
  { method: 'POST', url: `/api/model-connections/${ID}/catalog`, payload: {} },
  { method: 'POST', url: `/api/model-connections/${ID}/verify`, payload: { modelId: 'model-a' } },
  { method: 'PATCH', url: `/api/model-connections/${ID}`, payload: { label: 'Renamed' } },
  { method: 'DELETE', url: `/api/model-connections/${ID}` },
  {
    method: 'POST',
    url: '/api/model-connections/selection',
    payload: { connectionId: ID, modelId: 'model-a' },
  },
  { method: 'POST', url: '/api/model-connections/mock', payload: { enabled: true } },
]

describe('/api/model-connections* under production auth', () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.url} requires a session`, async () => {
      const { auth } = await readyAuthStore()
      const { app } = buildServer({
        auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
      })

      const res = await app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      })
      expect(res.statusCode).toBe(401)
    })

    it(`${route.method} ${route.url} is reachable (not 401/403) once authenticated`, async () => {
      const { auth, token } = await readyAuthStore()
      const { app } = buildServer({
        auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
      })

      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${token}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      })
      expect(res.statusCode).not.toBe(401)
      expect(res.statusCode).not.toBe(403)
    })
  }
})
