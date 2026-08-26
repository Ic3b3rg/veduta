import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it, vi } from 'vitest'
import {
  AuthStore,
  AuthStoreError,
  type AuthSession,
  type AuthState,
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

  it('publishes the daemon device inventory after enrollment, rename, and revocation', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => now,
      randomBytes: deterministicBytes,
    })
    const inventories: string[][] = []
    const unsubscribe = auth.onConnectedDevicesChange(() => {
      inventories.push(auth.connectedDevices().map((device) => device.name))
    })

    const registration = await auth.startPasskeyRegistration({
      oneTimeCode: '12345678',
      deviceName: 'Silvio iPhone',
    })
    await auth.finishPasskeyRegistration({
      ceremonyId: registration.ceremonyId,
      response: fromPartial({ id: 'credential-phone' }),
    })

    const authentication = await auth.startPasskeyLogin()
    const renamedSession = await auth.finishPasskeyLogin({
      ceremonyId: authentication.ceremonyId,
      response: fromPartial({ id: 'credential-phone' }),
      deviceName: 'Pocket phone',
    })
    auth.revokeDevice(renamedSession.token, renamedSession.device.id)

    expect(inventories).toEqual([['Silvio iPhone'], ['Pocket phone'], []])
    unsubscribe()
  })

  it('isolates device lifecycle observers from persisted auth mutations and one another', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const passkeys = new FakePasskeyRelyingParty()
      const auth = new AuthStore({
        mode: 'production',
        bootstrapCode: '12345678',
        passkeys,
        now: () => now,
        randomBytes: deterministicBytes,
      })
      let connectedChanges = 0
      let sessionRevocations = 0
      auth.onConnectedDevicesChange(() => {
        throw new Error('connected devices observer failed')
      })
      auth.onConnectedDevicesChange(() => {
        connectedChanges += 1
      })
      auth.onSessionRevoked(() => {
        throw new Error('session revocation observer failed')
      })
      auth.onSessionRevoked(() => {
        sessionRevocations += 1
      })

      const registration = await auth.startPasskeyRegistration({
        oneTimeCode: '12345678',
        deviceName: 'Silvio iPhone',
      })
      const session = await auth.finishPasskeyRegistration({
        ceremonyId: registration.ceremonyId,
        response: fromPartial({ id: 'credential-phone' }),
      })
      expect(connectedChanges).toBe(1)

      expect(() => auth.revokeDevice(session.token, session.device.id)).not.toThrow()
      expect(auth.connectedDevices()).toEqual([])
      expect(connectedChanges).toBe(2)
      expect(sessionRevocations).toBe(1)
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('updates the passkey counter after login verification', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const auth = await registeredAuthStore(passkeys)

    const session = await login(auth, 'credential-phone')

    expect(session.device.name).toBe('Silvio iPhone')
    expect(auth.exportState().passkeys[0]?.counter).toBe(2)
  })

  it('rejects a bootstrap code once its 60-minute expiry has passed', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    let clock = now
    const auth = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => clock,
      randomBytes: deterministicBytes,
    })

    clock = new Date(now.getTime() + 61 * 60_000)
    try {
      await auth.startPasskeyRegistration({ oneTimeCode: '12345678', deviceName: 'Silvio iPhone' })
      expect.fail('expected the expired bootstrap code to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(AuthStoreError)
      const message = (error as AuthStoreError).message
      expect(message).toContain('sudo systemctl restart veduta')
      expect(message).toContain("journalctl -u veduta | grep 'first-boot'")
    }
  })

  it('one-shot env semantics: a static env code cannot revive after expiry — a fresh code is minted instead', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    let clock = now
    const first = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => clock,
      randomBytes: deterministicBytes,
    })
    const persistedState = first.exportState()
    expect(persistedState.bootstrapCodeExpiresAt).toBeDefined()
    expect(first.bootstrapCode()).toBe('12345678')

    clock = new Date(now.getTime() + 61 * 60_000) // past the 60-minute expiry
    const second = new AuthStore({
      mode: 'production',
      // The same static env value re-supplied on restart, exactly as a
      // systemd drop-in would keep doing across restarts.
      bootstrapCode: '12345678',
      passkeys,
      state: persistedState,
      now: () => clock,
      randomBytes: deterministicBytes,
    })

    // The stale env code is dead...
    await expect(
      second.startPasskeyRegistration({ oneTimeCode: '12345678', deviceName: 'Silvio iPhone' }),
    ).rejects.toThrow(AuthStoreError)

    // ...but the store minted its own fresh code — reachable via the seam
    // index.ts uses to print the code that is actually valid right now.
    const effective = second.bootstrapCode()
    expect(effective).toBeDefined()
    expect(effective).not.toBe('12345678')
    const registration = await second.startPasskeyRegistration({
      oneTimeCode: effective!,
      deviceName: 'Silvio iPhone',
    })
    expect(registration.options.challenge).toBeDefined()
  })

  it('rerun with a new env code seeds the new code: the old code is rejected, the new one is accepted', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const first = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => now,
      randomBytes: deterministicBytes,
    })
    const persistedState = first.exportState()

    // Still well within the 60-minute expiry, but the operator has rotated
    // VEDUTA_BOOTSTRAP_CODE to a new value (e.g. re-ran the installer).
    const second = new AuthStore({
      mode: 'production',
      bootstrapCode: '87654321',
      passkeys,
      state: persistedState,
      now: () => now,
      randomBytes: deterministicBytes,
    })

    expect(second.bootstrapCode()).toBe('87654321')

    // The old code no longer works...
    await expect(
      second.startPasskeyRegistration({ oneTimeCode: '12345678', deviceName: 'Silvio iPhone' }),
    ).rejects.toThrow(AuthStoreError)

    // ...but the new one does, with a fresh 60-minute expiry from the reseed.
    const registration = await second.startPasskeyRegistration({
      oneTimeCode: '87654321',
      deviceName: 'Silvio iPhone',
    })
    expect(registration.options.challenge).toBeDefined()
  })

  it('same code re-supplied after expiry still mints a random code, never reviving the stale one', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    let clock = now
    const first = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => clock,
      randomBytes: deterministicBytes,
    })
    const persistedState = first.exportState()

    clock = new Date(now.getTime() + 61 * 60_000) // past the 60-minute expiry
    const second = new AuthStore({
      mode: 'production',
      // The exact same code re-supplied — a naive equality check would let
      // this "match" and skip reseeding, but one-shot semantics must win:
      // an expired code is always dead, even when it's re-offered verbatim.
      bootstrapCode: '12345678',
      passkeys,
      state: persistedState,
      now: () => clock,
      randomBytes: deterministicBytes,
    })

    const effective = second.bootstrapCode()
    expect(effective).toBeDefined()
    expect(effective).not.toBe('12345678')
    await expect(
      second.startPasskeyRegistration({ oneTimeCode: '12345678', deviceName: 'Silvio iPhone' }),
    ).rejects.toThrow(AuthStoreError)
  })

  it('every new construction over an expired persisted state mints a fresh code, boot after boot', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    let clock = now
    const first = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => clock,
      randomBytes: deterministicBytes,
    })
    let state = first.exportState()
    clock = new Date(now.getTime() + 61 * 60_000) // past the 60-minute expiry

    // Three consecutive restarts over the same (still expired) persisted
    // state: every single one must mint and know its own fresh code, not
    // just the first restart after expiry.
    for (let boot = 0; boot < 3; boot += 1) {
      const restarted = new AuthStore({
        mode: 'production',
        passkeys,
        state,
        now: () => clock,
        randomBytes: deterministicBytes,
      })
      const code = restarted.bootstrapCode()
      expect(code).toBeDefined()
      state = restarted.exportState()
      // Advance well past the fresh 60-minute expiry this boot just minted,
      // so the NEXT restart also finds an expired code — otherwise a single
      // fixed clock would only prove the first restart after expiry works.
      clock = new Date(clock.getTime() + 61 * 60_000)
    }
  })

  it('treats a legacy persisted state with no bootstrapCodeExpiresAt as never expiring', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    const first = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys,
      now: () => now,
      randomBytes: deterministicBytes,
    })
    const legacyState = first.exportState()
    delete legacyState.bootstrapCodeExpiresAt // simulates an auth.json written before this field existed

    const farFuture = new Date(now.getTime() + 10 * 60 * 60_000) // 10 hours later
    const restarted = new AuthStore({
      mode: 'production',
      passkeys,
      state: legacyState,
      now: () => farFuture,
      randomBytes: deterministicBytes,
    })

    const registration = await restarted.startPasskeyRegistration({
      oneTimeCode: '12345678',
      deviceName: 'Silvio iPhone',
    })
    expect(registration.options.challenge).toBeDefined()
  })

  it('treats a legacy persisted state with no seenBootstrapCodeHashes as an empty log', async () => {
    const passkeys = new FakePasskeyRelyingParty()
    // Hand-built, deliberately missing `seenBootstrapCodeHashes` entirely —
    // simulates an auth.json written before issue #19's fix added it. A
    // still-unexpired persisted code plus a brand-new env code must still
    // seed the new one (nothing in the (absent) log blocks it).
    const legacyState: AuthState = {
      bootstrapCodeHash: 'stale-hash-from-before-the-seen-log-existed',
      bootstrapCodeExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      passkeys: [],
      devices: [],
      sessions: [],
    }

    const restarted = new AuthStore({
      mode: 'production',
      bootstrapCode: '99999999',
      passkeys,
      state: legacyState,
      now: () => now,
      randomBytes: deterministicBytes,
    })

    expect(restarted.bootstrapCode()).toBe('99999999')
    const registration = await restarted.startPasskeyRegistration({
      oneTimeCode: '99999999',
      deviceName: 'Silvio iPhone',
    })
    expect(registration.options.challenge).toBeDefined()
  })

  it('caps the seen-bootstrap-code log at 10 entries, FIFO: the oldest evicted code can seed again', () => {
    const passkeys = new FakePasskeyRelyingParty()
    const codes = Array.from(
      { length: 11 },
      (_, index) => `code-${index.toString().padStart(3, '0')}`,
    )
    const firstCode = codes[0]
    if (!firstCode) throw new Error('expected at least one code')
    let state: AuthState | undefined

    for (const code of codes) {
      const auth = new AuthStore({
        mode: 'production',
        bootstrapCode: code,
        passkeys,
        now: () => now,
        randomBytes: deterministicBytes,
        ...(state ? { state } : {}),
      })
      // Every code here is genuinely new (never seeded before), so every one
      // of the 11 restarts must seed — proves the cap isn't achieved by
      // silently refusing to seed past 10 distinct codes.
      expect(auth.bootstrapCode()).toBe(code)
      state = auth.exportState()
    }

    expect(state?.seenBootstrapCodeHashes).toHaveLength(10)

    // The very first code was pushed out by the FIFO cap, so it is no longer
    // in the seen log — supplying it again must seed successfully. This is
    // the proof that eviction actually happens, not just that the log length
    // is capped.
    const revived = new AuthStore({
      mode: 'production',
      bootstrapCode: firstCode,
      passkeys,
      now: () => now,
      randomBytes: deterministicBytes,
      state: state!,
    })
    expect(revived.bootstrapCode()).toBe(firstCode)
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
