import { describe, expect, it } from 'vitest'
import { derivePurposeKey, openGcm, sealGcm } from './secret-crypto.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')

describe('sealGcm / openGcm', () => {
  it('round-trips plaintext through seal then open', () => {
    const plaintext = Buffer.from('sk-ant-test-123', 'utf8')
    const sealed = sealGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, plaintext })
    const opened = openGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, ...sealed })
    expect(opened.toString('utf8')).toBe('sk-ant-test-123')
  })

  it('throws when opened with the wrong key material', () => {
    const plaintext = Buffer.from('secret payload', 'utf8')
    const sealed = sealGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, plaintext })
    const wrongKey = Buffer.from('a completely different key material')
    expect(() => openGcm({ label: 'vault:', keyMaterial: wrongKey, ...sealed })).toThrow()
  })

  it('throws when the tag is tampered with', () => {
    const plaintext = Buffer.from('secret payload', 'utf8')
    const sealed = sealGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, plaintext })
    const tamperedTag = Buffer.from(sealed.tag, 'base64')
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff
    expect(() =>
      openGcm({
        label: 'vault:',
        keyMaterial: KEY_MATERIAL,
        ...sealed,
        tag: tamperedTag.toString('base64'),
      }),
    ).toThrow()
  })

  it('throws when the salt is tampered with (the AAD covers salt/iv, not just the ciphertext)', () => {
    const plaintext = Buffer.from('secret payload', 'utf8')
    const sealed = sealGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, plaintext })
    const tamperedSalt = Buffer.from(sealed.salt, 'base64')
    tamperedSalt[0] = (tamperedSalt[0] ?? 0) ^ 0xff
    expect(() =>
      openGcm({
        label: 'vault:',
        keyMaterial: KEY_MATERIAL,
        ...sealed,
        salt: tamperedSalt.toString('base64'),
      }),
    ).toThrow()
  })

  it('label domain separation: the same key material and salt yield different keys for different labels', () => {
    const salt = Buffer.alloc(16, 7)
    const vaultKey = derivePurposeKey('vault:', KEY_MATERIAL, salt)
    const backupKey = derivePurposeKey('backup:', KEY_MATERIAL, salt)
    expect(vaultKey.equals(backupKey)).toBe(false)
  })

  it('a value sealed under one label fails to open under another', () => {
    const plaintext = Buffer.from('secret payload', 'utf8')
    const sealed = sealGcm({ label: 'vault:', keyMaterial: KEY_MATERIAL, plaintext })
    expect(() => openGcm({ label: 'backup:', keyMaterial: KEY_MATERIAL, ...sealed })).toThrow()
  })
})
