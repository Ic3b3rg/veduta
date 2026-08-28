import {
  formatPendingDecisionId,
  type ApprovalCard,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionLifecycleMessage,
} from '@veduta/protocol'
import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { ApiResponseError, fetchPendingDecisions } from './api.ts'
import {
  applyPendingDecisionFeedback,
  reconcilePendingDecisionSnapshot,
} from './pending-decision-state.ts'
import { CHAT_HISTORY_LIMIT } from './pwa-storage.ts'

interface PendingDecisionSyncOptions {
  authToken: string | undefined
  setChatEntries: Dispatch<SetStateAction<ChatMessage[]>>
  setApprovalCards: Dispatch<SetStateAction<ApprovalCard[]>>
  setDecisions: Dispatch<SetStateAction<PendingDecision[]>>
  onUnauthorized: () => void
}

interface PendingDecisionSync {
  showPendingDecisionFeedback: (decision: PendingDecision, message: string) => void
  handlePendingDecisionLifecycle: (lifecycle: PendingDecisionLifecycleMessage) => void
  refreshPendingDecisionSnapshot: () => void
  cancelPendingDecisionSnapshot: () => void
}

/** Owns snapshot/stream ordering for the PWA's authoritative Pending-decision view. */
export function usePendingDecisionSync(options: PendingDecisionSyncOptions): PendingDecisionSync {
  const { authToken, setChatEntries, setApprovalCards, setDecisions, onUnauthorized } = options
  const revisionRef = useRef(-1)
  const syncingRef = useRef(false)
  const syncGenerationRef = useRef(0)
  const bufferRef = useRef<PendingDecisionLifecycleMessage[]>([])

  const showPendingDecisionFeedback = useCallback(
    (decision: PendingDecision, message: string) => {
      setDecisions((current) => upsertPendingDecision(current, decision))
      setChatEntries((entries) =>
        applyPendingDecisionFeedback(entries, { decision, message }).slice(-CHAT_HISTORY_LIMIT),
      )
      setApprovalCards((cards) => reconcileApprovalCards(cards, [decision]))
    },
    [setApprovalCards, setChatEntries, setDecisions],
  )

  const acceptLifecycle = useCallback(
    (lifecycle: PendingDecisionLifecycleMessage) => {
      if (lifecycle.revision <= revisionRef.current) return
      revisionRef.current = lifecycle.revision
      showPendingDecisionFeedback(lifecycle.decision, lifecycle.message)
    },
    [showPendingDecisionFeedback],
  )

  const handlePendingDecisionLifecycle = useCallback(
    (lifecycle: PendingDecisionLifecycleMessage) => {
      if (syncingRef.current) {
        bufferRef.current.push(lifecycle)
        return
      }
      acceptLifecycle(lifecycle)
    },
    [acceptLifecycle],
  )

  const refreshPendingDecisionSnapshot = useCallback(() => {
    syncGenerationRef.current += 1
    const generation = syncGenerationRef.current
    syncingRef.current = true
    revisionRef.current = -1
    bufferRef.current = []

    const replayBufferedLifecycle = () => {
      const buffered = bufferRef.current
        .slice()
        .sort((left, right) => left.revision - right.revision)
      bufferRef.current = []
      syncingRef.current = false
      for (const lifecycle of buffered) acceptLifecycle(lifecycle)
    }

    void fetchPendingDecisions(authToken)
      .then((snapshot) => {
        if (generation !== syncGenerationRef.current) return
        revisionRef.current = snapshot.revision
        setDecisions(snapshot.decisions)
        setChatEntries((entries) =>
          reconcilePendingDecisionSnapshot(entries, snapshot.decisions).slice(-CHAT_HISTORY_LIMIT),
        )
        setApprovalCards((cards) => reconcileApprovalCards(cards, snapshot.decisions))
        replayBufferedLifecycle()
      })
      .catch((error: unknown) => {
        if (generation !== syncGenerationRef.current) return
        if (error instanceof ApiResponseError && error.status === 401) {
          bufferRef.current = []
          syncingRef.current = false
          onUnauthorized()
          return
        }
        console.warn('failed to refresh Pending decisions:', error)
        replayBufferedLifecycle()
      })
  }, [acceptLifecycle, authToken, onUnauthorized, setApprovalCards, setChatEntries, setDecisions])

  const cancelPendingDecisionSnapshot = useCallback(() => {
    syncGenerationRef.current += 1
    syncingRef.current = false
    bufferRef.current = []
  }, [])

  return {
    showPendingDecisionFeedback,
    handlePendingDecisionLifecycle,
    refreshPendingDecisionSnapshot,
    cancelPendingDecisionSnapshot,
  }
}

function upsertPendingDecision(
  decisions: readonly PendingDecision[],
  decision: PendingDecision,
): PendingDecision[] {
  return [...decisions.filter((candidate) => candidate.id !== decision.id), decision].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
  )
}

function reconcileApprovalCards(
  cards: ApprovalCard[],
  decisions: readonly PendingDecision[],
): ApprovalCard[] {
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]))
  return cards.filter((card) => {
    const decision = decisionsById.get(formatPendingDecisionId('approval', card.id))
    return decision === undefined || decision.state === 'pending'
  })
}
