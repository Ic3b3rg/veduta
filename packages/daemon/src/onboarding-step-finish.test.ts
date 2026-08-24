import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveConnectionsConfig } from './connections-config.ts'
import { saveRoutingConfig, type SecretResolver } from './model-routing.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'
import { applyFinish as applyFinishImpl, type FinishDeps } from './onboarding-step-finish.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-finish-'))
  return rootDir
}

const noSecrets: SecretResolver = { resolve: () => undefined }
const primaryRoutableMethods = new Set([
  'anthropic-api-key',
  'openai-api-key',
  'openrouter-api-key',
  'chatgpt-codex',
] as const)

type FinishDepsInput = Omit<FinishDeps, 'primaryRoutableMethods'>

function applyFinish(deps: FinishDepsInput) {
  return applyFinishImpl({ ...deps, primaryRoutableMethods })
}

function resolverFor(values: Record<string, string>): SecretResolver {
  return { resolve: (ref) => values[ref] }
}

/**
 * Every visible step other than `finish` already completed/skipped, so
 * `applyFinish`'s completion gate lets the call through. `migration` is not
 * included: with no `legacy` recorded and `VEDUTA_LEGACY_HOME` pinned to a
 * clean temp dir (see `env` below), it is never part of the visible set.
 * Also stamps a `connections.json` with the Local VPS development mock
 * control on (issue #47): `assertModelConnectionReady`'s own last check
 * needs a satisfied Model connection gate independent of the step statuses
 * above it, and `mockEnabled` satisfies every profile these tests exercise
 * (`loopback` never checks it; `local-vps` and `vps` fixtures below add
 * their own connection instead where the mock control does not apply).
 */
function completeAllPriorSteps(dir: string): void {
  saveOnboardingConfig(dir, {
    version: 1,
    steps: {
      domain: 'completed',
      'model-connection': 'completed',
      'first-space': 'completed',
      integrations: 'skipped',
    },
  })
}

/** A `connected` connection with a stored selection — satisfies `assertModelConnectionReady` on every profile, including `vps` where the mock control does not exist. */
function connectAndSelectAnthropic(dir: string): void {
  saveConnectionsConfig(dir, {
    version: 1,
    connections: [
      {
        id: 'anthropic',
        method: 'anthropic-api-key',
        provider: 'anthropic',
        label: 'Claude',
        state: 'connected',
        stateAt: '2026-07-24T10:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-07-24T10:00:00.000Z',
        selectedModelId: 'claude-sonnet-5',
      },
    ],
    selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
    mockEnabled: false,
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
      secrets: noSecrets,
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
    connectAndSelectAnthropic(dir)
    let scheduleExitCalls = 0

    const response = applyFinish({
      rootDir: dir,
      profile: 'vps',
      env: { VEDUTA_LEGACY_HOME: dir },
      secrets: noSecrets,
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
    saveConnectionsConfig(dir, { version: 1, connections: [], mockEnabled: true })
    let scheduleExitCalls = 0

    const response = applyFinish({
      rootDir: dir,
      profile: 'local-vps',
      env: { VEDUTA_LEGACY_HOME: dir },
      secrets: noSecrets,
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
      secrets: noSecrets,
      now: () => new Date('2026-07-24T10:00:00.000Z'),
    })
    applyFinish({
      rootDir: dir,
      profile: 'loopback',
      scheduleExit,
      env,
      secrets: noSecrets,
      now: () => new Date('2026-07-24T11:00:00.000Z'),
    })

    const config = loadOnboardingConfig(dir)
    expect(config.steps.finish).toBe('completed')
    expect(config.completedAt).toBe('2026-07-24T11:00:00.000Z')
  })

  it('completion gate: a pending model-connection step throws an OnboardingStepError naming it, with a 409 status code', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        // model-connection left pending.
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
        secrets: noSecrets,
      })
      expect.fail('expected applyFinish to throw')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OnboardingStepError)
    expect((caught as OnboardingStepError).statusCode).toBe(409)
    expect((caught as OnboardingStepError).message).toContain('model-connection')
    // Nothing was persisted: a rejected finish must not mark the wizard done.
    expect(loadOnboardingConfig(dir).steps.finish).toBeUndefined()
  })

  it('completion gate: migration counts too when a legacy install was detected', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        'model-connection': 'skipped',
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
        secrets: noSecrets,
      }),
    ).toThrow(/migration/)
  })

  it('refuses on vps until a Model connection is connected and selected, even with every other step completed', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    // No connections.json at all, and no legacy providerKeys resolve
    // (noSecrets) -- the completion gate above passes (every OTHER step is
    // done) but the Model connection readiness gate must still refuse.
    expect(() =>
      applyFinish({
        rootDir: dir,
        profile: 'vps',
        scheduleExit: vi.fn(),
        env: { VEDUTA_LEGACY_HOME: dir },
        secrets: noSecrets,
      }),
    ).toThrow(OnboardingStepError)
    expect(loadOnboardingConfig(dir).steps.finish).toBeUndefined()
  })

  it('a failed explicit selection blocks finishing even when a legacy provider key resolves', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: 'anthropic',
          method: 'anthropic-api-key',
          provider: 'anthropic',
          label: 'Claude',
          state: 'expired',
          stateAt: '2026-07-24T10:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-07-24T10:00:00.000Z',
          selectedModelId: 'claude-sonnet-5',
        },
      ],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      tiers: {
        triage: [{ provider: 'anthropic', modelId: 'claude-haiku-4-5' }],
        reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet-5' }],
      },
      providerKeys: { anthropic: 'secret://env/ANTHROPIC_API_KEY' },
      connectionKeys: {},
      dailyCapUsd: { triage: 5, reasoning: 20 },
    })
    // Before the fix, a defined `file.selection` would still fall through to
    // this resolvable legacy key and incorrectly let finish complete.
    const secrets = resolverFor({ 'secret://env/ANTHROPIC_API_KEY': 'sk-real-key' })

    expect(() =>
      applyFinish({
        rootDir: dir,
        profile: 'vps',
        scheduleExit: vi.fn(),
        env: { VEDUTA_LEGACY_HOME: dir },
        secrets,
      }),
    ).toThrow(OnboardingStepError)
    expect(loadOnboardingConfig(dir).steps.finish).toBeUndefined()
  })

  it('a selectionless migrated route cannot finish when its method is excluded from the primary route', () => {
    const dir = freshRoot()
    completeAllPriorSteps(dir)
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: 'anthropic',
          method: 'claude-subscription',
          provider: 'anthropic',
          label: 'Claude · Subscription',
          state: 'connected',
          stateAt: '2026-07-24T10:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-07-24T10:00:00.000Z',
          selectedModelId: 'claude-sonnet-5',
        },
      ],
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      tiers: {
        triage: [{ provider: 'anthropic', modelId: 'claude-haiku-4-5' }],
        reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet-5' }],
      },
      providerKeys: { anthropic: 'secret://env/ANTHROPIC_API_KEY' },
      connectionKeys: {},
      dailyCapUsd: { triage: 5, reasoning: 20 },
    })
    const secrets = resolverFor({ 'secret://env/ANTHROPIC_API_KEY': 'sk-real-key' })

    expect(() =>
      applyFinishImpl({
        rootDir: dir,
        profile: 'vps',
        scheduleExit: vi.fn(),
        env: { VEDUTA_LEGACY_HOME: dir },
        secrets,
        primaryRoutableMethods: new Set(['anthropic-api-key']),
      }),
    ).toThrow(OnboardingStepError)
    expect(loadOnboardingConfig(dir).steps.finish).toBeUndefined()
  })
})
