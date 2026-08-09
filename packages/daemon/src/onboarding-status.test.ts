import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Space } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConnectionsConfig } from './connections-config.ts'
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
      'model-connection',
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

  it('local-vps profile, incomplete wizard -> required (issue 023: same production auth as vps)', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'local-vps' }))
    expect(status.required).toBe(true)
    expect(status.completed).toBe(false)
  })

  it('local-vps profile, completed wizard -> not required', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, { version: 1, steps: { finish: 'completed' } })
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'local-vps' }))
    expect(status.required).toBe(false)
    expect(status.completed).toBe(true)
  })

  it('a legacy install whose finish step is completed still reports completed (issue #47: no retroactive lockout)', () => {
    const dir = freshRoot()
    // A file still shaped like a pre-issue-#47 install (byok/models step
    // ids on disk): `loadOnboardingConfig`'s `migrateLegacyStepIds` handles
    // this on load, but `finish: 'completed'` is untouched by that
    // migration either way — written directly as JSON since
    // `OnboardingConfigSchema`'s step enum no longer types `byok`/`models`.
    writeFileSync(
      join(dir, 'onboarding.json'),
      JSON.stringify({
        version: 1,
        steps: {
          domain: 'completed',
          byok: 'completed',
          models: 'completed',
          'first-space': 'completed',
          integrations: 'skipped',
          finish: 'completed',
        },
      }),
    )
    const status = buildOnboardingStatus(baseDeps(dir, { profile: 'vps' }))
    expect(status.completed).toBe(true)
    expect(status.required).toBe(false)
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
  it('resumes at first-space when model-connection is already completed', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: { domain: 'completed', 'model-connection': 'completed' },
    })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.currentStep).toBe('first-space')
  })

  it('treats a skipped model-connection step as passed for resume purposes', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: { domain: 'completed', 'model-connection': 'skipped' },
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
        'model-connection': 'skipped',
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

describe('buildOnboardingStatus: modelConnection resume state', () => {
  it('vaultAvailable false, connectedCount 0, no selection, mock off with nothing on disk', () => {
    const dir = freshRoot()
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.modelConnection).toEqual({
      vaultAvailable: false,
      connectedCount: 0,
      hasSelection: false,
      mockEnabled: false,
    })
  })

  it('vaultAvailable reflects an open vault regardless of connections.json', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const status = buildOnboardingStatus(baseDeps(dir, { vault }))
    expect(status.modelConnection.vaultAvailable).toBe(true)
  })

  it('counts only connected connections and reports a stored selection and mockEnabled', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: 'anthropic',
          method: 'anthropic-api-key',
          provider: 'anthropic',
          label: 'Claude',
          state: 'connected',
          stateAt: '2026-08-09T00:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-08-09T00:00:00.000Z',
        },
        {
          id: 'openai',
          method: 'openai-api-key',
          provider: 'openai',
          label: 'OpenAI',
          state: 'failed',
          stateAt: '2026-08-09T00:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-08-09T00:00:00.000Z',
        },
      ],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: true,
    })
    const status = buildOnboardingStatus(baseDeps(dir))
    expect(status.modelConnection).toEqual({
      vaultAvailable: false,
      connectedCount: 1,
      hasSelection: true,
      mockEnabled: true,
    })
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
