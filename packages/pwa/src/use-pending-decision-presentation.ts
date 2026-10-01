import type { PendingDecision } from '@veduta/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SpaceWithSurfaces } from './api.ts'
import { usePendingDecisionReveal } from './pending-decision-reveal.ts'
import { placePendingDecisions } from './pending-decision-placement.ts'

/** Local reveal, dismissal, and navigation presentation over runtime-owned decisions. */
export function usePendingDecisionPresentation(options: {
  decisions: readonly PendingDecision[]
  spaces: readonly SpaceWithSurfaces[]
  focusedSpaceId: string | undefined
  onRevealSurface: (spaceSlug: string, surfaceId: string) => void
  wasRevealShown: (feedbackKey: string) => boolean
}) {
  const [dismissedDecisionIds, setDismissedDecisionIds] = useState(new Set<string>())
  const navigated = useRef(new Set<string>())
  const reveal = usePendingDecisionReveal(options.wasRevealShown)
  const placement = useMemo(
    () => placePendingDecisions(options.decisions, options.spaces),
    [options.decisions, options.spaces],
  )
  useEffect(() => {
    for (const decision of options.decisions)
      if (decision.state !== 'pending') reveal.dismissDecision(decision.id)
  }, [options.decisions, reveal.dismissDecision])
  useEffect(() => {
    for (const [surfaceId, request] of Object.entries(reveal.requests)) {
      if (navigated.current.has(request.key)) continue
      const assigned = placement.assigned.find(
        ({ decision, surface }) => decision.id === request.decisionId && surface.id === surfaceId,
      )
      if (!assigned) continue
      navigated.current.add(request.key)
      if (options.focusedSpaceId !== assigned.space.id)
        options.onRevealSurface(assigned.space.slug, surfaceId)
      break
    }
  }, [options.focusedSpaceId, options.onRevealSurface, placement, reveal.requests])
  const dismiss = useCallback(
    (id: string) => {
      reveal.dismissDecision(id)
      setDismissedDecisionIds((current) => new Set(current).add(id))
    },
    [reveal.dismissDecision],
  )
  return { ...reveal, dismissedDecisionIds, dismiss }
}
