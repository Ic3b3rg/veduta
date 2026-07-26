import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAuthState, saveAuthState } from './auth-state-file.ts'
import type { AuthState } from './auth-store.ts'

describe('auth state file', () => {
  it('validates and round-trips persisted passkeys, devices and sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veduta-auth-'))
    const path = join(dir, 'auth.json')
    const state: AuthState = {
      passkeys: [
        {
          id: 'credential-phone',
          publicKey: 'public-key',
          counter: 1,
          transports: ['internal'],
          deviceType: 'multiDevice',
          backedUp: true,
          webAuthnUserID: 'user-1',
          deviceId: 'dev-1',
          createdAt: '2026-07-03T12:00:00.000Z',
        },
      ],
      devices: [
        {
          id: 'dev-1',
          name: 'Silvio iPhone',
          credentialId: 'credential-phone',
          createdAt: '2026-07-03T12:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'ses-1',
          tokenHash: 'hash',
          deviceId: 'dev-1',
          scopes: ['gateway'],
          createdAt: '2026-07-03T12:00:00.000Z',
          expiresAt: '2026-08-02T12:00:00.000Z',
        },
      ],
    }

    saveAuthState(path, state)

    expect(loadAuthState(path)).toEqual(state)
  })

  it('round-trips a persisted bootstrapCodeExpiresAt alongside the hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veduta-auth-'))
    const path = join(dir, 'auth.json')
    const state: AuthState = {
      bootstrapCodeHash: 'a-hash',
      bootstrapCodeExpiresAt: '2026-07-24T11:00:00.000Z',
      passkeys: [],
      devices: [],
      sessions: [],
    }

    saveAuthState(path, state)

    expect(loadAuthState(path)).toEqual(state)
  })

  it('loads a pre-existing auth.json written before bootstrapCodeExpiresAt existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veduta-auth-'))
    const path = join(dir, 'auth.json')
    // Hand-written, deliberately missing the field entirely — simulates an
    // auth.json from before issue #19 T4 added it.
    await writeFile(
      path,
      JSON.stringify({
        bootstrapCodeHash: 'a-hash',
        passkeys: [],
        devices: [],
        sessions: [],
      }),
    )

    const loaded = loadAuthState(path)
    expect(loaded?.bootstrapCodeHash).toBe('a-hash')
    expect(loaded?.bootstrapCodeExpiresAt).toBeUndefined()
  })

  it('round-trips a persisted seenBootstrapCodeHashes log alongside the hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veduta-auth-'))
    const path = join(dir, 'auth.json')
    const state: AuthState = {
      bootstrapCodeHash: 'a-hash',
      bootstrapCodeExpiresAt: '2026-07-24T11:00:00.000Z',
      seenBootstrapCodeHashes: ['hash-1', 'hash-2', 'a-hash'],
      passkeys: [],
      devices: [],
      sessions: [],
    }

    saveAuthState(path, state)

    expect(loadAuthState(path)).toEqual(state)
  })

  it('loads a pre-existing auth.json written before seenBootstrapCodeHashes existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'veduta-auth-'))
    const path = join(dir, 'auth.json')
    // Hand-written, deliberately missing the field entirely — simulates an
    // auth.json from before issue #19's fix added it.
    await writeFile(
      path,
      JSON.stringify({
        bootstrapCodeHash: 'a-hash',
        bootstrapCodeExpiresAt: '2026-07-24T11:00:00.000Z',
        passkeys: [],
        devices: [],
        sessions: [],
      }),
    )

    const loaded = loadAuthState(path)
    expect(loaded?.bootstrapCodeHash).toBe('a-hash')
    expect(loaded?.seenBootstrapCodeHashes).toBeUndefined()
  })
})
