import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ONBOARDING_FILE_NAME,
  OnboardingConfigSchema,
  loadOnboardingConfig,
  migrateLegacyStepIds,
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

  it('maps a legacy byok:completed/models:completed file onto model-connection:completed', () => {
    const dir = freshRoot()
    writeFileSync(
      join(dir, ONBOARDING_FILE_NAME),
      JSON.stringify({
        version: 1,
        steps: { domain: 'completed', byok: 'completed', models: 'completed' },
      }),
    )
    const config = loadOnboardingConfig(dir)
    expect(config.steps).toEqual({ domain: 'completed', 'model-connection': 'completed' })
  })

  it('maps byok:skipped onto model-connection:skipped', () => {
    const dir = freshRoot()
    writeFileSync(
      join(dir, ONBOARDING_FILE_NAME),
      JSON.stringify({ version: 1, steps: { byok: 'skipped', models: 'completed' } }),
    )
    const config = loadOnboardingConfig(dir)
    expect(config.steps['model-connection']).toBe('skipped')
  })

  it('drops the legacy keys so the next save is clean', () => {
    const dir = freshRoot()
    writeFileSync(
      join(dir, ONBOARDING_FILE_NAME),
      JSON.stringify({ version: 1, steps: { byok: 'completed', models: 'completed' } }),
    )
    const config = loadOnboardingConfig(dir)
    expect(config.steps).not.toHaveProperty('byok')
    expect(config.steps).not.toHaveProperty('models')
    saveOnboardingConfig(dir, config)
    expect(loadOnboardingConfig(dir).steps).toEqual({ 'model-connection': 'completed' })
  })
})

describe('migrateLegacyStepIds', () => {
  it('leaves a file with neither legacy key unchanged', () => {
    const raw = { version: 1, steps: { domain: 'completed' } }
    expect(migrateLegacyStepIds(raw)).toEqual(raw)
  })

  it('leaves a pending legacy byok absent on model-connection rather than pending', () => {
    const migrated = migrateLegacyStepIds({ version: 1, steps: { byok: 'pending' } }) as {
      steps: Record<string, unknown>
    }
    expect(migrated.steps).not.toHaveProperty('model-connection')
    expect(migrated.steps).not.toHaveProperty('byok')
  })

  it('an existing steps["model-connection"] wins over what byok would otherwise compute', () => {
    const migrated = migrateLegacyStepIds({
      version: 1,
      steps: { byok: 'completed', 'model-connection': 'pending' },
    }) as { steps: Record<string, unknown> }
    expect(migrated.steps['model-connection']).toBe('pending')
  })

  it('passes through a non-object payload unchanged', () => {
    expect(migrateLegacyStepIds(null)).toBeNull()
    expect(migrateLegacyStepIds('not an object')).toBe('not an object')
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
      steps: { 'model-connection': 'completed' },
      completedAt: '2026-07-24T10:00:00.000Z',
    })
    saveOnboardingConfig(dir, config)
    expect(OnboardingConfigSchema.parse(loadOnboardingConfig(dir))).toEqual(config)
  })
})
