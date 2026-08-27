import type { PendingDecision, PendingDecisionOutcome } from '@veduta/protocol'

const TERMINAL_PREFIXES: Record<PendingDecisionOutcome, string> = {
  executed: 'Executed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired without a decision',
  failed: 'Failed',
  stale: 'Refused because it became stale',
  indeterminate: 'Outcome could not be determined after recovery',
  applied: 'Applied',
  'rolled-back': 'Rolled back',
  refused: 'Refused',
}

/** Daemon-authored, payload-free feedback derived only from the validated safe summary and state. */
export function pendingDecisionFeedback(decision: PendingDecision): string {
  if (decision.state === 'pending') return sentence('Awaiting your decision', decision.summary)
  if (decision.state === 'resolving') return sentence('In progress', decision.summary)
  if (decision.outcome === undefined) {
    throw new Error(`terminal Pending decision ${decision.id} has no authoritative outcome`)
  }
  return sentence(TERMINAL_PREFIXES[decision.outcome], decision.summary)
}

function sentence(prefix: string, summary: string): string {
  return `${prefix}: ${summary}${/[.!?]$/.test(summary) ? '' : '.'}`
}
