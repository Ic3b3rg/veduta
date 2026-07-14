import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretsVault } from './secrets-vault.ts'
import { run } from './vault-cli.ts'

const KEY = 'test-vault-key-material-0015'

describe('vault-cli run', () => {
  const dirs: string[] = []
  const makeRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'veduta-vault-cli-'))
    dirs.push(dir)
    return dir
  }
  const collectIo = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
      out,
      err,
    }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('sets, lists, and deletes a secret in the vault under --root', () => {
    const root = makeRoot()
    const env = { VEDUTA_VAULT_KEY: KEY } as NodeJS.ProcessEnv
    const set = collectIo()
    expect(run(['set', 'anthropic', 'sk-ant-secret', '--root', root], { env, io: set.io })).toBe(0)

    const list = collectIo()
    expect(run(['list', '--root', root], { env, io: list.io })).toBe(0)
    expect(list.out).toEqual(['anthropic'])

    // The value is persisted in the vault under --root, resolvable by name.
    expect(
      SecretsVault.open(root, Buffer.from(KEY, 'utf8')).resolve('secret://vault/anthropic'),
    ).toBe('sk-ant-secret')

    const del = collectIo()
    expect(run(['delete', 'anthropic', '--root', root], { env, io: del.io })).toBe(0)
    expect(run(['list', '--root', root], { env, io: collectIo().io })).toBe(0)
  })

  it('returns 1 when no key material is configured', () => {
    const root = makeRoot()
    const { io, err } = collectIo()
    expect(run(['list', '--root', root], { env: {} as NodeJS.ProcessEnv, io })).toBe(1)
    expect(err.join(' ')).toContain('no vault key material')
  })

  it('returns 1 (never throws) when the keyfile path is unreadable', () => {
    const root = makeRoot()
    const env = { VEDUTA_VAULT_KEYFILE: join(root, 'does-not-exist.key') } as NodeJS.ProcessEnv
    const { io } = collectIo()
    expect(() => run(['list', '--root', root], { env, io })).not.toThrow()
    expect(run(['list', '--root', root], { env, io })).toBe(1)
  })

  it('prefers --root over VEDUTA_DATA_DIR', () => {
    const rootFlag = makeRoot()
    const rootEnv = makeRoot()
    const env = { VEDUTA_VAULT_KEY: KEY, VEDUTA_DATA_DIR: rootEnv } as NodeJS.ProcessEnv
    expect(
      run(['set', 'openai', 'sk-openai', '--root', rootFlag], { env, io: collectIo().io }),
    ).toBe(0)

    // The secret landed under the flag's root, not the env's.
    expect(SecretsVault.open(rootFlag, Buffer.from(KEY, 'utf8')).has('openai')).toBe(true)
    expect(SecretsVault.open(rootEnv, Buffer.from(KEY, 'utf8')).has('openai')).toBe(false)
  })
})
