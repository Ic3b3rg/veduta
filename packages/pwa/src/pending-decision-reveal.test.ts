// @vitest-environment jsdom
import type { PendingDecision } from '@veduta/protocol'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatTurnFrame } from './chat-turn-state.ts'
import { usePendingDecisionReveal } from './pending-decision-reveal.ts'

const decision: PendingDecision = {
  id: 'tree-proposal:weekly-plan',
  kind: 'tree-proposal',
  summary: 'Update the weekly plan',
  scope: { type: 'space', spaceId: 'spc-health' },
  allowedResolutions: ['accept', 'reject'],
  state: 'pending',
  decisionSurfaceId: 'srf-decision-weekly-plan',
  createdAt: '2026-08-28T10:00:00.000Z',
}

function replacement(projected: PendingDecision = decision): ChatTurnFrame {
  return {
    type: 'chat.turn-replace',
    turnId: 'turn-1',
    spaceId: 'spc-health',
    message: {
      role: 'assistant',
      text: 'Awaiting your decision: Update the weekly plan.',
      pendingDecisions: [projected],
    },
  }
}

describe('usePendingDecisionReveal', () => {
  it('registers and acknowledges one exact decision from a live turn in this client', () => {
    const { result } = renderHook(usePendingDecisionReveal)
    const pendingTurns = new Map([['turn-1', {}]])

    act(() => result.current.registerLiveTurn(replacement(), 'pwa-1', pendingTurns))

    const revealKey = JSON.stringify(['pwa-1', 'turn-1', decision.decisionSurfaceId])
    expect(result.current.revealKeys).toEqual({ 'srf-decision-weekly-plan': revealKey })

    const registered = result.current.revealKeys
    act(() => result.current.registerLiveTurn(replacement(), 'pwa-1', pendingTurns))
    expect(result.current.revealKeys).toBe(registered)

    act(() => result.current.acknowledge('srf-decision-weekly-plan', revealKey))
    expect(result.current.revealKeys).toEqual({})
  })

  it('ignores frames without an active client, active turn, pending state, or Decision Surface', () => {
    const { result } = renderHook(usePendingDecisionReveal)
    const activeTurns = new Map([['turn-1', {}]])
    const finishedTurns = new Map<string, object>()
    const terminal: PendingDecision = {
      ...decision,
      state: 'terminal',
      outcome: 'accepted',
      resolvedAt: '2026-08-28T10:01:00.000Z',
      resolvedBy: 'trusted:user',
    }
    const missingSurface: PendingDecision = { ...decision, decisionSurfaceId: undefined }
    const globalWithSurface: PendingDecision = { ...decision, scope: { type: 'global' } }

    act(() => {
      result.current.registerLiveTurn(replacement(), undefined, activeTurns)
      result.current.registerLiveTurn(replacement(), 'pwa-1', finishedTurns)
      result.current.registerLiveTurn(replacement(terminal), 'pwa-1', activeTurns)
      result.current.registerLiveTurn(replacement(missingSurface), 'pwa-1', activeTurns)
      result.current.registerLiveTurn(replacement(globalWithSurface), 'pwa-1', activeTurns)
    })

    expect(result.current.revealKeys).toEqual({})
  })

  it('clears an unshown live request when the connection closes', () => {
    const { result } = renderHook(usePendingDecisionReveal)

    act(() => result.current.registerLiveTurn(replacement(), 'pwa-1', new Map([['turn-1', {}]])))
    act(() => result.current.cancelAll())

    expect(result.current.revealKeys).toEqual({})
  })

  it('does not request a second reveal when another live source already showed the correlation', () => {
    const revealKey = JSON.stringify(['pwa-1', 'turn-1', decision.decisionSurfaceId])
    const { result } = renderHook(() =>
      usePendingDecisionReveal((candidate) => candidate === revealKey),
    )

    act(() => result.current.registerLiveTurn(replacement(), 'pwa-1', new Map([['turn-1', {}]])))

    expect(result.current.revealKeys).toEqual({})
  })

  it('drops an unshown request when lifecycle truth advances the decision', () => {
    const { result } = renderHook(usePendingDecisionReveal)

    act(() => result.current.registerLiveTurn(replacement(), 'pwa-1', new Map([['turn-1', {}]])))
    act(() => result.current.dismissDecision(decision.id))

    expect(result.current.revealKeys).toEqual({})
  })
})
