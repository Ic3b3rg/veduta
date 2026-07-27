import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import type { Space } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { saveOnboardingConfig } from './onboarding-config.ts'
import {
  ONBOARDING_STEP_ORDER,
  buildOnboardingStatus,
  detectLegacyAgents,
  type OnboardingStatusDeps,
} from './onboarding-status.ts'
import { SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-status-'))
  return rootDir
}

function baseDeps(
  dir: string,
  overrides: Partial<OnboardingStatusDeps> = {},
): OnboardingStatusDeps {
  return {
    rootDir: dir,
    profile: 'loopback',
    domain: null,
    tlsActive: false,
    listSpaces: () => [],
    env: {},
    ...overrides,
  }
}

describe('detectLegacyAgents', () => {
  it('reports nothing found and no sourceHome on a clean home', () => {
    const dir = freshRoot()
    expect(detectLegacyAgents(dir)).toEqual({ openclaw: false, hermes: false })
  })

  it('detects .openclaw and sets sourceHome', () => {
    const dir = freshRoot()
    mkdirSync(join(dir, '.openclaw'))
    expect(detectLegacyAgents(dir)).toEqual({ openclaw: true, hermes: false, sourceHome: dir })
  })

  it('detects .hermes and sets sourceHome', () => {
    const dir = freshRoot()
    mkdirSync(join(dir, '.hermes'))
    expect(detectLegacyAgents(dir)).toEqual({ openclaw: false, hermes: true, sourceHome: dir })
  })

  it('detects OpenClaw under its former names .clawdbot/.moltbot as openclaw', () => {
    const clawdbotDir = freshRoot()
    mkdirSync(join(clawdbotDir, '.clawdbot'))
    expect(detectLegacyAgents(clawdbotDir)).toEqual({
      openclaw: true,
      hermes: false,
      sourceHome: clawdbotDir,
    })
    rmSync(clawdbotDir, { recursive: true, force: true })

    const moltbotDir = freshRoot()
    mkdirSync(join(moltbotDir, '.moltbot'))
    expect(detectLegacyAgents(moltbotDir)).toEqual({
      openclaw: true,
      hermes: false,
      sourceHome: moltbotDir,
    })
  })
})

describe('ONBOARDING_STEP_ORDER', () => {
  it('lists every step in the structural order (first-space before integrations)', () => {
    expect(ONBOARDING_STEP_ORDER).toEqual([
      'migration',
      'domain',
      'byok',
      'models',
      'first-space',
      'integrations',
      'finish',
    ])
  })
})

describe('buildOnboardingStatus: required matrix', () => {
  it('vps profile, incomplete wizard -> required', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'vps' }))
    expect(status.required).toBe(true)
    expect(status.completed).toBe(false)
  })

  it('vps profile, completed wizard -> not required', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, { version: 1, steps: { finish: 'completed' } })
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'vps' }))
    expect(status.required).toBe(false)
    expect(status.completed).toBe(true)
  })

  it('loopback profile, incomplete wizard, no force -> not required', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'loopback' }))
    expect(status.required).toBe(false)
  })

  it('loopback profile with VEDUTA_ONBOARDING=force -> required', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(
      baseDeps(dir, { profile: 'loopback', env: { VEDUTA_ONBOARDING: 'force' } }),
    )
    expect(status.required).toBe(true)
  })

  it('loopback profile with a leftover incomplete onboarding.json is still not required', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, { version: 1, steps: { migration: 'completed', domain: 'pending' } })
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'loopback' }))
    expect(status.required).toBe(false)
  })
})

describe('buildOnboardingStatus: migration visibility', () => {
  it('omits migration from steps when no legacy install is detected', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.steps.map((step) => step.id)).not.toContain('migration')
    expect(status.currentStep).toBe('domain')
  })

  it('includes migration first when a legacy install was persisted by the installer', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {},
      legacy: { openclaw: true, hermes: false, sourceHome: '/home/alice' },
    })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.steps.map((step) => step.id)[0]).toBe('migration')
    expect(status.currentStep).toBe('migration')
    expect(status.legacy).toEqual({ openclaw: true, hermes: false, sourceHome: '/home/alice' })
  })

  it('falls back to detectLegacyAgents(VEDUTA_LEGACY_HOME) when no config.legacy is persisted', () => {
    const dir = freshRoot()
    const legacyHome = join(dir, 'legacy-home')
    mkdirSync(join(legacyHome, '.hermes'), { recursive: true })
    const status = buildOnboardingStatus(baseDeps(dir, { env: { VEDUTA_LEGACY_HOME: legacyHome } }))
    expect(status.legacy).toEqual({ openclaw: false, hermes: true, sourceHome: legacyHome })
    expect(status.steps.map((step) => step.id)[0]).toBe('migration')
  })
})

