import {
  AgentEventBus,
  MemorySessionStore,
  type AgentEvent,
  type AgentPromptOptions,
  type AgentRunner,
  type ModelRef,
  type SessionStore,
} from './agent-runner.ts'
import { WORKER_REPORT_VERSION, type WorkerReport } from './worker-briefing.ts'

const MOCK_WORKER_MODEL: ModelRef = { provider: 'mock', modelId: 'worker-mock', tier: 'reasoning' }
const MOCK_TOKENS_USED = 200

/** A goal containing this word is the dev fixture's cue to draft a flagged, initially-rejectable claim (mirrors the old `createMockWorkerReviewComplete` sentinel, now content-driven — see below). */
const UNSUPPORTED_GOAL_SENTINEL = 'unsupported'
/**
 * The exact phrase `reviewFeedbackNote` (worker-briefing.ts) puts in a
 * corrective prompt after a review rejection — the runner's cue that THIS
 * `prompt()` call is the corrective retry, not the initial investigation.
 */
const REVIEW_FEEDBACK_MARKER = 'An independent review flagged these claims as unsupported'
/** The one claim the fixture ever flags, and the one `createMockWorkerReviewComplete` rejects on sight — dropped from the corrected draft. */
export const MOCK_UNSUPPORTED_CLAIM_TEXT =
  'Every keto dieter loses at least 10 kg in the first month.'

/**
 * `flagged`: true for the INITIAL draft of a goal containing the
 * `UNSUPPORTED_GOAL_SENTINEL` — includes one claim `createMockWorkerReviewComplete`
 * is guaranteed to reject. A corrective retry (detected via
 * `REVIEW_FEEDBACK_MARKER` in `prompt()`) always drops it: the reject→correct→pass
 * dev path exercises a genuinely different, corrected report rather than
 * replaying the same rejected text (issue #17 re-review, Fix 3 dev-fixture
 * honesty). Every other goal never includes the claim, so it passes review
 * on the first attempt.
 */
function mockWorkerReport(flagged: boolean): WorkerReport {
  return {
    version: WORKER_REPORT_VERSION,
    title: 'Research summary',
    summary:
      'A generic canned research summary (dev stand-in; no provider key configured — the real ' +
      'Agent loop replaces this runner outright).',
    sections: [
      {
        heading: 'Findings',
        body:
          'This is a deterministic, zero-network dev report used to exercise the Worker ' +
          'pipeline (budget, delivery, review) end-to-end without a provider key.',
      },
    ],
    ...(flagged
      ? {
          claims: [
            {
              text: MOCK_UNSUPPORTED_CLAIM_TEXT,
              support: 'Not independently verifiable from this canned dev report.',
            },
          ],
        }
      : {}),
  }
}

/**
 * Deterministic, zero-network `AgentRunner` for Workers (issue #17, plan v2
 * T6): the dev stand-in until the real Agent loop lands, same spirit as
 * `MockAgentRunner`/`mockReaderComplete`. On `prompt()` it appends the user
 * turn to its session, then emits exactly one `turn-end` whose text is a
 * valid `worker-report/v1` report — enough for the `WorkerPool` to exercise
 * its budget/delivery/review wiring with no API key.
 *
 * Unlike `MockAgentRunner`, `abort()` has real stop semantics: a yield point
 * at the start of `prompt()` (and a check after each subsequent await) means
 * an `abort()` call that lands while a run is in flight — e.g. the
 * `WorkerPool`'s cancel-button handler, which reacts to a fast mutation on a
 * separate turn of the event loop — reliably prevents the `turn-end` from
 * ever being emitted, rather than merely racing it.
 */
