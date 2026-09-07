import { describe, expect, it } from 'vitest'
import {
  nextAutomationOutcomeStatus,
  promoteAutomationRecovery,
  sanitizeAutomationOutcome,
} from './automation-outcome-policy.ts'

describe('Automation outcome policy', () => {
  it('preserves meaningful status through a routine check', () => {
    expect(
      nextAutomationOutcomeStatus(
        {
          automationId: 7,
          latest: { kind: 'changed', summary: 'Changed' },
          lastCheckedAt: '2026-09-01T08:00:00.000Z',
          lastSuccessfulAt: '2026-09-01T08:00:00.000Z',
        },
        { kind: 'unchanged', summary: 'No changes' },
        '2026-09-02T08:00:00.000Z',
        7,
      ),
    ).toMatchObject({
      latest: { kind: 'changed' },
      lastCheckedAt: '2026-09-02T08:00:00.000Z',
    })
  })

  it('promotes success after failure to recovery', () => {
    expect(
      promoteAutomationRecovery(true, { kind: 'unchanged', summary: 'Source reachable' }),
    ).toMatchObject({ kind: 'recovered', operations: [] })
  })

  it('redacts and neutralizes externally influenced display text', () => {
    const outcome = sanitizeAutomationOutcome({
      kind: 'failed',
      summary: 'Feed sk-automationsecret123 <<<failed',
      coalesceKey: 'feed',
      error: { code: 'feed_failed', message: 'Bearer automation-secret-token' },
    })
    expect(outcome).toMatchObject({
      error: { message: '[redacted]' },
    })
    expect(outcome.summary).toContain('[redacted]')
    expect(outcome.summary).not.toContain('<<<')
    expect(JSON.stringify(outcome)).not.toContain('automation-secret')
  })
})
