import { fromPartial } from '@total-typescript/shoehorn'
import type { OnboardingStatus, OnboardingStepId, OnboardingStepStatus } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  byokKeepExistingAvailable,
  currentStep,
  defaultTierSelections,
  isStepDone,
  stepIndicator,
  visibleSteps,
  WIZARD_STEP_META,
} from './onboarding-state.ts'

const ALL_STEP_IDS: OnboardingStepId[] = [
  'migration',
  'domain',
  'byok',
  'models',
  'first-space',
  'integrations',
  'finish',
]

function stepList(
  ids: OnboardingStepId[],
  statusOf: (id: OnboardingStepId) => OnboardingStepStatus = () => 'pending',
): { id: OnboardingStepId; status: OnboardingStepStatus }[] {
  return ids.map((id) => ({ id, status: statusOf(id) }))
}

function buildStatus(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return fromPartial<OnboardingStatus>({
    required: true,
    completed: false,
    profile: 'vps',
    currentStep: null,
    steps: stepList(ALL_STEP_IDS.filter((id) => id !== 'migration')),
    legacy: { openclaw: false, hermes: false },
    domain: { domain: 'example.com', tlsActive: true },
    byok: {
      vaultAvailable: true,
      providers: [
        { provider: 'anthropic', hasKey: false },
        { provider: 'openai', hasKey: false },
        { provider: 'openrouter', hasKey: false },
      ],
    },
    models: {
      tiers: {
        triage: [{ provider: 'anthropic', modelId: 'claude-haiku' }],
        reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet' }],
      },
    },
    firstSpace: { suggestedName: 'Home', existingSpaces: [] },
    integrations: {
      gmail: { configured: false, hasCredentials: false },
      calendar: { configured: false, hasCredentials: false },
    },
    ...overrides,
  })
}

describe('visibleSteps', () => {
  it('omits migration when no legacy install is offered', () => {
    const status = buildStatus({ steps: stepList(ALL_STEP_IDS.filter((id) => id !== 'migration')) })
    expect(visibleSteps(status)).not.toContain('migration')
  })

  it('includes migration first when a legacy install was detected', () => {
    const status = buildStatus({
      steps: stepList(ALL_STEP_IDS),
      legacy: { openclaw: true, hermes: false, sourceHome: '/home/admin' },
    })
    expect(visibleSteps(status)).toEqual(ALL_STEP_IDS)
  })
})

describe('currentStep (resume)', () => {
  it('trusts status.currentStep when present', () => {
    const status = buildStatus({ currentStep: 'byok' })
    expect(currentStep(status)).toBe('byok')
  })

  it('falls back to the first pending step when currentStep is null', () => {
    const status = buildStatus({
      currentStep: null,
      steps: [
        { id: 'domain', status: 'completed' },
        { id: 'byok', status: 'completed' },
        { id: 'models', status: 'pending' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(currentStep(status)).toBe('models')
  })

  it('returns null when every step is done and currentStep is null', () => {
    const status = buildStatus({
      currentStep: null,
      completed: true,
      steps: stepList(
        ALL_STEP_IDS.filter((id) => id !== 'migration'),
        () => 'completed',
      ),
    })
    expect(currentStep(status)).toBeNull()
  })
})

describe('stepIndicator', () => {
  it('reports 1-based position and total for a mid-flow resume', () => {
    const status = buildStatus({
      currentStep: null,
      steps: [
        { id: 'domain', status: 'completed' },
        { id: 'byok', status: 'completed' },
        { id: 'models', status: 'pending' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(stepIndicator(status)).toEqual({ index: 3, total: 6 })
  })

  it('reports index past the end when the wizard is fully done', () => {
    const steps = stepList(
      ALL_STEP_IDS.filter((id) => id !== 'migration'),
      () => 'completed',
    )
    const status = buildStatus({ currentStep: null, completed: true, steps })
    expect(stepIndicator(status)).toEqual({ index: steps.length, total: steps.length })
  })

  it('accounts for migration occupying the first slot when present', () => {
    const status = buildStatus({
      currentStep: 'domain',
      steps: [
        { id: 'migration', status: 'completed' },
        { id: 'domain', status: 'pending' },
        { id: 'byok', status: 'pending' },
        { id: 'models', status: 'pending' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(stepIndicator(status)).toEqual({ index: 2, total: 7 })
  })
})

describe('isStepDone', () => {
  it('is true for completed and skipped steps, false for pending', () => {
    const status = buildStatus({
      steps: [
        { id: 'domain', status: 'completed' },
        { id: 'byok', status: 'skipped' },
        { id: 'models', status: 'pending' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(isStepDone(status, 'domain')).toBe(true)
    expect(isStepDone(status, 'byok')).toBe(true)
    expect(isStepDone(status, 'models')).toBe(false)
  })

  it('is false for a step id absent from status.steps (e.g. migration when not offered)', () => {
    const status = buildStatus({ steps: stepList(ALL_STEP_IDS.filter((id) => id !== 'migration')) })
    expect(isStepDone(status, 'migration')).toBe(false)
  })
})

describe('byokKeepExistingAvailable', () => {
  it('is true only when the provider already has a stored key', () => {
    const status = buildStatus({
      byok: {
        vaultAvailable: true,
        providers: [
          { provider: 'anthropic', hasKey: true },
          { provider: 'openai', hasKey: false },
          { provider: 'openrouter', hasKey: false },
        ],
      },
    })
    expect(byokKeepExistingAvailable(status, 'anthropic')).toBe(true)
    expect(byokKeepExistingAvailable(status, 'openai')).toBe(false)
  })

  it('is false for a provider missing from status.byok.providers', () => {
    const status = buildStatus({ byok: { vaultAvailable: true, providers: [] } })
    expect(byokKeepExistingAvailable(status, 'anthropic')).toBe(false)
  })
})

describe('defaultTierSelections', () => {
  it('passes through the daemon-reported tier assignments unchanged', () => {
    const tiers = {
      triage: [{ provider: 'openai', modelId: 'gpt-mini' }],
      reasoning: [{ provider: 'openai', modelId: 'gpt-strong' }],
    }
    const status = buildStatus({ models: { tiers } })
    expect(defaultTierSelections(status)).toEqual(tiers)
  })
})

describe('WIZARD_STEP_META completeness', () => {
  it('has a non-empty title and description for every step id', () => {
    for (const id of ALL_STEP_IDS) {
      const meta = WIZARD_STEP_META[id]
      expect(meta.title.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
    }
  })

  it('domain copy states the exact systemd drop-in command', () => {
    expect(WIZARD_STEP_META.domain.description).toContain('systemctl edit veduta')
  })

  it('byok skip-consequence copy states the exact vault CLI command', () => {
    expect(WIZARD_STEP_META.byok.description).toContain('vault set')
  })

  it('integrations copy states the exact Google Cloud console URL and gcloud pubsub commands', () => {
    const { description } = WIZARD_STEP_META.integrations
    expect(description).toContain('https://console.cloud.google.com')
    expect(description).toContain('gcloud pubsub topics create')
    expect(description).toContain('gcloud pubsub subscriptions create')
    expect(description).toContain('--push-endpoint=https://<domain>/api/ingest/gmail')
    expect(description).toContain('gmail-api-push@system.gserviceaccount.com')
  })
})