export function createMockWorkerRunner(
  sessionStore: SessionStore = new MemorySessionStore(),
): AgentRunner {
  const events = new AgentEventBus()
  let sessionId: string | undefined
  let aborted = false

  return {
    async start(id: string): Promise<void> {
      sessionId = id
    },

    async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
      if (!sessionId) {
        throw new Error('createMockWorkerRunner: start must be called before prompt')
      }
      const activeSessionId = sessionId

      // Always yield once before touching the session or emitting, so a
      // synchronous `abort()` call that lands right after this promise is
      // fired (fire-and-forget, the WorkerPool's own call shape) still has
      // a scheduling point to take effect on before anything happens.
      await Promise.resolve()
      if (aborted) return

      if (options.retryOfFailedTurn !== true) {
        await sessionStore.append(activeSessionId, {
          type: 'message',
          message: { role: 'user', content: input },
        })
      }
      if (aborted) return

      // A corrective retry (the review-feedback note is present) always
      // drops the flagged claim, regardless of the goal — that is the
      // "genuinely corrected" draft. Otherwise the INITIAL draft is flagged
      // only for a goal containing the sentinel; every other goal is never
      // flagged and so passes review immediately.
      const isCorrectiveRetry = input.includes(REVIEW_FEEDBACK_MARKER)
      const flagged = !isCorrectiveRetry && input.toLowerCase().includes(UNSUPPORTED_GOAL_SENTINEL)
      const report = mockWorkerReport(flagged)
      const text = JSON.stringify(report)

      await sessionStore.append(activeSessionId, {
        type: 'message',
        message: { role: 'assistant', content: text },
      })
      if (aborted) return

      await events.emit({
        type: 'turn-end',
        sessionId: activeSessionId,
        model: options.model ?? MOCK_WORKER_MODEL,
        text,
        tokensUsed: MOCK_TOKENS_USED,
      })
    },

    abort(): void {
      aborted = true
    },

    on(handler: (event: AgentEvent) => Promise<void> | void): () => void {
      return events.on(handler)
    },
  }
}

/**
 * Deterministic dev stand-in for the Worker adversarial review's LLM call
 * (issue #17, plan v2 B5/T6, mirrors `mockReaderComplete`): the dev profile
 * has no provider keys by design, so every review reports a passing
 * verdict — enough to demonstrate the "review passed" acceptance criterion
 * without a provider client. The real provider client lands with the Agent
 * loop, same as chat and the quarantined reader.
 */
export const mockWorkerReviewComplete: (
  model: ModelRef,
  prompt: string,
) => Promise<{ text: string; costUsd?: number }> = async (_model, _prompt) => {
  return { text: JSON.stringify({ verdict: 'pass', unsupportedClaims: [] }) }
}

/**
 * Dev fixture for acceptance C end-to-end (issue #17, plan v2; content-driven
 * as of the re-review's Fix 3): a reject-then-pass variant of
 * `mockWorkerReviewComplete` keyed on the REPORT DATA embedded in
 * `buildReviewPrompt`'s output, not on a call counter. A submitted draft that
 * still contains `MOCK_UNSUPPORTED_CLAIM_TEXT` (the flagged claim
 * `createMockWorkerRunner` puts in a goal-sentinel'd INITIAL draft) is
 * rejected with that claim named and a suggested caveat; a draft that has
 * dropped it — the runner's genuinely corrected retry, or any default goal
 * that was never flagged to begin with — passes. This ties the verdict to
 * the actual content under review, so `WorkerPool`'s revision-tracking
 * (Fix 3) sees a real change between the rejected and corrected drafts
 * instead of the same text passed through twice. Dev-only stand-in: the real
 * provider client replaces it outright once the Agent loop lands.
 */
export function createMockWorkerReviewComplete(): (
  model: ModelRef,
  prompt: string,
) => Promise<{ text: string; costUsd?: number }> {
  return async (_model, prompt) => {
    if (prompt.includes(MOCK_UNSUPPORTED_CLAIM_TEXT)) {
      return {
        text: JSON.stringify({
          verdict: 'reject',
          unsupportedClaims: [MOCK_UNSUPPORTED_CLAIM_TEXT],
          suggestedCaveat: 'This dev report could not be fully verified by an independent review.',
        }),
      }
    }
    return { text: JSON.stringify({ verdict: 'pass', unsupportedClaims: [] }) }
  }
}
