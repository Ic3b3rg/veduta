import { describe, expect, it } from 'vitest'
import {
  AuthSessionSchema,
  AuthStatusSchema,
  PairingCodeSchema,
  WebAuthnOptionsEnvelopeSchema,
} from './index.ts'

describe('Auth protocol', () => {
  it('validates auth status, session, pairing code and WebAuthn option envelopes', () => {
    expect(
      AuthStatusSchema.parse({
        mode: 'production',
        passkeyRegistered: false,
        bootstrapRequired: true,
      }),
    ).toMatchObject({ mode: 'production' })

    expect(
      AuthSessionSchema.safeParse({
        token: 'vdt_tok-1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        device: {
          id: 'dev-1',
          name: 'Silvio iPhone',
          credentialId: 'credential-1',
          createdAt: '2026-07-03T12:00:00.000Z',
        },
      }).success,
    ).toBe(true)

    expect(
      PairingCodeSchema.safeParse({
        code: 'abc12345',
        expiresAt: '2026-07-03T12:10:00.000Z',
        pairingUri: 'https://veduta.test/setup?code=abc12345',
      }).success,
    ).toBe(true)

    expect(
      WebAuthnOptionsEnvelopeSchema.safeParse({
        ceremonyId: 'auth-1',
        options: { challenge: 'opaque-to-protocol' },
      }).success,
    ).toBe(true)
  })
})
