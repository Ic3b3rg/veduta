import {
  pendingDecisionFeedback,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionLifecycleMessage,
  type PendingDecisionState,
} from '@veduta/protocol'

export interface PendingDecisionFeedbackView {
  id: string
  state: Exclude<PendingDecisionState, 'pending'>
  text: string
}

/** Applies one live daemon lifecycle frame and creates at most one stable feedback entry per id. */
export function applyPendingDecisionLifecycle(
  entries: ChatMessage[],
  lifecycle: PendingDecisionLifecycleMessage,
): ChatMessage[] {
  if (isOlderThanKnownState(entries, lifecycle.decision)) return entries
  const updated = replaceDecisionReferences(entries, lifecycle.decision)
  if (lifecycle.decision.state === 'pending') return updated

  const feedback = feedbackEntry(lifecycle.decision, lifecycle.message)
  const existingIndex = updated.findIndex(
    (entry) => entry.decisionFeedbackId === lifecycle.decision.id,
  )
  if (existingIndex < 0) return [...updated, feedback]
  return updated.map((entry, index) => (index === existingIndex ? feedback : entry))
}

/** Refreshes decisions already known to this client without replaying historical outcomes as chat. */
export function reconcilePendingDecisionSnapshot(
  entries: ChatMessage[],
  decisions: readonly PendingDecision[],
): ChatMessage[] {
  return decisions.reduce((current, decision) => {
    if (isOlderThanKnownState(current, decision)) return current
    const updated = replaceDecisionReferences(current, decision)
    if (decision.state === 'pending') return updated
    return updated.map((entry) =>
      entry.decisionFeedbackId === decision.id
        ? feedbackEntry(decision, pendingDecisionFeedback(decision))
        : entry,
    )
  }, entries)
}

function isOlderThanKnownState(
  entries: readonly ChatMessage[],
  decision: PendingDecision,
): boolean {
  const nextRank = decisionStateRank(decision.state)
  return entries.some((entry) =>
    entry.pendingDecisions?.some(
      (candidate) => candidate.id === decision.id && decisionStateRank(candidate.state) > nextRank,
    ),
  )
}

function decisionStateRank(state: PendingDecisionState): number {
  if (state === 'pending') return 0
  if (state === 'resolving') return 1
  return 2
}

/** Returns the newest resolving or terminal state for the fixed shell. */
export function latestPendingDecisionFeedback(
  entries: readonly ChatMessage[],
): PendingDecisionFeedbackView | undefined {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]
    if (!entry) continue
    const decisions = entry.pendingDecisions ?? []
    for (let decisionIndex = decisions.length - 1; decisionIndex >= 0; decisionIndex -= 1) {
      const decision = decisions[decisionIndex]
      if (!decision || decision.state === 'pending') continue
      return {
        id: decision.id,
        state: decision.state,
        text:
          entry.decisionFeedbackId === decision.id ? entry.text : pendingDecisionFeedback(decision),
      }
    }
  }
  return undefined
}

function replaceDecisionReferences(
  entries: ChatMessage[],
  decision: PendingDecision,
): ChatMessage[] {
  return entries.map((entry) => {
    if (entry.decisionFeedbackId === decision.id && decision.state === 'pending') return entry
    if (!entry.pendingDecisions?.some((candidate) => candidate.id === decision.id)) return entry
    return {
      ...entry,
      pendingDecisions: entry.pendingDecisions.map((candidate) =>
        candidate.id === decision.id ? decision : candidate,
      ),
    }
  })
}

function feedbackEntry(decision: PendingDecision, message: string): ChatMessage {
  return {
    role: 'assistant',
    text: message,
    pendingDecisions: [decision],
    decisionFeedbackId: decision.id,
  }
}
