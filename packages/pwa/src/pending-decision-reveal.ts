import type { PendingDecision } from '@veduta/protocol'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ChatTurnFrame } from './chat-turn-state.ts'

interface PendingTurns {
  has(turnId: string): boolean
}

export interface PendingDecisionRevealRequest {
  decisionId: string
  key: string
}

/** Owns live-turn-only, initiating-tab presentation requests for Decision Surfaces. */
export function usePendingDecisionReveal() {
  const [requests, setRequests] = useState<Record<string, PendingDecisionRevealRequest>>({})
  const consumedKeysRef = useRef(new Set<string>())
  const revealKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(requests).map(([surfaceId, request]) => [surfaceId, request.key]),
      ),
    [requests],
  )

  const registerLiveTurn = useCallback(
    (frame: ChatTurnFrame, currentClientId: string | undefined, pendingTurns: PendingTurns) => {
      if (
        currentClientId === undefined ||
        (frame.type !== 'chat.turn-replace' && frame.type !== 'chat.turn-end') ||
        !pendingTurns.has(frame.turnId)
      ) {
        return
      }

      const additions: Record<string, PendingDecisionRevealRequest> = {}
      for (const decision of frame.message.pendingDecisions ?? []) {
        const surfaceId = pendingDecisionSurfaceId(decision)
        if (surfaceId === undefined) continue

        const key = JSON.stringify([currentClientId, frame.turnId, decision.id, surfaceId])
        if (consumedKeysRef.current.has(key)) continue
        consumedKeysRef.current.add(key)
        additions[surfaceId] = { decisionId: decision.id, key }
      }

      if (Object.keys(additions).length > 0) {
        setRequests((current) => ({ ...current, ...additions }))
      }
    },
    [],
  )

  const acknowledge = useCallback((surfaceId: string, key: string) => {
    setRequests((current) => removeRequest(current, surfaceId, key))
  }, [])

  const dismissDecision = useCallback((decisionId: string) => {
    setRequests((current) => {
      const entries = Object.entries(current)
      const remaining = entries.filter(([, request]) => request.decisionId !== decisionId)
      return remaining.length === entries.length ? current : Object.fromEntries(remaining)
    })
  }, [])

  const cancelAll = useCallback(() => setRequests({}), [])

  return { requests, revealKeys, registerLiveTurn, acknowledge, dismissDecision, cancelAll }
}

function pendingDecisionSurfaceId(decision: PendingDecision): string | undefined {
  return decision.state === 'pending' && decision.scope.type === 'space'
    ? decision.decisionSurfaceId
    : undefined
}

function removeRequest(
  requests: Record<string, PendingDecisionRevealRequest>,
  surfaceId: string,
  key: string,
): Record<string, PendingDecisionRevealRequest> {
  if (requests[surfaceId]?.key !== key) return requests
  const next = { ...requests }
  delete next[surfaceId]
  return next
}
