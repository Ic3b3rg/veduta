import type { PendingDecision, PendingDecisionOutcome } from '@veduta/protocol'

type DecisionTone = 'pending' | 'success' | 'warning' | 'danger' | 'muted'

const outcomeTones: Record<PendingDecisionOutcome, DecisionTone> = {
  executed: 'success',
  accepted: 'success',
  applied: 'success',
  rejected: 'muted',
  expired: 'warning',
  stale: 'warning',
  indeterminate: 'warning',
  failed: 'danger',
  'rolled-back': 'danger',
  refused: 'danger',
}

/** Presentation only: the Gateway's state and outcome remain authoritative. */
export function pendingDecisionStatus(decision: PendingDecision): {
  label: string
  tone: DecisionTone
} {
  if (decision.state === 'pending') return { label: 'Awaiting decision', tone: 'pending' }
  if (decision.state === 'resolving') return { label: 'Resolving…', tone: 'pending' }
  const outcome = decision.outcome
  if (outcome === undefined) return { label: 'Resolved', tone: 'muted' }
  return {
    label: `${outcome.charAt(0).toUpperCase()}${outcome.slice(1).replaceAll('-', ' ')}`,
    tone: outcomeTones[outcome],
  }
}
