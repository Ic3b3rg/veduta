import type { PendingDecision, PendingDecisionOutcome } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { pendingDecisionFeedback } from './pending-decision-feedback.ts'

function terminalDecision(outcome: PendingDecisionOutcome): PendingDecision {
  return {
    id: 'approval:effect-1',
    kind: 'approval',
    summary: 'Send message to alice@example.com',
    scope: { type: 'space', spaceId: 'spc-work' },
    allowedResolutions: ['approve', 'reject'],
    state: 'terminal',
    outcome,
    createdAt: '2026-08-16T08:00:00.000Z',
    resolvedAt: '2026-08-16T08:01:00.000Z',
    resolvedBy: 'trusted:user',
  }
}

describe('pendingDecisionFeedback', () => {
  it('distinguishes every authoritative terminal outcome using only the safe summary', () => {
    expect(
      Object.fromEntries(
        (
          [
            'executed',
            'accepted',
            'rejected',
            'expired',
            'failed',
            'stale',
            'indeterminate',
            'applied',
            'rolled-back',
            'refused',
          ] as const
        ).map((outcome) => [outcome, pendingDecisionFeedback(terminalDecision(outcome))]),
      ),
    ).toEqual({
      executed: 'Executed: Send message to alice@example.com.',
      accepted: 'Accepted: Send message to alice@example.com.',
      rejected: 'Rejected: Send message to alice@example.com.',
      expired: 'Expired without a decision: Send message to alice@example.com.',
      failed: 'Failed: Send message to alice@example.com.',
      stale: 'Refused because it became stale: Send message to alice@example.com.',
      indeterminate:
        'Outcome could not be determined after recovery: Send message to alice@example.com.',
      applied: 'Applied: Send message to alice@example.com.',
      'rolled-back': 'Rolled back: Send message to alice@example.com.',
      refused: 'Refused: Send message to alice@example.com.',
    })
  })

  it('reports pending and resolving states without claiming the effect succeeded', () => {
    const pending = terminalDecision('executed')
    const { outcome: _outcome, resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...base } = pending

    expect(pendingDecisionFeedback({ ...base, state: 'pending' })).toBe(
      'Awaiting your decision: Send message to alice@example.com.',
    )
    expect(
      pendingDecisionFeedback({
        ...base,
        state: 'resolving',
        decisionAt: '2026-08-16T08:00:30.000Z',
        resolvedBy: 'trusted:user',
      }),
    ).toBe('In progress: Send message to alice@example.com.')
  })
})
