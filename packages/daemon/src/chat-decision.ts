import {
  parsePendingDecisionId,
  pendingDecisionFeedback,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import type { PendingDecisionService } from './pending-decision-service.ts'

type DecisionIntent =
  | { kind: 'resolve'; verb: 'approve' | 'accept' | 'apply' | 'reject' | 'decline'; id?: string }
  | { kind: 'list' }
  | { kind: 'status'; id: string }
  | { kind: 'recent-status' }
  | { kind: 'clarify' }

const BARE_REFERENCE_RE = /^(?:it|this|that|the (?:pending )?decision|the existing one)$/i
const MAX_CHOICES = 10

/** Only the current PWA chat frame is inspected; model output and prior turns confer no authority. */
export function parseChatDecisionIntent(text: string): DecisionIntent | undefined {
  const command = text
    .trim()
    .replace(/[.!?]$/, '')
    .trim()
  if (/^(?:show|list)(?: me)?(?: all)? pending decisions$/i.test(command)) {
    return { kind: 'list' }
  }
  if (/^(?:fatto|done)$/i.test(command)) return { kind: 'recent-status' }
  const status = /^(?:status of|what happened to|show status for)(?: the decision)? (.+)$/i.exec(
    command,
  )
  if (status?.[1] && parsePendingDecisionId(status[1])) {
    return { kind: 'status', id: status[1] }
  }
  const match = /^(?:please\s+)?(approve|accept|apply|reject|decline)(?:\s+(.+))?$/i.exec(command)
  if (!match?.[1]) return undefined
  const verb = match[1].toLowerCase() as Extract<DecisionIntent, { kind: 'resolve' }>['verb']
  const reference = match[2]?.trim()
  if (!reference || BARE_REFERENCE_RE.test(reference)) {
    return { kind: 'resolve', verb }
  }
  const id = reference.replace(/^the decision\s+/i, '')
  if (parsePendingDecisionId(id)) {
    return { kind: 'resolve', verb, id }
  }
  return { kind: 'clarify' }
}

function visible(decisions: readonly PendingDecision[], spaceId: string | undefined) {
  return decisions.filter(
    (decision) =>
      spaceId === undefined ||
      (decision.scope.type === 'space' && decision.scope.spaceId === spaceId),
  )
}

function choiceList(decisions: readonly PendingDecision[]): string {
  const choices = decisions
    .slice(0, MAX_CHOICES)
    .map((decision) => `${decision.id} — ${decision.summary}`)
  return [
    'Choose one decision by its exact id:',
    ...choices,
    ...(decisions.length > MAX_CHOICES
      ? [`${decisions.length - MAX_CHOICES} more decisions are available in Review.`]
      : []),
  ].join('\n')
}

function resolutionFor(
  decision: PendingDecision,
  verb: Extract<DecisionIntent, { kind: 'resolve' }>['verb'],
): PendingDecisionResolution | undefined {
  if (verb === 'reject' || verb === 'decline') {
    return decision.allowedResolutions.includes('reject') ? 'reject' : undefined
  }
  return decision.allowedResolutions.find((resolution) => resolution !== 'reject')
}

function feedback(decision: PendingDecision): ChatMessage {
  return {
    role: 'assistant',
    text: pendingDecisionFeedback(decision),
    pendingDecisions: [decision],
    ...(decision.state === 'pending' ? {} : { decisionFeedbackId: decision.id }),
  }
}

/** Resolves through the same exact-id authority as the Decision Surface. */
export async function respondToChatDecisionIntent(
  intent: DecisionIntent,
  spaceId: string | undefined,
  service: Pick<PendingDecisionService, 'list' | 'get' | 'resolve'>,
  recentIds: readonly string[] = [],
): Promise<ChatMessage> {
  const { decisions } = await service.list()
  const scoped = visible(decisions, spaceId)
  const pending = scoped.filter((decision) => decision.state === 'pending')

  if (intent.kind === 'list') {
    return {
      role: 'assistant',
      text:
        pending.length === 0
          ? 'There are no Pending decisions in this chat scope.'
          : choiceList(pending),
    }
  }
  if (intent.kind === 'clarify') {
    return {
      role: 'assistant',
      text:
        'Use a decision id for a quick resolution, or open its Decision Surface to review or edit it. ' +
        'Chat approval uses the prepared input unchanged and never creates an allowlist rule.',
    }
  }
  if (intent.kind === 'recent-status') {
    const recent = recentIds
      .map((id) => scoped.find((decision) => decision.id === id))
      .filter((decision): decision is PendingDecision => decision !== undefined)
    const candidates =
      recent.length > 0 ? recent : scoped.filter((decision) => decision.state !== 'pending')
    if (candidates.length === 1) return feedback(candidates[0]!)
    return {
      role: 'assistant',
      text:
        candidates.length > 1
          ? choiceList(candidates)
          : 'I cannot identify a decision from “fatto”. Give its exact id or open Review to check its outcome.',
    }
  }
  const selected =
    intent.id === undefined
      ? pending.length === 1
        ? pending[0]
        : undefined
      : scoped.find((decision) => decision.id === intent.id)

  if (selected === undefined) {
    return {
      role: 'assistant',
      text:
        intent.id !== undefined
          ? 'That Pending decision is not visible in this chat scope.'
          : pending.length === 0
            ? 'There are no Pending decisions in this chat scope.'
            : choiceList(pending),
    }
  }
  if (intent.kind === 'status') return feedback(selected)

  const resolution = resolutionFor(selected, intent.verb)
  if (resolution === undefined) {
    return {
      role: 'assistant',
      text: `This Pending decision does not allow ${intent.verb}. Review ${selected.id} for its available choice.`,
    }
  }
  try {
    const result = await service.resolve(selected.id, resolution, 'trusted:user')
    return feedback(result.decision)
  } catch {
    const current = await service.get(selected.id).catch(() => undefined)
    return current === undefined
      ? { role: 'assistant', text: 'The Pending decision outcome is unavailable. Check Review.' }
      : feedback(current)
  }
}
