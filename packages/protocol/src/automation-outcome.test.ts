import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeInputSchema,
  AutomationOutcomeNotificationActionResultSchema,
  AutomationOutcomeNotificationSnapshotSchema,
  AutomationOutcomeStatusSchema,
  AutomationOutcomeStatusesSchema,
  surfacePath,
} from './index.ts'

describe('Automation outcome protocol', () => {
  it.each([
    { kind: 'unchanged', summary: 'No new entries' },
    {
      kind: 'changed',
      summary: 'Two new entries',
      coalesceKey: 'new-entries',
      operations: [{ target: 'state', op: 'replace', path: '/entries', value: 2 }],
    },
    {
      kind: 'failed',
      summary: 'Refresh failed',
      coalesceKey: 'refresh-failed',
      error: { code: 'source_unavailable', message: 'The source could not be reached.' },
    },
    {
      kind: 'recovered',
      summary: 'Refresh recovered',
      coalesceKey: 'refresh-recovered',
      operations: [{ target: 'state', op: 'add', path: '/entries', value: [] }],
    },
    { kind: 'decision-required', summary: 'Choose an account', decisionId: 'choice:account-1' },
  ])('accepts the $kind result', (outcome) => {
    expect(AutomationOutcomeInputSchema.safeParse(outcome).success).toBe(true)
  })

  it('rejects tree writes and attempts to overwrite daemon-owned status', () => {
    expect(
      AutomationOutcomeInputSchema.safeParse({
        kind: 'changed',
        summary: 'Changed',
        coalesceKey: 'changed',
        operations: [
          { target: 'tree', op: 'remove', path: '/children/0' },
          {
            target: 'state',
            op: 'replace',
            path: `/${AUTOMATION_OUTCOMES_STATE_KEY}/12`,
            value: {},
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('bounds externally influenced text and notification counts', () => {
    expect(
      AutomationOutcomeInputSchema.safeParse({ kind: 'unchanged', summary: 'x'.repeat(241) })
        .success,
    ).toBe(false)
    expect(
      AutomationOutcomeNotificationSnapshotSchema.safeParse({
        revision: 2,
        notifications: [notification({ occurrenceCount: 0 })],
      }).success,
    ).toBe(false)
  })

  it('validates structured Surface status', () => {
    const status = AutomationOutcomeStatusSchema.parse({
      automationId: 12,
      latest: { kind: 'failed', summary: 'Refresh failed' },
      lastCheckedAt: '2026-09-02T08:00:00.000Z',
      lastSuccessfulAt: '2026-09-01T08:00:00.000Z',
      currentError: {
        code: 'source_unavailable',
        message: 'The source could not be reached.',
      },
    })
    expect(status).toMatchObject({ latest: { kind: 'failed' } })
    expect(AutomationOutcomeStatusesSchema.parse({ '12': status })).toEqual({ '12': status })
    expect(AutomationOutcomeStatusesSchema.safeParse({ '13': status }).success).toBe(false)
  })

  it('accepts the canonical same-origin Surface path for long validated identifiers', () => {
    const longPath = surfacePath('health', 'é'.repeat(400))
    expect(longPath.length).toBeGreaterThan(600)
    expect(
      AutomationOutcomeNotificationSnapshotSchema.safeParse({
        revision: 7,
        notifications: [notification({ surfaceId: 'é'.repeat(400), href: longPath })],
      }).success,
    ).toBe(true)
  })

  it('accepts authoritative snapshots and terminal action results', () => {
    const unread = notification()
    expect(
      AutomationOutcomeNotificationSnapshotSchema.parse({ revision: 7, notifications: [unread] }),
    ).toEqual({ revision: 7, notifications: [unread] })
    expect(
      AutomationOutcomeNotificationActionResultSchema.parse({
        revision: 8,
        notification: { ...unread, revision: 8, state: 'opened' },
      }),
    ).toMatchObject({ revision: 8, notification: { state: 'opened' } })
  })
})

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aon-1',
    revision: 7,
    spaceId: 'spc-health',
    spaceSlug: 'health',
    automationId: 12,
    surfaceId: 'srf-weekly-plan',
    kind: 'changed',
    title: 'Weekly plan updated',
    summary: 'Two new entries',
    coalesceKey: 'new-entries',
    occurrenceCount: 2,
    state: 'unread',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    href: '/app/space/health/surface/srf-weekly-plan',
    ...overrides,
  }
}
