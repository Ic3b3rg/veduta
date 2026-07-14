import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Shared AES-256-GCM sealed-box primitives for at-rest secrets material
 * (issue #15 D2/D5): the secrets vault (`secrets-vault.ts`) and encrypted
 * backups (`backup.ts`) both need scrypt key derivation plus an AEAD seal
 * over a header of `{ salt, iv }`, domain-separated by a purpose label so
 * identical key material yields a different key for each purpose.
 *
 * This module owns only the primitives — key derivation, seal, open, and the
 * AAD that binds salt/iv to the ciphertext. Each caller keeps its own
 * on-disk envelope (a JSON object vs. a header line plus raw bytes, base64
 * `ct` vs. raw ciphertext bytes) local to itself.
 */

export interface SealedGcm {
  salt: string
  iv: string
  tag: string
  ct: string
}

/** Domain-separated scrypt: `label` (e.g. `'vault:'`, `'backup:'`) keeps a derived key distinct from other purposes, even under identical key material. */
export function derivePurposeKey(label: string, keyMaterial: Buffer, salt: Buffer): Buffer {
  return scryptSync(keyMaterial, Buffer.concat([Buffer.from(label), salt]), 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
}

/** Fixed field order so the AAD bytes are reproducible on seal and open. */
export function sealedGcmAad(salt: string, iv: string): Buffer {
  return Buffer.from(JSON.stringify({ salt, iv }), 'utf8')
}

export interface SealGcmInput {
  label: string
  keyMaterial: Buffer
  plaintext: Buffer
}

/**
 * Seals `plaintext` under a fresh 16-byte salt and 12-byte IV — never reuse
 * an IV under a derived key. The AAD covers `{ salt, iv }`, so tampering
 * with either fails authentication exactly like tampering with the
 * ciphertext. All fields are returned base64-encoded.
 */
export function sealGcm(input: SealGcmInput): SealedGcm {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = derivePurposeKey(input.label, input.keyMaterial, salt)
  const saltB64 = salt.toString('base64')
  const ivB64 = iv.toString('base64')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(sealedGcmAad(saltB64, ivB64))
  const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
  return {
    salt: saltB64,
    iv: ivB64,
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  }
}

export interface OpenGcmInput extends SealedGcm {
  label: string
  keyMaterial: Buffer
}

/**
 * Opens a value sealed by `sealGcm`. Throws (a raw `crypto` auth-tag
 * failure) on wrong key material or a tampered salt/iv/tag/ciphertext —
 * never partial or silently-wrong plaintext. Callers should wrap this in
 * their own descriptive error message.
 */
export function openGcm(input: OpenGcmInput): Buffer {
  const salt = Buffer.from(input.salt, 'base64')
  const iv = Buffer.from(input.iv, 'base64')
  const tag = Buffer.from(input.tag, 'base64')
  const ciphertext = Buffer.from(input.ct, 'base64')
  const key = derivePurposeKey(input.label, input.keyMaterial, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(sealedGcmAad(input.salt, input.iv))
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
