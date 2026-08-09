import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ByokProvider } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRoutingConfig } from './model-routing.ts'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { applyByok, type ByokDeps } from './onboarding-step-byok.ts'
import { VaultUnavailableError } from './onboarding-status.ts'
import { VAULT_FILE_NAME, SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const DISTINCTIVE_KEY = 'sk-test-distinctive-marker-should-never-leak-987654321'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-byok-'))
  return rootDir
}

describe('applyByok', () => {
  it('skip marks the step skipped without touching the vault or routing', () => {
    const dir = freshRoot()
    const deps: ByokDeps = { rootDir: dir, vault: undefined }
    applyByok(deps, { skip: true })
    expect(loadOnboardingConfig(dir).steps.byok).toBe('skipped')
    expect(existsSync(join(dir, VAULT_FILE_NAME))).toBe(false)
  })

  it('stores a key in the vault, points routing at the vault ref, and completes the step', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    applyByok({ rootDir: dir, vault }, { provider: 'anthropic', key: DISTINCTIVE_KEY })

    expect(vault.resolve('secret://vault/anthropic')).toBe(DISTINCTIVE_KEY)
    const routing = loadRoutingConfig(dir)
    expect(routing.providerKeys.anthropic).toBe('secret://vault/anthropic')
    expect(loadOnboardingConfig(dir).steps.byok).toBe('completed')
  })

  it('creates a .bak of the vault on a second apply (the first has nothing to back up yet)', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    applyByok({ rootDir: dir, vault }, { provider: 'anthropic', key: DISTINCTIVE_KEY })
    let backups = readdirSync(dir).filter((entry) => entry.startsWith(`${VAULT_FILE_NAME}.bak-`))
    expect(backups).toHaveLength(0)

    applyByok({ rootDir: dir, vault }, { provider: 'anthropic', key: `${DISTINCTIVE_KEY}-2` })
    backups = readdirSync(dir).filter((entry) => entry.startsWith(`${VAULT_FILE_NAME}.bak-`))
    expect(backups).toHaveLength(1)
  })

  it('keep-existing: omitting key reuses the already-stored key', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    applyByok({ rootDir: dir, vault }, { provider: 'anthropic', key: DISTINCTIVE_KEY })
    applyByok({ rootDir: dir, vault }, { provider: 'anthropic' })

    expect(vault.resolve('secret://vault/anthropic')).toBe(DISTINCTIVE_KEY)
    expect(loadRoutingConfig(dir).providerKeys.anthropic).toBe('secret://vault/anthropic')
    expect(loadOnboardingConfig(dir).steps.byok).toBe('completed')
  })

  it('keep-existing against a key placed in the vault out-of-band still points routing at it', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    // Simulate a key that reached the vault some other way (the vault CLI, an
    // earlier process) with nothing having ever run `storeProviderKey` for it.
    // `routing.json` is untouched, so the provider still resolves through
    // `model-routing.ts`'s `secret://env/...` default — the vault entry is
    // invisible to the router until something points `providerKeys` at it.
    vault.set('anthropic', DISTINCTIVE_KEY)
    expect(loadRoutingConfig(dir).providerKeys.anthropic).toBe('secret://env/ANTHROPIC_API_KEY')

    applyByok({ rootDir: dir, vault }, { provider: 'anthropic' })

    expect(loadRoutingConfig(dir).providerKeys.anthropic).toBe('secret://vault/anthropic')
    expect(loadOnboardingConfig(dir).steps.byok).toBe('completed')
  })

  it('keep-existing with no stored key throws an OnboardingStepError naming the provider, never a key value', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    expect(() => applyByok({ rootDir: dir, vault }, { provider: 'openai' })).toThrow(
      /no stored key for openai/,
    )
  })

  it('throws VaultUnavailableError when submitting a key with no vault open', () => {
    const dir = freshRoot()
    expect(() =>
      applyByok(
        { rootDir: dir, vault: undefined },
        { provider: 'anthropic', key: DISTINCTIVE_KEY },
      ),
    ).toThrow(VaultUnavailableError)
  })

  it('never includes the key in any thrown error message', () => {
    const dir = freshRoot()
    try {
      applyByok({ rootDir: dir, vault: undefined }, { provider: 'anthropic', key: DISTINCTIVE_KEY })
      throw new Error('expected applyByok to throw')
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(DISTINCTIVE_KEY)
    }
  })

  it('is idempotent across a simulated crash between the vault write and the status write', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const provider: ByokProvider = 'anthropic'

    // Simulate the side effects having already run once (crash before the
    // onboarding.json write), then re-apply the exact same request.
    applyByok({ rootDir: dir, vault }, { provider, key: DISTINCTIVE_KEY })
    applyByok({ rootDir: dir, vault }, { provider, key: DISTINCTIVE_KEY })

    expect(vault.resolve('secret://vault/anthropic')).toBe(DISTINCTIVE_KEY)
    expect(loadRoutingConfig(dir).providerKeys.anthropic).toBe('secret://vault/anthropic')
    expect(loadOnboardingConfig(dir).steps.byok).toBe('completed')
  })
})
