import { describe, expect, it } from 'vitest'
import { automationOutcomeFailure, parseRecurringOutcomeCheckpoint } from './scheduler-outcome.ts'

describe('recurring Automation outcome checkpoints', () => {
  it('restores a validated checkpoint with its target generation', () => {
    expect(
      parseRecurringOutcomeCheckpoint(
        JSON.stringify({
          outcome: {
            kind: 'changed',
            summary: 'Updated the Surface',
            coalesceKey: 'daily-refresh',
            operations: [],
          },
          origin: 'trusted:system',
          checkedAt: '2026-07-08T15:00:00+02:00',
          targetSurfaceId: 'srf-health',
          targetVersion: 7,
        }),
        '2026-07-08T13:00:00.000Z',
      ),
    ).toEqual({
      outcome: {
        kind: 'changed',
        summary: 'Updated the Surface',
        coalesceKey: 'daily-refresh',
        operations: [],
      },
      origin: 'trusted:system',
      checkedAt: '2026-07-08T13:00:00.000Z',
      targetSurfaceId: 'srf-health',
      targetVersion: 7,
    })
  })

  it('upgrades a legacy outcome checkpoint with occurrence defaults', () => {
    expect(
      parseRecurringOutcomeCheckpoint(
        JSON.stringify({ kind: 'unchanged', summary: 'No change' }),
        '2026-07-08T13:00:00.000Z',
        'srf-automations',
      ),
    ).toEqual({
      outcome: { kind: 'unchanged', summary: 'No change' },
      origin: 'trusted:system',
      checkedAt: '2026-07-08T13:00:00.000Z',
      targetSurfaceId: 'srf-automations',
    })
  })

  it('rejects malformed target generations', () => {
    expect(
      parseRecurringOutcomeCheckpoint(
        JSON.stringify({
          outcome: { kind: 'unchanged', summary: 'No change' },
          origin: 'trusted:system',
          checkedAt: '2026-07-08T13:00:00.000Z',
          targetSurfaceId: 'srf-health',
          targetVersion: 0,
        }),
        '2026-07-08T13:00:00.000Z',
      ),
    ).toBeUndefined()
  })
})

describe('Automation outcome failures', () => {
  it('bounds and flattens producer error text before persistence', () => {
    const outcome = automationOutcomeFailure(
      '  Producer\nfailed  ',
      'producer_error',
      'x'.repeat(400),
    )

    expect(outcome).toEqual({
      kind: 'failed',
      summary: 'Producer failed',
      coalesceKey: 'producer_error',
      error: { code: 'producer_error', message: 'x'.repeat(240) },
    })
  })
})
