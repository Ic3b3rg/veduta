import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { applyMigrationChoice } from './onboarding-step-migration.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-migration-'))
  return rootDir
}

describe('applyMigrationChoice', () => {
  it('records migrate-later and completes the step', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('migrate-later')
    expect(config.steps.migration).toBe('completed')
  })

  it('records manual and completes the step', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'manual')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('manual')
    expect(config.steps.migration).toBe('completed')
  })

  it('is idempotent: re-applying the same choice leaves the same recorded state', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    applyMigrationChoice(dir, 'migrate-later')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('migrate-later')
    expect(config.steps.migration).toBe('completed')
  })

  it('re-applying with a different choice overwrites the marker', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    applyMigrationChoice(dir, 'manual')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('manual')
    expect(config.steps.migration).toBe('completed')
  })

  it('preserves unrelated existing steps', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'manual')
    const before = loadOnboardingConfig(dir)
    expect(before.steps).toEqual({ migration: 'completed' })
  })
})
