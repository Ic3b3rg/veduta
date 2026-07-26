import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ONBOARDING_FILE_NAME,
  OnboardingConfigSchema,
  loadOnboardingConfig,
  saveOnboardingConfig,
  type OnboardingConfig,
} from './onboarding-config.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-config-'))
  return rootDir
}

describe('loadOnboardingConfig', () => {
  it('defaults to a fresh, all-pending wizard when no file exists', () => {
    const dir = freshRoot()
    expect(loadOnboardingConfig(dir)).toEqual({ version: 1, steps: {} })
  })

  it('parses a persisted file with steps and optional fields', () => {
    const dir = freshRoot()
    const config: OnboardingConfig = {
      version: 1,
      steps: { migration: 'completed', domain: 'pending' },
      migrationChoice: 'migrate-later',
      legacy: { openclaw: true, hermes: false, sourceHome: '/home/alice' },
    }
    writeFileSync(join(dir, ONBOARDING_FILE_NAME), JSON.stringify(config))
    expect(loadOnboardingConfig(dir)).toEqual(config)
  })

  it('rejects an unknown step id', () => {
    const dir = freshRoot()
    writeFileSync(
      join(dir, ONBOARDING_FILE_NAME),
      JSON.stringify({ version: 1, steps: { 'not-a-step': 'completed' } }),
    )
    expect(() => loadOnboardingConfig(dir)).toThrow()
  })

  it('throws a clear error on corrupted JSON instead of silently resetting', () => {
    const dir = freshRoot()
    writeFileSync(join(dir, ONBOARDING_FILE_NAME), '{not json at all')
    expect(() => loadOnboardingConfig(dir)).toThrow(/invalid JSON in onboarding config/)
    // The corrupted content must survive the failed load — no silent reset.
    expect(() => loadOnboardingConfig(dir)).toThrow(/refusing to silently reset/)
  })
})

describe('saveOnboardingConfig', () => {
  it('round-trips through save then load', () => {
    const dir = freshRoot()
    const config: OnboardingConfig = {
      version: 1,
      steps: { migration: 'skipped', domain: 'completed' },
      firstSpace: { name: 'Health', slug: 'health' },
    }
    saveOnboardingConfig(dir, config)
    expect(loadOnboardingConfig(dir)).toEqual(config)
  })

  it('creates a .bak of the previous version before overwriting', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, { version: 1, steps: { migration: 'pending' } })
    saveOnboardingConfig(dir, { version: 1, steps: { migration: 'completed' } })

    const backups = readdirSync(dir).filter((entry) =>
      entry.startsWith(`${ONBOARDING_FILE_NAME}.bak-`),
    )
    expect(backups).toHaveLength(1)
    expect(loadOnboardingConfig(dir).steps.migration).toBe('completed')
  })

  it('parses to the same shape via OnboardingConfigSchema (strict round-trip)', () => {
    const dir = freshRoot()
    const config = OnboardingConfigSchema.parse({
      steps: { byok: 'completed' },
      completedAt: '2026-07-24T10:00:00.000Z',
    })
    saveOnboardingConfig(dir, config)
    expect(OnboardingConfigSchema.parse(loadOnboardingConfig(dir))).toEqual(config)
  })
})
