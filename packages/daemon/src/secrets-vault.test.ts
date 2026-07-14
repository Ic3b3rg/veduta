import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { envSecretResolver } from './model-routing.ts'
import {
  SecretsVault,
  VAULT_FILE_NAME,
  compositeSecretResolver,
  resolveVaultKeyMaterial,
} from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-vault-'))
  return rootDir
}

describe('SecretsVault', () => {
  it('resolves a secret set in the same session (set -> resolve round-trip)', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('anthropic', 'sk-ant-test-123')
    expect(vault.resolve('secret://vault/anthropic')).toBe('sk-ant-test-123')
  })

  it('persists across reopen with the same key material', () => {
    const dir = freshRoot()
    SecretsVault.open(dir, KEY_MATERIAL).set('anthropic', 'sk-ant-test-123')
    const reopened = SecretsVault.open(dir, KEY_MATERIAL)
    expect(reopened.resolve('secret://vault/anthropic')).toBe('sk-ant-test-123')
  })

  it('fails closed when reopened with the wrong key material', () => {
    const dir = freshRoot()
    SecretsVault.open(dir, KEY_MATERIAL).set('anthropic', 'sk-ant-test-123')
    const wrongKey = Buffer.from('a completely different key material')
    expect(() => SecretsVault.open(dir, wrongKey)).toThrow()
  })

  it('fails closed when the ciphertext is tampered with', () => {
    const dir = freshRoot()
    SecretsVault.open(dir, KEY_MATERIAL).set('anthropic', 'sk-ant-test-123')
    const path = join(dir, VAULT_FILE_NAME)
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    file['ct'] = Buffer.from('this-is-not-the-real-ciphertext').toString('base64')
    writeFileSync(path, JSON.stringify(file))
    expect(() => SecretsVault.open(dir, KEY_MATERIAL)).toThrow()
  })

  it('fails closed when the salt/iv header is tampered with', () => {
    const dir = freshRoot()
    SecretsVault.open(dir, KEY_MATERIAL).set('anthropic', 'sk-ant-test-123')
    const path = join(dir, VAULT_FILE_NAME)
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    file['iv'] = Buffer.alloc(12, 7).toString('base64')
    writeFileSync(path, JSON.stringify(file))
    expect(() => SecretsVault.open(dir, KEY_MATERIAL)).toThrow()
  })

  it('list returns names only, sorted; delete removes an entry', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('openrouter', 'value-1')
    vault.set('anthropic', 'value-2')
    vault.set('openai', 'value-3')

    expect(vault.list()).toEqual(['anthropic', 'openai', 'openrouter'])
    for (const name of vault.list()) {
      expect(name.startsWith('value-')).toBe(false)
    }

    expect(vault.has('openai')).toBe(true)
    expect(vault.delete('openai')).toBe(true)
    expect(vault.has('openai')).toBe(false)
    expect(vault.list()).toEqual(['anthropic', 'openrouter'])
    expect(vault.delete('openai')).toBe(false)
  })

  it('resolve returns undefined for a non-vault ref and for an unknown vault name', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('anthropic', 'sk-ant-test-123')

    expect(vault.resolve('secret://env/FOO')).toBeUndefined()
    expect(vault.resolve('secret://vault/unknown')).toBeUndefined()
  })

  it('uses a fresh IV and salt on every write', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const path = join(dir, VAULT_FILE_NAME)

    vault.set('anthropic', 'sk-ant-test-123')
    const first = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>

    vault.set('openai', 'sk-openai-test-456')
    const second = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>

    expect(second['iv']).not.toBe(first['iv'])
    expect(second['salt']).not.toBe(first['salt'])
  })
})

describe('compositeSecretResolver', () => {
  it('falls through from the vault to a fallback resolver', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('anthropic', 'sk-ant-test-123')
    process.env['VEDUTA_TEST_COMPOSITE_FOO'] = 'env-value'

    const composite = compositeSecretResolver(vault, envSecretResolver)
    expect(composite.resolve('secret://vault/anthropic')).toBe('sk-ant-test-123')
    expect(composite.resolve('secret://env/VEDUTA_TEST_COMPOSITE_FOO')).toBe('env-value')
    expect(composite.resolve('secret://vault/unknown')).toBeUndefined()

    delete process.env['VEDUTA_TEST_COMPOSITE_FOO']
  })
})

describe('resolveVaultKeyMaterial', () => {
  it('prefers the keyfile over the inline env var', () => {
    const dir = freshRoot()
    const keyfilePath = join(dir, 'vault.key')
    writeFileSync(keyfilePath, '  keyfile-secret-material  \n')
    const env = { VEDUTA_VAULT_KEYFILE: keyfilePath, VEDUTA_VAULT_KEY: 'inline-secret' }
    expect(resolveVaultKeyMaterial(env)?.toString('utf8')).toBe('keyfile-secret-material')
  })

  it('falls back to the inline env var when no keyfile is set', () => {
    const env = { VEDUTA_VAULT_KEY: 'inline-secret' }
    expect(resolveVaultKeyMaterial(env)?.toString('utf8')).toBe('inline-secret')
  })

  it('returns undefined when neither is set', () => {
    expect(resolveVaultKeyMaterial({})).toBeUndefined()
  })
})
