import { describe, expect, it } from 'vitest'
import {
  ByokApplyRequestSchema,
  CalendarIntegrationRequestSchema,
  InstallerStageEventSchema,
  IntegrationsApplyRequestSchema,
  OnboardingProfileSchema,
  OnboardingStepIdSchema,
  OnboardingStatusSchema,
} from './onboarding.ts'

describe('OnboardingStepIdSchema', () => {
  it('accepts every documented step id', () => {
    for (const id of [
      'migration',
      'domain',
      'byok',
      'models',
      'first-space',
      'integrations',
      'finish',
    ]) {
      expect(OnboardingStepIdSchema.safeParse(id).success).toBe(true)
    }
  })

  it('rejects an unknown step id', () => {
    expect(OnboardingStepIdSchema.safeParse('legacy-detect').success).toBe(false)
  })
})

describe('OnboardingProfileSchema', () => {
  it('accepts every documented profile, including local-vps (issue 023)', () => {
    for (const profile of ['loopback', 'local-vps', 'vps']) {
      expect(OnboardingProfileSchema.safeParse(profile).success).toBe(true)
    }
  })

  it('rejects an unknown profile', () => {
    expect(OnboardingProfileSchema.safeParse('production').success).toBe(false)
  })
})

describe('OnboardingStatusSchema', () => {
  const validStatus = {
    required: true,
    completed: false,
    profile: 'vps' as const,
    currentStep: 'byok' as const,
    steps: [
      { id: 'migration', status: 'skipped' },
      { id: 'domain', status: 'completed' },
      { id: 'byok', status: 'pending' },
      { id: 'models', status: 'pending' },
      { id: 'first-space', status: 'pending' },
      { id: 'integrations', status: 'pending' },
      { id: 'finish', status: 'pending' },
    ],
    legacy: { openclaw: false, hermes: true, sourceHome: '/home/silvio' },
    domain: { domain: 'veduta.example.com', tlsActive: true },
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
    firstSpace: {
      suggestedName: 'Home',
      existingSpaces: [],
    },
    integrations: {
      gmail: { configured: false, hasCredentials: false },
      calendar: { configured: false, hasCredentials: false },
    },
  }

  it('round-trips a realistic status payload', () => {
    expect(OnboardingStatusSchema.parse(validStatus)).toEqual(validStatus)
  })

  it('accepts an optional installer stage summary', () => {
    const withInstaller = {
      ...validStatus,
      installer: {
        protocol_version: 1 as const,
        stages: [{ id: 'preflight', title: 'Preflight checks', status: 'done' as const }],
        needs_user_input: false,
      },
    }
    expect(OnboardingStatusSchema.safeParse(withInstaller).success).toBe(true)
  })

  it('rejects a status with an unknown current step', () => {
    expect(
      OnboardingStatusSchema.safeParse({ ...validStatus, currentStep: 'legacy-detect' }).success,
    ).toBe(false)
  })

  it('accepts profile: local-vps (issue 023)', () => {
    const withLocalVps = { ...validStatus, profile: 'local-vps' as const }
    expect(OnboardingStatusSchema.safeParse(withLocalVps).success).toBe(true)
  })

  it('accepts non-secret resume defaults for gmail and calendar', () => {
    const withResumeDefaults = {
      ...validStatus,
      integrations: {
        gmail: {
          configured: true,
          hasCredentials: true,
          clientId: 'gmail-client-id.apps.googleusercontent.com',
          topicName: 'projects/p/topics/gmail',
          subscription: 'projects/p/subscriptions/gmail',
        },
        calendar: {
          configured: true,
          hasCredentials: true,
          clientId: 'calendar-client-id.apps.googleusercontent.com',
          calendarId: 'primary',
        },
      },
    }
    expect(OnboardingStatusSchema.safeParse(withResumeDefaults).success).toBe(true)
  })
})

describe('InstallerStageEventSchema', () => {
  it('parses a realistic multi-stage event mid-install', () => {
    const event = {
      protocol_version: 1,
      stages: [
        { id: 'preflight', title: 'Preflight checks', status: 'done' },
        { id: 'legacy-detect', title: 'Detect legacy install', status: 'done' },
        { id: 'deps', title: 'Install dependencies', status: 'running' },
        { id: 'user-layout', title: 'Create veduta user + layout', status: 'pending' },
        { id: 'checkout', title: 'Checkout repository', status: 'pending' },
        { id: 'build', title: 'Build', status: 'pending' },
        { id: 'vault-keyfile', title: 'Provision vault keyfile', status: 'pending' },
        { id: 'systemd-unit', title: 'Install systemd unit', status: 'pending' },
        { id: 'first-boot', title: 'First boot', status: 'pending' },
        { id: 'pairing', title: 'Print pairing QR', status: 'pending' },
      ],
      needs_user_input: false,
    }

    expect(InstallerStageEventSchema.parse(event)).toEqual(event)
  })

  it('rejects a protocol_version other than 1', () => {
    expect(
      InstallerStageEventSchema.safeParse({
        protocol_version: 2,
        stages: [{ id: 'preflight', title: 'Preflight checks', status: 'pending' }],
        needs_user_input: true,
      }).success,
    ).toBe(false)
  })

  it('rejects an empty stages array', () => {
    expect(
      InstallerStageEventSchema.safeParse({
        protocol_version: 1,
        stages: [],
        needs_user_input: true,
      }).success,
    ).toBe(false)
  })
})

describe('ByokApplyRequestSchema', () => {
  it('accepts the skip branch', () => {
    expect(ByokApplyRequestSchema.safeParse({ skip: true }).success).toBe(true)
  })

  it('accepts a provider with no key (keep-existing sentinel)', () => {
    expect(ByokApplyRequestSchema.safeParse({ provider: 'anthropic' }).success).toBe(true)
  })

  it('rejects an empty-string key', () => {
    expect(ByokApplyRequestSchema.safeParse({ provider: 'anthropic', key: '' }).success).toBe(false)
  })
})

describe('IntegrationsApplyRequestSchema', () => {
  it('accepts the skip branch', () => {
    expect(IntegrationsApplyRequestSchema.safeParse({ skip: true }).success).toBe(true)
  })

  it('accepts gmail only', () => {
    expect(
      IntegrationsApplyRequestSchema.safeParse({
        gmail: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'refresh-token',
          topicName: 'veduta-gmail',
          subscription: 'veduta-gmail-sub',
        },
      }).success,
    ).toBe(true)
  })

  it('rejects the object branch with neither gmail nor calendar', () => {
    expect(IntegrationsApplyRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('CalendarIntegrationRequestSchema', () => {
  it('defaults calendarId to "primary" when omitted', () => {
    const parsed = CalendarIntegrationRequestSchema.parse({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    })
    expect(parsed.calendarId).toBe('primary')
  })

  it('keeps an explicit calendarId', () => {
    const parsed = CalendarIntegrationRequestSchema.parse({
      clientId: 'client-id',
      calendarId: 'work@example.com',
    })
    expect(parsed.calendarId).toBe('work@example.com')
  })
})
