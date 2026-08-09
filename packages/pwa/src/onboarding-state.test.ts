import { fromPartial } from '@total-typescript/shoehorn'
import type { OnboardingStatus, OnboardingStepId, OnboardingStepStatus } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  currentStep,
  homeBlockedByStatusFailure,
  isStepDone,
  stepIndicator,
  visibleSteps,
  WIZARD_STEP_META,
} from './onboarding-state.ts'

const ALL_STEP_IDS: OnboardingStepId[] = [
  'migration',
  'domain',
  'model-connection',
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
    modelConnection: {
      vaultAvailable: true,
      connectedCount: 0,
      hasSelection: false,
      mockEnabled: false,
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
    const status = buildStatus({ currentStep: 'model-connection' })
    expect(currentStep(status)).toBe('model-connection')
  })

  it('falls back to the first pending step when currentStep is null', () => {
    const status = buildStatus({
      currentStep: null,
      steps: [
        { id: 'domain', status: 'completed' },
        { id: 'model-connection', status: 'completed' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(currentStep(status)).toBe('first-space')
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
        { id: 'model-connection', status: 'completed' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(stepIndicator(status)).toEqual({ index: 3, total: 5 })
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
        { id: 'model-connection', status: 'pending' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(stepIndicator(status)).toEqual({ index: 2, total: 6 })
  })
})

describe('isStepDone', () => {
  it('is true for completed and skipped steps, false for pending', () => {
    const status = buildStatus({
      steps: [
        { id: 'domain', status: 'completed' },
        { id: 'model-connection', status: 'skipped' },
        { id: 'first-space', status: 'pending' },
        { id: 'integrations', status: 'pending' },
        { id: 'finish', status: 'pending' },
      ],
    })
    expect(isStepDone(status, 'domain')).toBe(true)
    expect(isStepDone(status, 'model-connection')).toBe(true)
    expect(isStepDone(status, 'first-space')).toBe(false)
  })

  it('is false for a step id absent from status.steps (e.g. migration when not offered)', () => {
    const status = buildStatus({ steps: stepList(ALL_STEP_IDS.filter((id) => id !== 'migration')) })
    expect(isStepDone(status, 'migration')).toBe(false)
  })
})

describe('homeBlockedByStatusFailure', () => {
  it('blocks Home on production when the onboarding status fetch failed', () => {
    expect(
      homeBlockedByStatusFailure({
        authMode: 'production',
        hasToken: true,
        onboardingLoad: 'error',
      }),
    ).toBe(true)
  })

  it('blocks Home when auth mode is not yet known but a token is already stored (a stale reload)', () => {
    expect(
      homeBlockedByStatusFailure({ authMode: undefined, hasToken: true, onboardingLoad: 'error' }),
    ).toBe(true)
  })

  it('still fails open on loopback dev auth', () => {
    expect(
      homeBlockedByStatusFailure({ authMode: 'dev', hasToken: false, onboardingLoad: 'error' }),
    ).toBe(false)
  })

  it('fails open when auth mode is unknown and no token is stored', () => {
    expect(
      homeBlockedByStatusFailure({ authMode: undefined, hasToken: false, onboardingLoad: 'error' }),
    ).toBe(false)
  })

  it('never blocks Home while the status is loading or already ready', () => {
    expect(
      homeBlockedByStatusFailure({
        authMode: 'production',
        hasToken: true,
        onboardingLoad: 'loading',
      }),
    ).toBe(false)
    expect(
      homeBlockedByStatusFailure({
        authMode: 'production',
        hasToken: true,
        onboardingLoad: 'ready',
      }),
    ).toBe(false)
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

  it("model-connection copy states that Veduta keeps the Agent loop and data on the user's server", () => {
    expect(WIZARD_STEP_META['model-connection'].description).toContain('Agent loop')
    expect(WIZARD_STEP_META['model-connection'].description).toContain('your server')
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
