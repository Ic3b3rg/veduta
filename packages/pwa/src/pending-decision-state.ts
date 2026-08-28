import {
  pendingDecisionChatFeedback,
  pendingDecisionFeedback,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionState,
} from '@veduta/protocol'

export interface PendingDecisionFeedbackView {
  id: string
  state: Exclude<PendingDecisionState, 'pending'>
  text: string
}

export interface PendingDecisionFeedback {
  decision: PendingDecision
  message: string
}

/** Applies daemon-owned feedback and creates at most one stable chat entry per decision id. */
export function applyPendingDecisionFeedback(
  entries: ChatMessage[],
  feedback: PendingDecisionFeedback,
): ChatMessage[] {
  const normalized = entries.map(authoritativePendingDecisionMessage)
  if (isOlderThanKnownState(normalized, feedback.decision)) return normalized
  const updated = replaceDecisionReferences(normalized, feedback.decision)
  if (feedback.decision.state === 'pending') return updated

  const withoutMultiDecisionReference = removeFromMultiDecisionReferences(
    updated,
    feedback.decision.id,
  )
  const sourceIndexes = withoutMultiDecisionReference.flatMap((candidate, index) =>
    isFeedbackOrSingleReference(candidate, feedback.decision.id) ? [index] : [],
  )
  const existingIndex = sourceIndexes.find(
    (index) => withoutMultiDecisionReference[index]?.decisionFeedbackId === feedback.decision.id,
  )
  const sourceIndex = existingIndex ?? sourceIndexes.at(-1)
  const source = sourceIndex === undefined ? undefined : withoutMultiDecisionReference[sourceIndex]
  const entry = feedbackEntry(feedback.decision, feedback.message, source?.targets)

  if (sourceIndex === undefined) {
    return [...withoutMultiDecisionReference, entry]
  }
  if (
    existingIndex !== undefined &&
    sourceIndexes.length === 1 &&
    chatMessagesEqual(source, entry)
  ) {
    return withoutMultiDecisionReference
  }
  const removed = new Set(sourceIndexes)
  return [
    ...withoutMultiDecisionReference.filter((_candidate, index) => !removed.has(index)),
    entry,
  ]
}

function isFeedbackOrSingleReference(entry: ChatMessage, decisionId: string): boolean {
  const referenceIds = pendingDecisionReferenceIds(entry)
  return (
    entry.decisionFeedbackId === decisionId ||
    (entry.role === 'assistant' &&
      entry.decisionFeedbackId === undefined &&
      referenceIds.length === 1 &&
      referenceIds[0] === decisionId)
  )
}

/** Removes model-authored status claims from a chat entry that carries daemon-owned decisions. */
export function authoritativePendingDecisionMessage(entry: ChatMessage): ChatMessage {
  const pendingDecisions = entry.pendingDecisions ?? []
  const pendingDecisionIds = entry.pendingDecisionIds ?? []
  if (
    entry.role !== 'assistant' ||
    entry.decisionFeedbackId !== undefined ||
    (pendingDecisions.length === 0 && pendingDecisionIds.length === 0)
  ) {
    return entry
  }
  const text = authoritativePendingText(pendingDecisions, pendingDecisionIds)
  return entry.text === text ? entry : { ...entry, text }
}

/** Appends a turn result without letting an older embedded state overwrite live lifecycle truth. */
export function appendAuthoritativeChatEntry(
  entries: ChatMessage[],
  entry: ChatMessage,
): ChatMessage[] {
  const incoming = authoritativePendingDecisionMessage(entry)
  const knownById = new Map<string, PendingDecision>()
  for (const decision of incoming.pendingDecisions ?? []) {
    const known = newestKnownDecision(entries, decision.id)
    if (known !== undefined && decisionStateRank(known.state) > decisionStateRank(decision.state)) {
      knownById.set(known.id, known)
    }
  }
  for (const decisionId of incoming.pendingDecisionIds ?? []) {
    const known = newestKnownDecision(entries, decisionId)
    if (known !== undefined) knownById.set(known.id, known)
  }

  return [...knownById.values()].reduce(
    (current, decision) =>
      applyPendingDecisionFeedback(current, {
        decision,
        message: pendingDecisionFeedback(decision),
      }),
    [...entries, incoming],
  )
}

