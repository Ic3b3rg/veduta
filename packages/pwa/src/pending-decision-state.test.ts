import {
  PENDING_DECISION_FALLBACK_FEEDBACK,
  type ChatMessage,
  type PendingDecision,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyPendingDecisionFeedback,
  appendAuthoritativeChatEntry,
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

function feedback(decision: PendingDecision, message: string) {
  return { decision, message }
}

describe('Pending-decision PWA state', () => {
  it('adds one stable chat feedback entry and advances it through terminal state', () => {
    const inProgress = applyPendingDecisionFeedback(
      [originalMessage],
      feedback(resolving, 'In progress: Send message to alice@example.com.'),
    )
    const completed = applyPendingDecisionFeedback(
      inProgress,
      feedback(terminal, 'Executed: Send message to alice@example.com.'),
    )
    const duplicate = applyPendingDecisionFeedback(
      completed,
      feedback(terminal, 'Executed: Send message to alice@example.com.'),
    )

    expect(completed).toHaveLength(1)
    expect(completed[0]).toEqual({
      role: 'assistant',
      text: 'Executed: Send message to alice@example.com.',
      pendingDecisions: [terminal],
      decisionFeedbackId: terminal.id,
    })
    expect(duplicate).toEqual(completed)
    expect(
      applyPendingDecisionFeedback(
        completed,
        feedback(resolving, 'In progress: Send message to alice@example.com.'),
      ),
    ).toEqual(completed)
  })

  it('replaces a model-authored status assertion with authoritative pending text', () => {
    expect(
      applyPendingDecisionFeedback(
        [{ ...originalMessage, text: 'Done — send_message completed.' }],
        feedback(pending, 'Awaiting your decision: Send message to alice@example.com.'),
      ),
    ).toEqual([
      {
        ...originalMessage,
        text: 'Awaiting your decision: Send message to alice@example.com.',
      },
    ])
  })

  it('recovers known and unseen outcomes after reconnect without duplicate feedback', () => {
    const entries = applyPendingDecisionFeedback(
      [originalMessage],
      feedback(resolving, 'In progress: Send message to alice@example.com.'),
    )

    const reconciled = reconcilePendingDecisionSnapshot(entries, [terminal])
    const unknownTerminal = { ...terminal, id: 'approval:effect-2' }
    const recovered = reconcilePendingDecisionSnapshot(reconciled, [terminal, unknownTerminal])

    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]?.pendingDecisions).toEqual([terminal])
    expect(reconciled[0]?.text).toBe('Executed: Send message to alice@example.com.')
    expect(recovered.filter((entry) => entry.decisionFeedbackId === terminal.id)).toHaveLength(1)
    expect(recovered.at(-1)).toMatchObject({
      text: 'Executed: Send message to alice@example.com.',
      decisionFeedbackId: unknownTerminal.id,
      pendingDecisions: [unknownTerminal],
    })
  })

  it('exposes the latest resolving or terminal truth for the fixed shell', () => {
    const entries = applyPendingDecisionFeedback(
      [originalMessage],
      feedback(resolving, 'In progress: Send message to alice@example.com.'),
    )

    expect(latestPendingDecisionFeedback(entries)).toEqual({
      id: resolving.id,
      state: 'resolving',
      text: 'In progress: Send message to alice@example.com.',
    })
    expect(latestPendingDecisionFeedback([originalMessage])).toBeUndefined()
  })

  it('moves a newly changed outcome behind older feedback so fixed-shell recency is truthful', () => {
    const otherResolving: PendingDecision = {
      ...resolving,
      id: 'approval:effect-2',
      summary: 'Send the second message',
      decisionAt: '2026-08-25T10:02:00.000Z',
    }
    const firstTerminal: PendingDecision = {
      ...terminal,
      resolvedAt: '2026-08-25T10:03:00.000Z',
    }
    const first = applyPendingDecisionFeedback(
      [],
      feedback(resolving, 'In progress: Send message to alice@example.com.'),
    )
    const second = applyPendingDecisionFeedback(
      first,
      feedback(otherResolving, 'In progress: Send the second message.'),
    )
    const latest = applyPendingDecisionFeedback(
      second,
      feedback(firstTerminal, 'Executed: Send message to alice@example.com.'),
    )

    expect(latest.map((entry) => entry.decisionFeedbackId)).toEqual([
      otherResolving.id,
      firstTerminal.id,
    ])
    expect(latestPendingDecisionFeedback(latest)?.id).toBe(firstTerminal.id)
  })

  it('does not resurrect a decision when its pending turn-end arrives after a terminal frame', () => {
    const completed = applyPendingDecisionFeedback(
      [],
      feedback(terminal, 'Executed: Send message to alice@example.com.'),
    )

    const reconciled = appendAuthoritativeChatEntry(completed, {
      role: 'assistant',
      text: 'Done — send_message completed.',
      pendingDecisions: [pending],
    })

    expect(reconciled).toEqual([
      {
        role: 'assistant',
        text: 'Executed: Send message to alice@example.com.',
        pendingDecisions: [terminal],
        decisionFeedbackId: terminal.id,
      },
    ])
  })

  it('replaces an unprojected fallback by exact id and cannot resurrect it after terminal state', () => {
    const fallback: ChatMessage = {
      role: 'assistant',
      text: PENDING_DECISION_FALLBACK_FEEDBACK,
      pendingDecisionIds: [terminal.id],
    }
    const completed = applyPendingDecisionFeedback(
      [fallback],
      feedback(terminal, 'Executed: Send message to alice@example.com.'),
    )

    expect(completed).toEqual([
      {
        role: 'assistant',
        text: 'Executed: Send message to alice@example.com.',
        pendingDecisions: [terminal],
        decisionFeedbackId: terminal.id,
      },
    ])
    expect(appendAuthoritativeChatEntry(completed, fallback)).toEqual(completed)
  })

  it('keeps an unprojected decision visible beside a projected one until it converges', () => {
    const unprojectedTerminal: PendingDecision = {
      ...terminal,
      id: 'approval:effect-unavailable',
      summary: 'Publish the report',
    }
    const mixed: ChatMessage = {
      role: 'assistant',
      text: `Awaiting your decision: Send message to alice@example.com.\n${PENDING_DECISION_FALLBACK_FEEDBACK}`,
      pendingDecisions: [pending],
      pendingDecisionIds: [unprojectedTerminal.id],
    }

    expect(appendAuthoritativeChatEntry([], mixed)).toEqual([mixed])
    expect(
      applyPendingDecisionFeedback(
        [mixed],
        feedback(unprojectedTerminal, 'Executed: Publish the report.'),
      ),
    ).toEqual([
      {
        role: 'assistant',
        text: 'Awaiting your decision: Send message to alice@example.com.',
        pendingDecisions: [pending],
      },
      {
        role: 'assistant',
        text: 'Executed: Publish the report.',
        pendingDecisions: [unprojectedTerminal],
        decisionFeedbackId: unprojectedTerminal.id,
      },
    ])
  })
})
