import { useCallback, useState } from 'react'

const NO_FEEDBACK: Record<string, string> = {}

/** One-shot Pin feedback belongs to the current route, never to a cached Surface. */
export function useSurfacePinFeedback(routeKey: string, spaceId: string | undefined) {
  const [feedback, setFeedback] = useState({ routeKey, keys: NO_FEEDBACK })
  if (feedback.routeKey !== routeKey) setFeedback({ routeKey, keys: NO_FEEDBACK })
  const register = useCallback(
    (surfaceId: string, confirmedSpaceId: string, sequence: number) => {
      if (confirmedSpaceId !== spaceId) return
      setFeedback((current) => ({
        routeKey,
        keys: {
          ...(current.routeKey === routeKey ? current.keys : {}),
          [surfaceId]: `pin:${sequence}`,
        },
      }))
    },
    [routeKey, spaceId],
  )
  const acknowledge = useCallback((surfaceId: string, key: string) => {
    setFeedback((current) => {
      if (current.keys[surfaceId] !== key) return current
      const keys = { ...current.keys }
      delete keys[surfaceId]
      return { ...current, keys }
    })
  }, [])
  return {
    keys: feedback.routeKey === routeKey ? feedback.keys : NO_FEEDBACK,
    register,
    acknowledge,
  }
}
