import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'
import { applyFinish } from './onboarding-step-finish.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-finish-'))
  return rootDir
}

/**
 * Every visible step other than `finish` already completed/skipped, so
 * `applyFinish`'s completion gate lets the call through. `migration` is not
 * included: with no `legacy` recorded and `VEDUTA_LEGACY_HOME` pinned to a
 * clean temp dir (see `env` below), it is never part of the visible set.
 */
function completeAllPriorSteps(dir: string): void {
  saveOnboardingConfig(dir, {
    version: 1,
    steps: {
      domain: 'completed',
      byok: 'skipped',
      models: 'completed',
      'first-space': 'completed',
      integrations: 'skipped',
    },
  })
}

describe('applyFinish', () => {
  it('loopback: completes the step, does not call scheduleExit, and reports restarting: false', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    const scheduleExit = vi.fn()
    const response = applyFinish({
      rootDir: dir,
      profile: 'loopback',
      scheduleExit,
      env: { VEDUTA_LEGACY_HOME: dir },
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    })

    expect(response).toEqual({ restartRequired: true, restarting: false })
    expect(scheduleExit).not.toHaveBeenCalled()

    const config = loadOnboardingConfig(dir)
    expect(config.steps.finish).toBe('completed')
    expect(config.completedAt).toBe('2026-07-24T10:00:00.000Z')
  })

  it('vps: completes the step, saves the config, THEN calls scheduleExit, and reports restarting: true', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    let scheduleExitCalls = 0

    const response = applyFinish({
      rootDir: dir,
      profile: 'vps',
      env: { VEDUTA_LEGACY_HOME: dir },
      scheduleExit: () => {
        // By the time scheduleExit runs, the config must already be durable.
        scheduleExitCalls += 1
        expect(loadOnboardingConfig(dir).steps.finish).toBe('completed')
      },
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    })

    expect(response).toEqual({ restartRequired: true, restarting: true })
    expect(scheduleExitCalls).toBe(1)
  })

  it('local-vps: completes the step, saves the config, THEN calls scheduleExit, and reports restarting: true (issue 023: the Local VPS runner loop plays the systemd role)', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    let scheduleExitCalls = 0

    const response = applyFinish({
      rootDir: dir,
      profile: 'local-vps',
      env: { VEDUTA_LEGACY_HOME: dir },
      scheduleExit: () => {
        // By the time scheduleExit runs, the config must already be durable.
        scheduleExitCalls += 1
        expect(loadOnboardingConfig(dir).steps.finish).toBe('completed')
      },
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    })

    expect(response).toEqual({ restartRequired: true, restarting: true })
    expect(scheduleExitCalls).toBe(1)
  })

  it('is idempotent: re-applying after completion still completes and updates completedAt', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    const scheduleExit = vi.fn()
    const env = { VEDUTA_LEGACY_HOME: dir }
    applyFinish({
      rootDir: dir,
      profile: 'loopback',
      scheduleExit,
      env,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    })
    applyFinish({
      rootDir: dir,
      profile: 'loopback',
      scheduleExit,
      env,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    })

    const config = loadOnboardingConfig(dir)
    expect(config.steps.finish).toBe('completed')
    expect(config.completedAt).toBe('2026-07-24T11:00:00.000Z')
  })

  it('completion gate: a pending byok step throws an OnboardingStepError naming byok, with a 409 status code', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        // byok left pending.
        models: 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })

    let caught: unknown
    try {
      applyFinish({
        rootDir: dir,
        profile: 'loopback',
        scheduleExit: vi.fn(),
        env: { VEDUTA_LEGACY_HOME: dir },
      })
      expect.fail('expected applyFinish to throw')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OnboardingStepError)
    expect((caught as OnboardingStepError).statusCode).toBe(409)
    expect((caught as OnboardingStepError).message).toContain('byok')
    // Nothing was persisted: a rejected finish must not mark the wizard done.
    expect(loadOnboardingConfig(dir).steps.finish).toBeUndefined()
  })

  it('completion gate: migration counts too when a legacy install was detected', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        byok: 'skipped',
        models: 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
      legacy: { openclaw: true, hermes: false, sourceHome: '/home/alice' },
    })

    expect(() =>
      applyFinish({
        rootDir: dir,
        profile: 'loopback',
        scheduleExit: vi.fn(),
        env: { VEDUTA_LEGACY_HOME: dir },
      }),
    ).toThrow(/migration/)
  })
})
