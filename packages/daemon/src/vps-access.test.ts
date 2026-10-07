import { describe, expect, it } from 'vitest'
import { resolveProfile } from './profile.ts'
import { resolveVpsAccess } from './vps-access.ts'

describe('production browser access (ADR-0015, issue #48)', () => {
  it('runs Tunnel access as the VPS profile with a stable localhost origin', () => {
    const env = { VEDUTA_PROFILE: 'vps', VEDUTA_ACCESS: 'tunnel' }
    expect(resolveProfile(env)).toEqual({ profile: 'vps' })
    expect(resolveVpsAccess(env)).toEqual({
      mode: 'tunnel',
      host: '127.0.0.1',
      port: 8788,
      origin: 'http://localhost:8788',
      rpID: 'localhost',
    })
    expect(resolveVpsAccess({ ...env, PORT: '19000' }).origin).toBe('http://localhost:19000')
  })

  it('never silently boots development auth when production access is requested', () => {
    expect(resolveProfile({ VEDUTA_ACCESS: 'tunnel' })).toEqual({ profile: 'vps' })
    expect(() => resolveProfile({ VEDUTA_ACCESS: 'unknown' })).toThrow(/VEDUTA_ACCESS/)
    expect(() => resolveProfile({ VEDUTA_PROFILE: 'loopback', VEDUTA_ACCESS: 'tunnel' })).toThrow(
      /incompatible/,
    )
  })

  it('preserves the Public access default and rejects ambiguous or unsafe configuration', () => {
    expect(resolveVpsAccess({ VEDUTA_PUBLIC_DOMAIN: 'veduta.example.com' })).toEqual({
      mode: 'public',
      host: '0.0.0.0',
      port: 443,
      origin: 'https://veduta.example.com',
      rpID: 'veduta.example.com',
    })
    for (const PORT of ['0', '65536', '80.5', 'abc', '']) {
      expect(() => resolveVpsAccess({ VEDUTA_ACCESS: 'tunnel', PORT })).toThrow(/PORT/)
    }
    expect(() =>
      resolveVpsAccess({ VEDUTA_ACCESS: 'tunnel', VEDUTA_PUBLIC_DOMAIN: 'example.com' }),
    ).toThrow(/incompatible/)
    expect(() => resolveVpsAccess({ VEDUTA_ACCESS: 'invalid' })).toThrow(/VEDUTA_ACCESS/)
    expect(() => resolveVpsAccess({ VEDUTA_PUBLIC_DOMAIN: 'example.com/path' })).toThrow(/domain/)
  })
})
