import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConnectionsConfig, type ConnectionsFile } from './connections-config.ts'
import { saveRoutingConfig, type SecretResolver } from './model-routing.ts'
import { loadOnboardingConfig } from './onboarding-config.ts'
import {
  applyModelConnectionStep,
  assertModelConnectionReady,
} from './onboarding-step-model-connection.ts'
import { OnboardingStepError } from './onboarding-status.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-model-connection-'))
  return rootDir
}

const noSecrets: SecretResolver = { resolve: () => undefined }

function resolverFor(values: Record<string, string>): SecretResolver {
  return { resolve: (ref) => values[ref] }
}

const connectedAnthropic: ConnectionsFile['connections'][number] = {
  id: 'anthropic',
  method: 'anthropic-api-key',
  provider: 'anthropic',
  label: 'Claude',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
  selectedModelId: 'claude-sonnet-5',
}

describe('assertModelConnectionReady', () => {
  it('loopback always passes, even with nothing connected', () => {
    const dir = freshRoot()
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'loopback', secrets: noSecrets }),
    ).not.toThrow()
  })

  it('refuses on the vps profile with no connected connection', () => {
    const dir = freshRoot()
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets }),
    ).toThrow(OnboardingStepError)
    try {
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets })
      expect.fail('expected a throw')
    } catch (error) {
      expect((error as OnboardingStepError).statusCode).toBe(409)
      expect((error as OnboardingStepError).message).toBe(
        'connect a Model connection and select a model before continuing',
      )
    }
  })

  it('refuses on vps when a connection is connected but nothing is selected', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [connectedAnthropic],
      mockEnabled: false,
    })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets }),
    ).toThrow(OnboardingStepError)
  })

  it('passes on vps with a connected connection and stored selection', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [connectedAnthropic],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets }),
    ).not.toThrow()
  })

  it('refuses on vps when the stored selection points at a connection that is not connected', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [{ ...connectedAnthropic, state: 'expired' }],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets }),
    ).toThrow(OnboardingStepError)
  })

  it('a failed explicit selection blocks the step even when a legacy provider key resolves', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [{ ...connectedAnthropic, state: 'expired' }],
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
    // this resolvable legacy key and incorrectly pass.
    const secrets = resolverFor({ 'secret://env/ANTHROPIC_API_KEY': 'sk-real-key' })

    expect(() => assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets })).toThrow(
      OnboardingStepError,
    )
  })

  it('an explicit selection with an opted-in connected fallback still passes', () => {
    const dir = freshRoot()
    const fallback: ConnectionsFile['connections'][number] = {
      id: 'openai',
      method: 'openai-api-key',
      provider: 'openai',
      label: 'OpenAI',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: true,
      createdAt: '2026-08-09T00:00:00.000Z',
      selectedModelId: 'gpt-5.5',
    }
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [{ ...connectedAnthropic, state: 'expired' }, fallback],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })

    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets: noSecrets }),
    ).not.toThrow()
  })

  it('passes on vps via the legacy routing fallback when a reasoning key resolves', () => {
    const dir = freshRoot()
    // No connections.json at all -- a pre-Model-connections install that
    // still has a real provider key in routing.json's providerKeys.
    const secrets = resolverFor({ 'secret://env/ANTHROPIC_API_KEY': 'sk-real-key' })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'vps', secrets }),
    ).not.toThrow()
  })

  it('local-vps passes when mockEnabled is true, even with no connection at all', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, { version: 1, connections: [], mockEnabled: true })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'local-vps', secrets: noSecrets }),
    ).not.toThrow()
  })

  it('local-vps still refuses when mockEnabled is false and nothing is connected', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, { version: 1, connections: [], mockEnabled: false })
    expect(() =>
      assertModelConnectionReady({ rootDir: dir, profile: 'local-vps', secrets: noSecrets }),
    ).toThrow(OnboardingStepError)
  })
})

describe('applyModelConnectionStep', () => {
  it('accepts useMock on local-vps: turns the mock control on, then completes the step', () => {
    const dir = freshRoot()
    applyModelConnectionStep(
      { rootDir: dir, profile: 'local-vps', secrets: noSecrets },
      { useMock: true },
    )
    const config = loadOnboardingConfig(dir)
    expect(config.steps['model-connection']).toBe('completed')
  })

  it('refuses useMock on vps with the exact message, and never completes the step', () => {
    const dir = freshRoot()
    let caught: unknown
    try {
      applyModelConnectionStep(
        { rootDir: dir, profile: 'vps', secrets: noSecrets },
        { useMock: true },
      )
      expect.fail('expected a throw')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OnboardingStepError)
    expect((caught as OnboardingStepError).message).toBe(
      'the development mock control is available only on the Local VPS profile',
    )
    expect((caught as OnboardingStepError).statusCode).toBe(409)
    expect(loadOnboardingConfig(dir).steps['model-connection']).toBeUndefined()
  })

  it('is a no-op on loopback: completes the step without touching connections.json', () => {
    const dir = freshRoot()
    applyModelConnectionStep(
      { rootDir: dir, profile: 'loopback', secrets: noSecrets },
      { useMock: true },
    )
    expect(loadOnboardingConfig(dir).steps['model-connection']).toBe('completed')
  })

  it('refuses to complete on vps with no connection, and never writes the step', () => {
    const dir = freshRoot()
    expect(() =>
      applyModelConnectionStep({ rootDir: dir, profile: 'vps', secrets: noSecrets }, {}),
    ).toThrow(OnboardingStepError)
    expect(loadOnboardingConfig(dir).steps['model-connection']).toBeUndefined()
  })

  it('completes on vps once a connected connection has a stored selection', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [connectedAnthropic],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })
    applyModelConnectionStep({ rootDir: dir, profile: 'vps', secrets: noSecrets }, {})
    expect(loadOnboardingConfig(dir).steps['model-connection']).toBe('completed')
  })

  it('completes via the legacy routing fallback with no connections.json at all', () => {
    const dir = freshRoot()
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
    applyModelConnectionStep({ rootDir: dir, profile: 'vps', secrets }, {})
    expect(loadOnboardingConfig(dir).steps['model-connection']).toBe('completed')
  })
})
