import { z } from 'zod'
import { neutralizeDelimiters } from './taint.ts'

/**
 * Worker briefing + report contract (issue #17, plan v2 T1): a Worker is an
 * ephemeral background investigate-and-report step, spawned by the Agent
 * (`spawn_worker`, T5) and run by the `WorkerPool` (T4) in an isolated
 * session. The briefing is the deterministic, daemon-computed input to that
 * run; the report is the ONLY thing a Worker is ever allowed to hand back —
 * a versioned, schema-validated shape, never free text, so a Worker can only
 * ever corrupt data fields, not steer anything downstream (mirrors the
 * quarantined reader's `ReaderOutputSchema`, docs/SECURITY.md §3.1).
 */
export const WorkerBriefingSchema = z
  .object({
    goal: z.string().trim().min(1),
    allowedTools: z.array(z.string().min(1)).default([]),
    boundaries: z.array(z.string().min(1)).default([]),
    tokenBudget: z.number().int().positive(),
    maxIterations: z.number().int().min(5).max(8),
    tier: z.enum(['triage', 'reasoning']),
    highRisk: z.boolean().default(false),
  })
  .strict()

export type WorkerBriefing = z.infer<typeof WorkerBriefingSchema>

export const WORKER_REPORT_VERSION = 'worker-report/v1'

export const WorkerReportSchema = z
  .object({
    version: z.literal(WORKER_REPORT_VERSION),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    sections: z
      .array(
        z
          .object({
            heading: z.string().min(1).max(200),
            body: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(500),
            support: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    caveat: z.string().min(1).max(1000).optional(),
  })
  .strict()

export type WorkerReport = z.infer<typeof WorkerReportSchema>

const CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i

/** Shared with worker-review.ts, which has the same fenced-JSON convention for its verdict. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = CODE_FENCE_RE.exec(trimmed)
  return match?.[1] !== undefined ? match[1].trim() : trimmed
}

export type ParseWorkerReportOutcome = { ok: true; report: WorkerReport } | { ok: false }

/**
 * Strips an optional code fence, parses JSON, then validates against
 * `WorkerReportSchema`. Any failure (invalid JSON, schema mismatch) collapses
 * to `{ ok: false }` — never throws, never repairs — the caller (T4) decides
 * whether to retry, fall back to the last valid report, or deliver a
 * deterministic daemon-authored fallback (plan v2 B6).
 */
export function parseWorkerReport(text: string): ParseWorkerReportOutcome {
  let json: unknown
  try {
    json = JSON.parse(stripCodeFence(text))
  } catch {
    return { ok: false }
  }
  const parsed = WorkerReportSchema.safeParse(json)
  return parsed.success ? { ok: true, report: parsed.data } : { ok: false }
}

const PROMPT_PREAMBLE =
  'You are a Worker: an ephemeral background investigate-and-report step, ' +
  'spawned to investigate one goal and then stop. You have no memory beyond ' +
  `this run. Investigate the goal below, then output ONLY JSON matching the ${WORKER_REPORT_VERSION} ` +
  'schema — no prose before or after the JSON, no commentary, no markdown outside the JSON value itself.'

const REPORT_SHAPE =
  `Schema (${WORKER_REPORT_VERSION}): {"version":"${WORKER_REPORT_VERSION}","title":string,` +
  '"summary":string,"sections":[{"heading":string,"body":string}],' +
  '"claims"?:[{"text":string,"support":string}],"caveat"?:string}'

function correctiveNote(corrective: string): string {
  // Names the failure category only; never echoes prior model output back
  // into the prompt (mirrors quarantined-reader.ts's `correctiveNote`).
  return (
    `\n\nYour previous output failed validation (${corrective}). ` +
    `Re-emit JSON that matches the ${WORKER_REPORT_VERSION} schema exactly, with no extra keys and no commentary.`
  )
}

/**
 * A review REJECTION is not a schema failure — the JSON was valid, an
 * independent reviewer refuted its content (worker-review.ts). Naming it
 * "failed validation" would be actively wrong, so this gets its own note.
 * Each claim is run through `neutralizeDelimiters`: the reviewer's
 * `unsupportedClaims` echo text drawn from the report, which may itself
 * originate from a tainted turn (worker-review.ts's own docstring).
 */
function reviewFeedbackNote(unsupportedClaims: string[]): string {
  const claims = unsupportedClaims.map((claim) => `- ${neutralizeDelimiters(claim)}`).join('\n')
  return (
    '\n\nAn independent review flagged these claims as unsupported — revise, remove, or add support ' +
    `for them:\n${claims}`
  )
}

const GOAL_LABEL_MAX_LENGTH = 80

/**
 * Truncates a goal string to a short label (mirrors `activeWorkerSurface`'s
 * stable-title requirement: computed once, at spawn time). Shared by
 * `spawn_worker`'s tool handler and the dev `research <topic>` chat
 * stand-in in server.ts.
 */
export function truncateGoalLabel(goal: string, max: number = GOAL_LABEL_MAX_LENGTH): string {
  const trimmed = goal.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/**
 * Builds the Worker's investigation prompt: fixed preamble, the goal, any
 * hard-constraint boundaries, and the exact expected report shape — the
 * "output format with schema" the issue requires (plan v2, T1 final fix).
 * `reviewFeedback` (acceptance C) takes precedence over `corrective`: a
 * rejected review is never a schema failure, so it never gets the "failed
 * validation" wording.
 */
export function buildWorkerPrompt(
  briefing: WorkerBriefing,
  options?: { corrective?: string; reviewFeedback?: { unsupportedClaims: string[] } },
): string {
  const parts = [PROMPT_PREAMBLE, `Goal: ${briefing.goal}`]

  if (briefing.boundaries.length > 0) {
    parts.push(
      `Hard constraints (never violate these):\n${briefing.boundaries.map((boundary) => `- ${boundary}`).join('\n')}`,
    )
  }

  parts.push(REPORT_SHAPE)

  if (options?.reviewFeedback !== undefined) {
    parts.push(reviewFeedbackNote(options.reviewFeedback.unsupportedClaims).trim())
  } else if (options?.corrective !== undefined) {
    parts.push(correctiveNote(options.corrective).trim())
  }

  return parts.join('\n\n')
}
