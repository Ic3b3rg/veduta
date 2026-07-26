import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OnboardingTiers } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRoutingConfig, saveRoutingConfig } from './model-routing.ts'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { applyModels } from './onboarding-step-models.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-models-'))
  return rootDir
}

const CUSTOM_TIERS: OnboardingTiers = {
  triage: [{ provider: 'openai', modelId: 'gpt-5.5-mini' }],
  reasoning: [{ provider: 'openai', modelId: 'gpt-5.5' }],
}

describe('applyModels', () => {
  it('round-trips the submitted tiers through routing.json', () => {
    const dir = freshRoot()
    applyModels(dir, CUSTOM_TIERS)
    expect(loadRoutingConfig(dir).tiers).toEqual(CUSTOM_TIERS)
    expect(loadOnboardingConfig(dir).steps.models).toBe('completed')
  })

  it('preserves providerKeys and dailyCapUsd already on disk', () => {
    const dir = freshRoot()
    const before = loadRoutingConfig(dir)
    saveRoutingConfig(dir, {
      ...before,
      providerKeys: { ...before.providerKeys, anthropic: 'secret://vault/anthropic' },
      dailyCapUsd: { triage: 1, reasoning: 2 },
    })

    applyModels(dir, CUSTOM_TIERS)

    const after = loadRoutingConfig(dir)
    expect(after.tiers).toEqual(CUSTOM_TIERS)
    expect(after.providerKeys.anthropic).toBe('secret://vault/anthropic')
    expect(after.dailyCapUsd).toEqual({ triage: 1, reasoning: 2 })
  })

  it('is idempotent across repeated applies', () => {
    const dir = freshRoot()
    applyModels(dir, CUSTOM_TIERS)
    applyModels(dir, CUSTOM_TIERS)
    expect(loadRoutingConfig(dir).tiers).toEqual(CUSTOM_TIERS)
    expect(loadOnboardingConfig(dir).steps.models).toBe('completed')
  })
})