/** Recovers the daemon snapshot, including outcomes that arrived while this client was offline. */
export function reconcilePendingDecisionSnapshot(
  entries: ChatMessage[],
  decisions: readonly PendingDecision[],
): ChatMessage[] {
  return [...decisions].sort(compareLifecycleTime).reduce(
    (current, decision) =>
      applyPendingDecisionFeedback(current, {
        decision,
        message: pendingDecisionFeedback(decision),
      }),
    entries,
  )
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

function newestKnownDecision(
  entries: readonly ChatMessage[],
  decisionId: string,
): PendingDecision | undefined {
  let newest: PendingDecision | undefined
  for (const entry of entries) {
    for (const decision of entry.pendingDecisions ?? []) {
      if (
        decision.id === decisionId &&
        (newest === undefined ||
          decisionStateRank(decision.state) > decisionStateRank(newest.state))
      ) {
        newest = decision
      }
    }
  }
  return newest
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
    const projected = entry.pendingDecisions ?? []
    const unprojectedIds = entry.pendingDecisionIds ?? []
    const projectedIndex = projected.findIndex((candidate) => candidate.id === decision.id)
    if (projectedIndex < 0 && !unprojectedIds.includes(decision.id)) return entry

    const pendingDecisions =
      projectedIndex < 0
        ? [...projected, decision]
        : projected.map((candidate) => (candidate.id === decision.id ? decision : candidate))
    const pendingDecisionIds = unprojectedIds.filter((id) => id !== decision.id)
    const {
      pendingDecisions: _pendingDecisions,
      pendingDecisionIds: _pendingDecisionIds,
      ...base
    } = entry
    return {
      ...base,
      ...(decision.state === 'pending' && entry.decisionFeedbackId === undefined
        ? { text: authoritativePendingText(pendingDecisions, pendingDecisionIds) }
        : {}),
      pendingDecisions,
      ...(pendingDecisionIds.length === 0 ? {} : { pendingDecisionIds }),
    }
  })
}

function removeFromMultiDecisionReferences(
  entries: ChatMessage[],
  decisionId: string,
): ChatMessage[] {
  return entries.map((entry) => {
    const referenceIds = pendingDecisionReferenceIds(entry)
    if (
      entry.decisionFeedbackId !== undefined ||
      referenceIds.length < 2 ||
      !referenceIds.includes(decisionId)
    ) {
      return entry
    }
    const pendingDecisions = (entry.pendingDecisions ?? []).filter(
      (decision) => decision.id !== decisionId,
    )
    const pendingDecisionIds = (entry.pendingDecisionIds ?? []).filter((id) => id !== decisionId)
    const {
      pendingDecisions: _pendingDecisions,
      pendingDecisionIds: _pendingDecisionIds,
      ...base
    } = entry
    return {
      ...base,
      text: authoritativePendingText(pendingDecisions, pendingDecisionIds),
      ...(pendingDecisions.length === 0 ? {} : { pendingDecisions }),
      ...(pendingDecisionIds.length === 0 ? {} : { pendingDecisionIds }),
    }
  })
}

function authoritativePendingText(
  decisions: readonly PendingDecision[],
  unprojectedIds: readonly string[],
): string {
  return pendingDecisionChatFeedback(decisions, unprojectedIds.length > 0)
}

function pendingDecisionReferenceIds(entry: ChatMessage): string[] {
  return [
    ...new Set([
      ...(entry.pendingDecisions ?? []).map((decision) => decision.id),
      ...(entry.pendingDecisionIds ?? []),
    ]),
  ]
}

function compareLifecycleTime(left: PendingDecision, right: PendingDecision): number {
  return lifecycleTime(left).localeCompare(lifecycleTime(right)) || left.id.localeCompare(right.id)
}

function lifecycleTime(decision: PendingDecision): string {
  if (decision.state === 'terminal') return decision.resolvedAt ?? decision.createdAt
  if (decision.state === 'resolving') return decision.decisionAt ?? decision.createdAt
  return decision.createdAt
}

function chatMessagesEqual(left: ChatMessage | undefined, right: ChatMessage): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function feedbackEntry(
  decision: PendingDecision,
  message: string,
  targets: ChatMessage['targets'] = undefined,
): ChatMessage {
  return {
    role: 'assistant',
    text: message,
    ...(targets === undefined ? {} : { targets }),
    pendingDecisions: [decision],
    decisionFeedbackId: decision.id,
  }
}
