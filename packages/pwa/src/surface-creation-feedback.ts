import type { GatewayServerMessage } from '@veduta/protocol'
import { useCallback, useRef, useState } from 'react'

type SurfaceCreatedMessage = Extract<GatewayServerMessage, { type: 'surface.created' }>

interface PendingTurns {
  has(turnId: string): boolean
}

/** Owns the initiating-tab-only, one-shot presentation state for live Surface creation. */
export function useSurfaceCreationFeedback(wasFeedbackShown?: (feedbackKey: string) => boolean) {
  const [feedbackKeys, setFeedbackKeys] = useState<Record<string, string>>({})
  const consumedKeysRef = useRef(new Set<string>())

  const registerLiveCreation = useCallback(
    (
      message: SurfaceCreatedMessage,
      currentClientId: string | undefined,
      pendingTurns: PendingTurns,
    ) => {
      const correlation = message.initiatingTurn
      if (
        correlation === undefined ||
        correlation.clientId !== currentClientId ||
        !pendingTurns.has(correlation.turnId)
      ) {
        return
      }

      const surfaceId = message.event.surface.id
      const feedbackKey = surfaceRevealFeedbackKey(
        correlation.clientId,
        correlation.turnId,
        surfaceId,
      )
      if (consumedKeysRef.current.has(feedbackKey)) return

      consumedKeysRef.current.add(feedbackKey)
      if (wasFeedbackShown?.(feedbackKey) === true) return
      setFeedbackKeys((current) => ({ ...current, [surfaceId]: feedbackKey }))
    },
    [wasFeedbackShown],
  )

  const acknowledge = useCallback((surfaceId: string, feedbackKey: string) => {
    setFeedbackKeys((current) => {
      if (current[surfaceId] !== feedbackKey) return current
      const next = { ...current }
      delete next[surfaceId]
      return next
    })
  }, [])

  return { feedbackKeys, registerLiveCreation, acknowledge }
}

/** Identifies one visual reveal across every live presentation source. */
export function surfaceRevealFeedbackKey(
  clientId: string,
  turnId: string,
  surfaceId: string,
): string {
  return JSON.stringify([clientId, turnId, surfaceId])
}
