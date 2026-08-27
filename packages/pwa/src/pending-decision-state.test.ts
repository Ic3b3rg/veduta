import type {
  ChatMessage,
  PendingDecision,
  PendingDecisionLifecycleMessage,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyPendingDecisionLifecycle,
  latestPendingDecisionFeedback,
  reconcilePendingDecisionSnapshot,
} from './pending-decision-state.ts'

const pending: PendingDecision = {
  id: 'approval:effect-1',
  kind: 'approval',
  summary: 'Send message to alice@example.com',
  scope: { type: 'space', spaceId: 'spc-work' },
  allowedResolutions: ['approve', 'reject'],
  state: 'pending',
  decisionSurfaceId: 'srf-approval-1',
  createdAt: '2026-08-25T10:00:00.000Z',
}

const resolving: PendingDecision = {
  ...pending,
  state: 'resolving',
  decisionAt: '2026-08-25T10:01:00.000Z',
  resolvedBy: 'trusted:user',
}

const terminal: PendingDecision = {
  ...resolving,
  state: 'terminal',
  outcome: 'executed',
  resolvedAt: '2026-08-25T10:01:01.000Z',
}

const originalMessage: ChatMessage = {
  role: 'assistant',
  text: 'This action needs approval.',
  pendingDecisions: [pending],
}

function lifecycle(
  revision: number,
  decision: PendingDecision,
  message: string,
): PendingDecisionLifecycleMessage {
  return { type: 'pending-decision.lifecycle', revision, decision, message }
}

describe('Pending-decision PWA state', () => {
  it('adds one stable chat feedback entry and updates it in place through terminal state', () => {
    const inProgress = applyPendingDecisionLifecycle(
      [originalMessage],
      lifecycle(1, resolving, 'In progress: Send message to alice@example.com.'),
    )
    const completed = applyPendingDecisionLifecycle(
      inProgress,
      lifecycle(2, terminal, 'Executed: Send message to alice@example.com.'),
    )
    const duplicate = applyPendingDecisionLifecycle(
      completed,
      lifecycle(2, terminal, 'Executed: Send message to alice@example.com.'),
    )

    expect(completed).toHaveLength(2)
    expect(completed[0]?.pendingDecisions).toEqual([terminal])
    expect(completed[1]).toEqual({
      role: 'assistant',
      text: 'Executed: Send message to alice@example.com.',
      pendingDecisions: [terminal],
      decisionFeedbackId: terminal.id,
    })
    expect(duplicate).toEqual(completed)
    expect(
      applyPendingDecisionLifecycle(
        completed,
        lifecycle(1, resolving, 'In progress: Send message to alice@example.com.'),
      ),
    ).toEqual(completed)
  })

  it('does not add feedback while the decision is still pending', () => {
    expect(
      applyPendingDecisionLifecycle(
        [originalMessage],
        lifecycle(1, pending, 'Awaiting your decision: Send message to alice@example.com.'),
      ),
    ).toEqual([originalMessage])
  })

  it('reconciles known chat state after reconnect without appending historical outcomes', () => {
    const entries = applyPendingDecisionLifecycle(
      [originalMessage],
      lifecycle(1, resolving, 'In progress: Send message to alice@example.com.'),
    )

    const reconciled = reconcilePendingDecisionSnapshot(entries, [terminal])
    const unknownTerminal = { ...terminal, id: 'approval:effect-2' }

    expect(reconciled).toHaveLength(2)
    expect(reconciled[0]?.pendingDecisions).toEqual([terminal])
    expect(reconciled[1]?.text).toBe('Executed: Send message to alice@example.com.')
    expect(reconcilePendingDecisionSnapshot([], [unknownTerminal])).toEqual([])
  })

  it('exposes the latest resolving or terminal truth for the fixed shell', () => {
    const entries = applyPendingDecisionLifecycle(
      [originalMessage],
      lifecycle(1, resolving, 'In progress: Send message to alice@example.com.'),
    )

    expect(latestPendingDecisionFeedback(entries)).toEqual({
      id: resolving.id,
      state: 'resolving',
      text: 'In progress: Send message to alice@example.com.',
    })
    expect(latestPendingDecisionFeedback([originalMessage])).toBeUndefined()
  })
})