describe('buildOnboardingStatus: currentStep resume ordering', () => {
  it('resumes at models when byok is already completed', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, { version: 1, steps: { domain: 'completed', byok: 'completed' } })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.currentStep).toBe('models')
  })

  it('treats skipped steps as passed for resume purposes', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: { domain: 'completed', byok: 'skipped', models: 'completed' },
    })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.currentStep).toBe('first-space')
  })

  it('currentStep is null once every visible step is completed or skipped', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        byok: 'skipped',
        models: 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
        finish: 'completed',
      },
    })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.currentStep).toBeNull()
    expect(status.completed).toBe(true)
  })
})

describe('buildOnboardingStatus: installer summary', () => {
  it('omits installer when installer-stages.json is absent', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.installer).toBeUndefined()
  })

  it('includes installer when the file is valid', () => {
    const dir = freshRoot()
    writeFileSync(
      join(dir, 'installer-stages.json'),
      JSON.stringify({
        protocol_version: 1,
        stages: [{ id: 'preflight', title: 'Preflight', status: 'done' }],
        needs_user_input: false,
      }),
    )
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.installer).toEqual({
      protocol_version: 1,
      stages: [{ id: 'preflight', title: 'Preflight', status: 'done' }],
      needs_user_input: false,
    })
  })

  it('omits installer when the file is present but invalid JSON', () => {
    const dir = freshRoot()
    writeFileSync(join(dir, 'installer-stages.json'), '{not json')
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.installer).toBeUndefined()
  })

  it('omits installer when the file fails schema validation', () => {
    const dir = freshRoot()
    writeFileSync(join(dir, 'installer-stages.json'), JSON.stringify({ protocol_version: 2 }))
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.installer).toBeUndefined()
  })
})

describe('buildOnboardingStatus: byok hasKey', () => {
  it('vaultAvailable is false and every hasKey is false when no vault is open', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.byok.vaultAvailable).toBe(false)
    expect(status.byok.providers).toEqual([
      { provider: 'anthropic', hasKey: false },
      { provider: 'openai', hasKey: false },
      { provider: 'openrouter', hasKey: false },
    ])
  })

  it('reflects hasKey from a real SecretsVault', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('anthropic', 'sk-ant-test-key')
    const status = buildOnboardingStatus(baseDeps(dir, { vault }))
    expect(status.byok.vaultAvailable).toBe(true)
    expect(status.byok.providers).toEqual([
      { provider: 'anthropic', hasKey: true },
      { provider: 'openai', hasKey: false },
      { provider: 'openrouter', hasKey: false },
    ])
  })

  it('reflects hasKey from a fromPartial vault double', () => {
    const dir = freshRoot()
    const vault = fromPartial<SecretsVault>({
      has: (name: string) => name === 'openai',
      resolve: () => undefined,
    })
    const status = buildOnboardingStatus(baseDeps(dir, { vault }))
    expect(status.byok.providers).toEqual([
      { provider: 'anthropic', hasKey: false },
      { provider: 'openai', hasKey: true },
      { provider: 'openrouter', hasKey: false },
    ])
  })
})

describe('buildOnboardingStatus: firstSpace and integrations', () => {
  it('suggests Personal with no existing spaces by default', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.firstSpace).toEqual({ suggestedName: 'Personal', existingSpaces: [] })
    expect(status.integrations).toEqual({
      gmail: { configured: false, hasCredentials: false },
      calendar: { configured: false, hasCredentials: false },
    })
  })

  it('lists non-archived spaces and the recorded firstSpace name', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {},
      firstSpace: { name: 'Health', slug: 'health' },
    })
    const spaces: Space[] = [
      { id: 'spc-health', slug: 'health', name: 'Health', archived: false },
      { id: 'spc-old', slug: 'old', name: 'Old', archived: true },
    ]
    const status = buildOnboardingStatus(baseDeps(dir, { listSpaces: () => spaces }))
    expect(status.firstSpace).toEqual({
      suggestedName: 'Health',
      existingSpaces: [{ id: 'spc-health', slug: 'health', name: 'Health' }],
    })
  })
})
