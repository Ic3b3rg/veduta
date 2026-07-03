import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  AuthStore,
  AuthStoreError,
  type AuthSession,
  type PasskeyRelyingParty,
  type StoredPasskey,
} from './auth-store.ts'

const now = new Date('2026-07-03T12:00:00.000Z')

describe('AuthStore passkey setup', () => {
  it('registers the first passkey with the one-time bootstrap code and consumes the code', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => now,
      randomBytes: deterministicBytes,
    })

    const registration = await auth.startPasskeyRegistration({
      oneTimeCode: '12345678',
      deviceName: 'Silvio iPhone',
    })
    expect(registration.options.challenge).toBe('registration-challenge-1')

    const session = await auth.finishPasskeyRegistration({
      ceremonyId: registration.ceremonyId,
      response: fromPartial({ id: 'credential-phone' }),
    })

    expect(session.token).toMatch(/^vdt_/)
    expect(session.device).toMatchObject({ name: 'Silvio iPhone' })
    expect(auth.verifySession(session.token)?.device.name).toBe('Silvio iPhone')
    await expect(
      auth.startPasskeyRegistration({ oneTimeCode: '12345678', deviceName: 'Replay' }),
    ).rejects.toThrow(AuthStoreError)
  })

  it('creates a pairing code from an authenticated device and registers another device', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = await registeredAuthStore(passkeys)
    const ownerSession = await login(auth, 'credential-phone')

    const pairing = auth.createPairingCode(ownerSession.token)
    expect(pairing.pairingUri).toBe(`https://veduta.test/setup?code=${pairing.code}`)

    const registration = await auth.startPasskeyRegistration({
      oneTimeCode: pairing.code,
      deviceName: 'MacBook',
    })
    const pairedSession = await auth.finishPasskeyRegistration({
      ceremonyId: registration.ceremonyId,
      response: fromPartial({ id: 'credential-mac' }),
    })

    expect(auth.listDevices(ownerSession.token).map((device) => device.name)).toEqual([
      'Silvio iPhone',
      'MacBook',
    ])
    expect(auth.verifySession(pairedSession.token)?.device.name).toBe('MacBook')
  })

  it('revokes a device, invalidates its active sessions and emits the revoked token hashes', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = await registeredAuthStore(passkeys)
    const session = await login(auth, 'credential-phone')
    const revokedTokenHashes: string[] = []
    auth.onSessionRevoked((event) => revokedTokenHashes.push(event.tokenHash))

    auth.revokeDevice(session.token, session.device.id)

    expect(auth.verifySession(session.token)).toBeUndefined()
    expect(revokedTokenHashes).toHaveLength(2)
    expect(auth.listDevices(session.token)).toEqual([])
  })

  it('updates the passkey counter after login verification', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = await registeredAuthStore(passkeys)

    const session = await login(auth, 'credential-phone')

    expect(session.device.name).toBe('Silvio iPhone')
    expect(auth.exportState().passkeys[0]?.counter).toBe(2)
  })

  it('continues device IDs from persisted state after restart', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = await registeredAuthStore(passkeys)
    const ownerSession = await login(auth, 'credential-phone')
    const restarted = new AuthStore({
      mode: 'production',
      passkeys,
      state: auth.exportState(),
      now: () => now,
      randomBytes: deterministicBytes,
      publicOrigin: 'https://veduta.test',
    })

    const pairing = restarted.createPairingCode(ownerSession.token)
    const registration = await restarted.startPasskeyRegistration({
      oneTimeCode: pairing.code,
      deviceName: 'MacBook',
    })
    const pairedSession = await restarted.finishPasskeyRegistration({
      ceremonyId: registration.ceremonyId,
      response: fromPartial({ id: 'credential-mac' }),
    })

    expect(pairedSession.device.id).not.toBe(ownerSession.device.id)
  })
})

class FakePasskeyRelyingParty implements PasskeyRelyingParty {
  private registrationCount = 0
  private authenticationCount = 0

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
    this.authenticationCount += 1
    return { challenge: `authentication-challenge-${this.authenticationCount}` }
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

async function registeredAuthStore(passkeys: FakePasskeyRelyingParty): Promise<AuthStore> {
  const auth = new AuthStore({
    mode: 'production',
    bootstrapCode: '12345678',
    passkeys,
    now: () => now,
    randomBytes: deterministicBytes,
    publicOrigin: 'https://veduta.test',
  })
  const registration = await auth.startPasskeyRegistration({
    oneTimeCode: '12345678',
    deviceName: 'Silvio iPhone',
  })
  await auth.finishPasskeyRegistration({
    ceremonyId: registration.ceremonyId,
    response: fromPartial({ id: 'credential-phone' }),
  })
  return auth
}

async function login(auth: AuthStore, credentialId: string): Promise<AuthSession> {
  const authentication = await auth.startPasskeyLogin()
  expect(authentication.options.challenge).toBe('authentication-challenge-1')
  return auth.finishPasskeyLogin({
    ceremonyId: authentication.ceremonyId,
    response: fromPartial({ id: credentialId }),
    deviceName: 'Silvio iPhone',
  })
}

function deterministicBytes(length: number): Buffer {
  return Buffer.alloc(length, 7)
}
