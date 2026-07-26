import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { confirmDomain } from './onboarding-step-domain.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-domain-'))
  return rootDir
}

describe('confirmDomain', () => {
  it('marks the domain step completed', () => {
    const dir = freshRoot()
    confirmDomain(dir)
    expect(loadOnboardingConfig(dir).steps.domain).toBe('completed')
  })

  it('is idempotent across repeated calls', () => {
    const dir = freshRoot()
    confirmDomain(dir)
    confirmDomain(dir)
    expect(loadOnboardingConfig(dir).steps.domain).toBe('completed')
  })

  it('preserves other recorded steps', () => {
    const dir = freshRoot()
    confirmDomain(dir)
    const before = loadOnboardingConfig(dir)
    expect(before.steps).toEqual({ domain: 'completed' })
  })
})
