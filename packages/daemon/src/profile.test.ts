import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProfile } from './profile.ts'

describe('resolveProfile', () => {
  it('resolves loopback when neither VEDUTA_PROFILE nor VEDUTA_PUBLIC_DOMAIN is set', () => {
    expect(resolveProfile({})).toEqual({ profile: 'loopback' })
  })

  it('resolves loopback when VEDUTA_PROFILE=loopback', () => {
    expect(resolveProfile({ VEDUTA_PROFILE: 'loopback' })).toEqual({ profile: 'loopback' })
  })

  it('resolves vps when VEDUTA_PUBLIC_DOMAIN is set and VEDUTA_PROFILE is unset', () => {
    expect(resolveProfile({ VEDUTA_PUBLIC_DOMAIN: 'example.com' })).toEqual({ profile: 'vps' })
  })

  it('resolves vps when VEDUTA_PUBLIC_DOMAIN is set and VEDUTA_PROFILE=vps', () => {
    expect(resolveProfile({ VEDUTA_PUBLIC_DOMAIN: 'example.com', VEDUTA_PROFILE: 'vps' })).toEqual({
      profile: 'vps',
    })
  })

  it('throws when VEDUTA_PROFILE=local-vps together with VEDUTA_PUBLIC_DOMAIN', () => {
    expect(() =>
      resolveProfile({ VEDUTA_PROFILE: 'local-vps', VEDUTA_PUBLIC_DOMAIN: 'example.com' }),
    ).toThrow(/incompatible with VEDUTA_PUBLIC_DOMAIN/)
  })

  it('throws on an unknown VEDUTA_PROFILE value', () => {
    expect(() => resolveProfile({ VEDUTA_PROFILE: 'staging' })).toThrow(/unknown VEDUTA_PROFILE/)
  })

  it('throws when VEDUTA_PROFILE=vps is set without VEDUTA_PUBLIC_DOMAIN', () => {
    expect(() => resolveProfile({ VEDUTA_PROFILE: 'vps' })).toThrow(
      /VEDUTA_PROFILE=vps requires VEDUTA_PUBLIC_DOMAIN/,
    )
  })

  describe('local-vps', () => {
    it('defaults port to 8788, origin/dataDir derived, no vault keyfile', () => {
      const result = resolveProfile({ VEDUTA_PROFILE: 'local-vps' }, () => false)
      expect(result).toEqual({
        profile: 'local-vps',
        port: 8788,
        origin: 'http://localhost:8788',
        dataDir: join(homedir(), '.veduta-local-vps', 'data'),
        vaultKeyfile: undefined,
      })
    })

    it('throws on a non-numeric or out-of-range PORT', () => {
      for (const PORT of ['abc', '0', '65536', '80.5']) {
        expect(() => resolveProfile({ VEDUTA_PROFILE: 'local-vps', PORT }, () => false)).toThrow(
          /PORT must be an integer/,
        )
      }
    })

    it('honors PORT for both port and origin', () => {
      const result = resolveProfile({ VEDUTA_PROFILE: 'local-vps', PORT: '19000' }, () => false)
      expect(result).toEqual({
        profile: 'local-vps',
        port: 19000,
        origin: 'http://localhost:19000',
        dataDir: join(homedir(), '.veduta-local-vps', 'data'),
        vaultKeyfile: undefined,
      })
    })

    it('honors VEDUTA_DATA_DIR', () => {
      const result = resolveProfile(
        { VEDUTA_PROFILE: 'local-vps', VEDUTA_DATA_DIR: '/tmp/custom-data' },
        () => false,
      )
      expect(result.profile === 'local-vps' && result.dataDir).toBe('/tmp/custom-data')
    })

    it('leaves vaultKeyfile undefined when VEDUTA_VAULT_KEYFILE is already set, even if the default file exists', () => {
      const result = resolveProfile(
        { VEDUTA_PROFILE: 'local-vps', VEDUTA_VAULT_KEYFILE: '/some/keyfile' },
        () => true,
      )
      expect(result.profile === 'local-vps' && result.vaultKeyfile).toBeUndefined()
    })

    it('leaves vaultKeyfile undefined when VEDUTA_VAULT_KEY is already set, even if the default file exists', () => {
      const result = resolveProfile(
        { VEDUTA_PROFILE: 'local-vps', VEDUTA_VAULT_KEY: 'inline-key' },
        () => true,
      )
      expect(result.profile === 'local-vps' && result.vaultKeyfile).toBeUndefined()
    })

    it('sets vaultKeyfile to the default path when neither env var is set and the file exists', () => {
      const expectedPath = join(homedir(), '.veduta-local-vps', 'vault.key')
      const result = resolveProfile(
        { VEDUTA_PROFILE: 'local-vps' },
        (path) => path === expectedPath,
      )
      expect(result.profile === 'local-vps' && result.vaultKeyfile).toBe(expectedPath)
    })

    it('leaves vaultKeyfile undefined when neither env var is set and no file exists at the default path', () => {
      const result = resolveProfile({ VEDUTA_PROFILE: 'local-vps' }, () => false)
      expect(result.profile === 'local-vps' && result.vaultKeyfile).toBeUndefined()
    })
  })
})
