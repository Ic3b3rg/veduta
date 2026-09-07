import {
  AutomationOutcomeStatusSchema,
  MAX_AUTOMATION_OUTCOME_SUMMARY_LENGTH,
  type AutomationOutcomeInput,
  type AutomationOutcomeKind,
  type AutomationOutcomeStatus,
} from '@veduta/protocol'
import { defaultRedactor } from './redaction.ts'
import { neutralizeDelimiters } from './taint.ts'

export function nextAutomationOutcomeStatus(
  previous: AutomationOutcomeStatus | undefined,
  outcome: AutomationOutcomeInput,
  checkedAt: string,
  automationId: number,
): AutomationOutcomeStatus {
  const ownPrevious = previous?.automationId === automationId ? previous : undefined
  const successful = outcome.kind !== 'failed'
  return AutomationOutcomeStatusSchema.parse({
    automationId,
    ...(outcome.kind === 'unchanged'
      ? ownPrevious?.latest === undefined
        ? {}
        : { latest: ownPrevious.latest }
      : {
          latest:
            outcome.kind === 'decision-required'
              ? { kind: outcome.kind, summary: outcome.summary, decisionId: outcome.decisionId }
              : { kind: outcome.kind, summary: outcome.summary },
        }),
    lastCheckedAt: checkedAt,
    ...(successful
      ? { lastSuccessfulAt: checkedAt }
      : ownPrevious?.lastSuccessfulAt === undefined
        ? {}
        : { lastSuccessfulAt: ownPrevious.lastSuccessfulAt }),
    ...(outcome.kind === 'failed'
      ? { currentError: outcome.error }
      : outcome.kind === 'recovered' ||
          outcome.kind === 'decision-required' ||
          ownPrevious?.currentError === undefined
        ? {}
        : { currentError: ownPrevious.currentError }),
  })
}

export function promoteAutomationRecovery(
  hasUnrecoveredFailure: boolean,
  outcome: AutomationOutcomeInput,
): AutomationOutcomeInput {
  if (!hasUnrecoveredFailure || (outcome.kind !== 'unchanged' && outcome.kind !== 'changed')) {
    return outcome
  }
  return {
    kind: 'recovered',
    summary: outcome.summary,
    coalesceKey: 'recovered',
    operations: outcome.kind === 'changed' ? outcome.operations : [],
  }
}

export function replayedAutomationOutcome(
  kind: AutomationOutcomeKind,
  requested: AutomationOutcomeInput,
): AutomationOutcomeInput {
  if (requested.kind === kind) return requested
  const summary = 'Previously delivered Automation outcome'
  if (kind === 'unchanged') return { kind, summary }
  if (kind === 'changed' || kind === 'recovered') {
    return { kind, summary, coalesceKey: 'replay', operations: [] }
  }
  if (kind === 'failed') {
    return {
      kind,
      summary,
      coalesceKey: 'replay',
      error: { code: 'previously_delivered', message: summary },
    }
  }
  return { kind, summary, decisionId: 'previously-delivered' }
}

export function sanitizeAutomationOutcome(outcome: AutomationOutcomeInput): AutomationOutcomeInput {
  const summary = safeDisplayText(outcome.summary)
  if (outcome.kind !== 'failed') return { ...outcome, summary }
  return {
    ...outcome,
    summary,
    error: { ...outcome.error, message: safeDisplayText(outcome.error.message) },
  }
}

function safeDisplayText(value: string): string {
  const safe = neutralizeDelimiters(defaultRedactor.redactText(value)).replace(/\s+/g, ' ').trim()
  return (safe || 'Automation outcome unavailable').slice(0, MAX_AUTOMATION_OUTCOME_SUMMARY_LENGTH)
}
