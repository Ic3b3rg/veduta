import {
  pendingDecisionFeedback,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionLifecycleMessage,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  ApiResponseError,
  fetchSpaces,
  resolvePendingDecision,
  type SpaceWithSurfaces,
} from './api.ts'
import { usePendingDecisionReveal } from './pending-decision-reveal.ts'
import { placePendingDecisions } from './pending-decision-placement.ts'
import { usePendingDecisionSync } from './use-pending-decision-sync.ts'

interface PendingDecisionControllerOptions {
  authToken: string | undefined
  spaces: readonly SpaceWithSurfaces[]
  focusedSpaceId: string | undefined
  focusedSurfaceId: string | undefined
  setChatEntries: Dispatch<SetStateAction<ChatMessage[]>>
  onUnauthorized: () => void
  onReplaceSpaces: (spaces: SpaceWithSurfaces[], cursor: number) => void
  onRevealSurface: (spaceSlug: string, surfaceId: string) => void
  wasRevealShown: (feedbackKey: string) => boolean
  onError: (message: string) => void
}

/** Owns Pending-decision synchronization, live reveal, and quick-resolution orchestration. */
export function usePendingDecisionController(options: PendingDecisionControllerOptions) {
  const {
    authToken,
    spaces,
    focusedSpaceId,
    focusedSurfaceId,
    setChatEntries,
    onUnauthorized,
    onReplaceSpaces,
    onRevealSurface,
    wasRevealShown,
    onError,
  } = options
  const [decisions, setDecisions] = useState<PendingDecision[]>([])
  const [dismissedDecisionIds, setDismissedDecisionIds] = useState<Set<string>>(new Set())
  const [resolvingDecisionIds, setResolvingDecisionIds] = useState<Set<string>>(new Set())
  const resolvingDecisionIdsRef = useRef(new Set<string>())
  const navigatedRevealKeysRef = useRef(new Set<string>())
  const {
    requests: revealRequests,
    revealKeys,
    registerLiveTurn,
    acknowledge: acknowledgeReveal,
    dismissDecision,
    cancelAll: cancelReveals,
  } = usePendingDecisionReveal(wasRevealShown)
  const {
    showPendingDecisionFeedback,
    observeProjectedDecisions,
    handlePendingDecisionLifecycle,
    refreshPendingDecisionSnapshot,
    cancelPendingDecisionSnapshot,
  } = usePendingDecisionSync({
    authToken,
    setChatEntries,
    setDecisions,
    onUnauthorized,
  })
  const placement = useMemo(() => placePendingDecisions(decisions, spaces), [decisions, spaces])
  const visibleDecisions = useMemo(
    () => decisions.filter((decision) => !dismissedDecisionIds.has(decision.id)),
    [decisions, dismissedDecisionIds],
  )

  const handleLiveLifecycle = useCallback(
    (lifecycle: PendingDecisionLifecycleMessage) => {
      if (lifecycle.decision.state !== 'pending') dismissDecision(lifecycle.decision.id)
      handlePendingDecisionLifecycle(lifecycle)
    },
    [dismissDecision, handlePendingDecisionLifecycle],
  )

  useEffect(() => {
    for (const [surfaceId, request] of Object.entries(revealRequests)) {
      if (navigatedRevealKeysRef.current.has(request.key)) continue
      const assigned = placement.assigned.find(
        ({ decision, surface }) => decision.id === request.decisionId && surface.id === surfaceId,
      )
      if (assigned === undefined) continue

      navigatedRevealKeysRef.current.add(request.key)
      if (focusedSpaceId !== assigned.space.id || focusedSurfaceId !== surfaceId) {
        onRevealSurface(assigned.space.slug, surfaceId)
      }
      break
    }
  }, [focusedSpaceId, focusedSurfaceId, onRevealSurface, placement, revealRequests])

  const resolve = useCallback(
    async (decisionId: string, resolution: PendingDecisionResolution) => {
      if (resolvingDecisionIdsRef.current.has(decisionId)) return
      resolvingDecisionIdsRef.current.add(decisionId)
      setResolvingDecisionIds((current) => new Set(current).add(decisionId))

      try {
        const { decision } = await resolvePendingDecision(decisionId, resolution, authToken)
        if (decision.state !== 'pending') dismissDecision(decision.id)
        showPendingDecisionFeedback(decision, pendingDecisionFeedback(decision))

        if (decision.kind === 'space-proposal' && decision.outcome === 'accepted') {
          try {
            const snapshot = await fetchSpaces(authToken)
            onReplaceSpaces(snapshot.spaces, snapshot.surfaceCursor)
          } catch (error) {
            onError(error instanceof Error ? error.message : 'Space refresh failed')
          }
        }
      } catch (error) {
        if (error instanceof ApiResponseError && error.status === 401) {
          onUnauthorized()
          return
        }
        onError(error instanceof Error ? error.message : 'Pending decision resolution failed')
      } finally {
        resolvingDecisionIdsRef.current.delete(decisionId)
        setResolvingDecisionIds((current) => {
          const next = new Set(current)
          next.delete(decisionId)
          return next
        })
      }
    },
    [
      authToken,
      dismissDecision,
      onError,
      onReplaceSpaces,
      onUnauthorized,
      showPendingDecisionFeedback,
    ],
  )

  const dismiss = useCallback(
    (decisionId: string) => {
      dismissDecision(decisionId)
      setDismissedDecisionIds((current) => new Set(current).add(decisionId))
    },
    [dismissDecision],
  )

  return {
    decisions: visibleDecisions,
    dismissedDecisionIds,
    resolvingDecisionIds,
    revealKeys,
    registerLiveTurn,
    acknowledgeReveal,
    cancelReveals,
    observeProjectedDecisions,
    handleLiveLifecycle,
    refreshPendingDecisionSnapshot,
    cancelPendingDecisionSnapshot,
    resolve,
    dismiss,
  }
}
