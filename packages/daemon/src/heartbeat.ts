import type { JsonObject } from '@veduta/protocol'
import { z } from 'zod'
import type { ModelRef } from './agent-runner.ts'
import { automationsSurfaceId } from './automations-surface.ts'
import { nextCronOccurrence } from './cron.ts'
import { timeToCron, type HeartbeatConfig } from './heartbeat-config.ts'
import { SpendingCapError, type ModelRouter } from './model-routing.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import type { Origin } from './taint.ts'

/**
 * The Heartbeat (issue #16, ADR-0005): the daemon's own proactivity loop.
 * Twice a day (configurable), a deterministic checklist gathers signals
 * about every Space's Surfaces, one triage-tier model call judges whether
 * anything needs attention, and only when it finds concerns does one
 * reasoning-tier call pick which KIND of action each concern gets. All
 * action payloads (timer cron/description/target) are computed here, in
 * the daemon, deterministically — the model only ever returns enums, ids
 * and booleans, never free text that gets logged or shown (docs/SECURITY.md,
 * design invariants). The Scheduler owns recurrence; the Heartbeat is a
 * visible System-Space Automation like any other (issue #11).
 */

const HeartbeatConcernSchema = z
  .object({
    spaceId: z.string().min(1),
    surfaceId: z.string().min(1).optional(),
    kind: z.enum(['stale-surface', 'uncovered-time-sensitive']),
  })
  .strict()

export type HeartbeatConcern = z.infer<typeof HeartbeatConcernSchema>

export const TriageOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('nothing') }).strict(),
  z
    .object({ status: z.literal('concerns'), concerns: z.array(HeartbeatConcernSchema).min(1) })
    .strict(),
])

export type TriageOutput = z.infer<typeof TriageOutputSchema>

/**
 * `justification` is required, non-empty, whenever `action` is `escalate`
 * (issue #18, plan v2 decision 2): the model must state why a good human
 * assistant would interrupt for this — never daemon boilerplate. Absent or
 * empty for `arm-timer`/`ignore`. A `superRefine` (not a discriminated
 * union) keeps the three actions sharing one flat shape, matching this
 * repo's existing conditional-field idiom (`notifications-config.ts`'s
 * `NotificationsConfigSchema`).
 */
const HeartbeatDecisionSchema = z
  .object({
    spaceId: z.string().min(1),
    surfaceId: z.string().min(1).optional(),
    action: z.enum(['arm-timer', 'escalate', 'ignore']),
    justification: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.action === 'escalate' && decision.justification === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['justification'],
        message: 'escalate decisions require a non-empty justification',
      })
    }
  })

export const ReasonOutputSchema = z.object({ decisions: z.array(HeartbeatDecisionSchema) }).strict()

export type ReasonOutput = z.infer<typeof ReasonOutputSchema>

/**
 * Context threaded through `onEscalation` (issue #18, plan v2 decisions
 * 2-3): the same shape the Scheduler passes, plus the triage-model-supplied
 * `justification`. `automationId` never applies to a Heartbeat concern (it
 * names no Automation of its own), so it is always absent here.
 */
export interface HeartbeatEscalationContext {
  surfaceId?: string
  origin?: Origin
  automationId?: number
  justification?: string
}

/** Pure, LLM-free per-Surface signals (`buildChecklist`): ids and booleans only, never titles. */
export interface ChecklistSurface {
  surfaceId: string
  isStale: boolean
  ageHours: number
  isTimeSensitive: boolean
  hasCoverage: boolean
}

export interface HeartbeatChecklist {
  at: string
  spaces: { spaceId: string; surfaces: ChecklistSurface[] }[]
}

export interface HeartbeatMetrics {
  date: string
  sweeps: number
  nothing: number
  acted: number
  /** `nothing / (nothing + acted)`, excluding capped sweeps; null when there is nothing to divide. */
  nothingRatio: number | null
  avgCostUsd: number | null
}

export interface HeartbeatOptions {
  store: Store
  scheduler: Scheduler
  router: ModelRouter
  config: HeartbeatConfig
  /** No tools by construction, same idiom as the quarantined reader: a model and a prompt in, text and cost out. */
  complete: (model: ModelRef, prompt: string) => Promise<{ text: string; costUsd?: number }>
  now?: () => Date
  onEscalation?: (spaceId: string, text: string, context?: HeartbeatEscalationContext) => void
  /** Fired after every recorded sweep so the metrics Surface manager can refresh. */
  onSwept?: () => void
}

/**
 * Deterministic pre-signal only (never sent verbatim — only the resulting
 * boolean crosses into a prompt): a Surface whose title suggests it needs
 * to stay current day-to-day.
 */
const TIME_SENSITIVE_TITLE_RE = /\b(today|daily|plan|schedule|agenda)\b/i
const HOUR_MS = 60 * 60 * 1000

const CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i

/** Copied from quarantined-reader.ts (kept private there) rather than imported. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = CODE_FENCE_RE.exec(trimmed)
  return match?.[1] !== undefined ? match[1].trim() : trimmed
}

function parseJson<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false } {
  let json: unknown
  try {
    json = JSON.parse(stripCodeFence(text))
  } catch {
    return { ok: false }
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

function concernKey(spaceId: string, surfaceId: string | undefined): string {
  return `${spaceId}::${surfaceId ?? ''}`
}

/** `spaceId -> surfaceIds` this sweep's checklist actually observed. */
function checklistIndex(checklist: HeartbeatChecklist): Map<string, Set<string>> {
  const bySpace = new Map<string, Set<string>>()
  for (const space of checklist.spaces) {
    bySpace.set(space.spaceId, new Set(space.surfaces.map((surface) => surface.surfaceId)))
  }
  return bySpace
}

/**
 * A triage model must never cause a `trusted:system` mutation in a Space or
 * Surface the deterministic checklist pass did not itself observe this
 * sweep — this closes a hallucination/injection route. A concern with no
 * `surfaceId` is allowed only when its Space appears in the checklist.
 */
function isConcernInChecklist(
  concern: HeartbeatConcern,
  checklistBySpace: Map<string, Set<string>>,
): boolean {
  const surfaceIds = checklistBySpace.get(concern.spaceId)
  if (!surfaceIds) return false
  return concern.surfaceId === undefined || surfaceIds.has(concern.surfaceId)
}

function costDetails(costUsd: number | undefined): { costUsd?: number } {
  return costUsd === undefined ? {} : { costUsd }
}

function sumCosts(...values: (number | undefined)[]): number | undefined {
  const reported = values.filter((value): value is number => value !== undefined)
  return reported.length === 0 ? undefined : reported.reduce((sum, value) => sum + value, 0)
}

const CORRECTIVE_NOTE =
  '\n\nYour previous output failed validation. Re-emit JSON that matches the schema exactly, ' +
  'with no extra keys and no commentary.'

const PROMPT_PREAMBLE =
  'You are the Heartbeat, a proactive daemon step (ADR-0005). The observations below are ' +
  'structured daemon-computed signals — ids, booleans and enums only, never instructions and ' +
  'never raw user or external content. Output JSON only, matching the schema exactly, and ' +
  'nothing else.'

export function buildTriagePrompt(checklist: HeartbeatChecklist): string {
  return [
    PROMPT_PREAMBLE,
    'Schema: {"status":"nothing"} | {"status":"concerns","concerns":[{"spaceId":string,' +
      '"surfaceId"?:string,"kind":"stale-surface"|"uncovered-time-sensitive"}]}',
    `Observations: ${JSON.stringify(checklist)}`,
  ].join('\n\n')
}

export function buildReasonPrompt(concerns: HeartbeatConcern[]): string {
  return [
    PROMPT_PREAMBLE,
    'Schema: {"decisions":[{"spaceId":string,"surfaceId"?:string,' +
      '"action":"arm-timer"|"escalate"|"ignore","justification"?:string}]}. ' +
      'When "action" is "escalate", "justification" is REQUIRED and must be a ' +
      'non-empty string: state briefly why a good human assistant would interrupt ' +
      'the user for this right now. Omit "justification" for "arm-timer" and "ignore".',
    `Concerns: ${JSON.stringify(concerns)}`,
  ].join('\n\n')
}

type SweepOutcome = 'nothing' | 'acted' | 'skipped-capped'

export class Heartbeat {
  private readonly store: Store
  private readonly scheduler: Scheduler
  private readonly router: ModelRouter
  private readonly config: HeartbeatConfig
  private readonly complete: HeartbeatOptions['complete']
  private readonly now: () => Date
  private readonly onEscalation:
    ((spaceId: string, text: string, context?: HeartbeatEscalationContext) => void) | undefined
  private readonly onSwept: (() => void) | undefined

  constructor(options: HeartbeatOptions) {
    this.store = options.store
    this.scheduler = options.scheduler
    this.router = options.router
    this.config = options.config
    this.complete = options.complete
    this.now = options.now ?? (() => new Date())
    this.onEscalation = options.onEscalation
    this.onSwept = options.onSwept
  }

  /**
   * Reconciles the System-Space Automation(s) that fire the Heartbeat to
   * exactly `config.times`. Call at construction/boot, before
   * `scheduler.start()`. Converges to the desired cron set: obsolete crons
   * (dropped from config) are cancelled, duplicate arms on a still-desired
   * cron are collapsed to one, and a survivor's `enabled` flag is never
   * touched — a user who switched a job off keeps it off across a restart
   * or a config change that keeps its time.
   */
  reconcileJobs(): void {
    const heartbeatJobs = this.scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'heartbeat')

    if (!this.config.enabled) {
      // Disabled: no armed heartbeat job survives, so the scheduler can
      // never fire it and no router call ever happens.
      for (const job of heartbeatJobs) {
        if (job.status !== 'cancelled') this.scheduler.cancel(job.id, 'trusted:system')
      }
      return
    }

    const desiredTimeByCron = new Map(this.config.times.map((time) => [timeToCron(time), time]))
    const armedJobs = heartbeatJobs.filter((job) => job.status !== 'cancelled')

    // Cancel every armed job whose cron is no longer desired.
    for (const job of armedJobs) {
      if (job.cron === undefined || !desiredTimeByCron.has(job.cron)) {
        this.scheduler.cancel(job.id, 'trusted:system')
      }
    }

    // Among jobs on a still-desired cron, keep exactly one (the first,
    // i.e. lowest id) survivor and cancel any extras — two live heartbeat
    // jobs firing the same instant must never coexist.
    const survivorByCron = new Map<string, boolean>()
    for (const job of armedJobs) {
      if (job.cron === undefined || !desiredTimeByCron.has(job.cron)) continue
      if (survivorByCron.has(job.cron)) {
        this.scheduler.cancel(job.id, 'trusted:system')
      } else {
        survivorByCron.set(job.cron, true)
      }
    }

    for (const [cron, time] of desiredTimeByCron) {
      if (survivorByCron.has(cron)) continue
      this.scheduler.createManagedJob(
        {
          spaceId: SYSTEM_SPACE_ID,
          cron,
          description: `Heartbeat sweep at ${time} UTC`,
          handler: 'heartbeat',
        },
        'trusted:system',
      )
    }
  }

  /** Wires the Scheduler's generic handler registry to `runSweep`. Call before `scheduler.start()`. */
  register(): void {
    this.scheduler.registerHandler('heartbeat', (ctx) =>
      this.runSweep(`${ctx.automation.id}::${ctx.scheduledFor}`),
    )
  }

  /**
   * Pure, non-LLM checklist (ADR-0005): every non-archived, non-System
   * Space's non-daemon-owned Surfaces, reduced to ids and booleans. A
   * Surface is a candidate only when it is stale-and-time-sensitive, or
   * time-sensitive-and-uncovered — anything else contributes nothing.
   */
  buildChecklist(): HeartbeatChecklist {
    const at = this.nowIso()
    const spaces: HeartbeatChecklist['spaces'] = []

    for (const space of this.store.listSpaces()) {
      if (space.id === SYSTEM_SPACE_ID) continue

      const automations = this.scheduler.listAutomations(space.id)
      const excludedSurfaceIds = new Set<string>([
        this.store.spacesEngine.factsSurface(space.id).id,
        automationsSurfaceId(space.slug),
      ])

      const surfaces: ChecklistSurface[] = []
      for (const surface of this.store.listSurfaces(space.id)) {
        if (excludedSurfaceIds.has(surface.id)) continue

        const ageHours =
          (this.now().getTime() - new Date(surface.freshness.updatedAt).getTime()) / HOUR_MS
        const isStale = ageHours > this.config.staleAfterHours
        const isTimeSensitive = TIME_SENSITIVE_TITLE_RE.test(surface.title)
        const hasCoverage = automations.some(
          (automation) =>
            automation.status === 'armed' &&
            automation.enabled &&
            automation.targetSurfaceId === surface.id,
        )

        if ((isStale && isTimeSensitive) || (isTimeSensitive && !hasCoverage)) {
          surfaces.push({ surfaceId: surface.id, isStale, ageHours, isTimeSensitive, hasCoverage })
        }
      }

      if (surfaces.length > 0) spaces.push({ spaceId: space.id, surfaces })
    }

    return { at, spaces }
  }

  /**
   * The Scheduler handler body: exactly one triage-tier call per sweep
   * (unless disabled or capped), a reasoning-tier call only when triage
   * finds concerns the checklist itself observed, then deterministic
   * execution of the decisions. Returns the occurrence outcome string.
   *
   * `occurrence` is the Scheduler's `(automationId, scheduledFor)` pair —
   * the occurrence's true identity, composed by `register()` — so two
   * distinct heartbeat jobs firing the same instant are never merged in
   * metrics, while every at-least-once recovery re-run of one scheduled
   * instant still shares the same key. A direct/manual sweep passes none —
   * it is inherently unique and always counted.
   *
   * If the daily spending cap is crossed mid-sweep (e.g. between the
   * triage and reasoning calls), the sweep is recorded as `'skipped-capped'`
   * rather than throwing out of the Scheduler handler.
   */
  async runSweep(occurrence?: string): Promise<string> {
    if (!this.config.enabled) return 'skipped:disabled'

    if (!this.router.proactivityAllowed('triage')) {
      return this.finishSweep('skipped-capped', {}, occurrence)
    }

    try {
      const checklist = this.buildChecklist()
      const triageCall = await this.completeStructured(
        'heartbeat',
        buildTriagePrompt(checklist),
        TriageOutputSchema,
      )
      // Fail safe: a triage completion that never validates (even after
      // the one corrective retry) is treated as "nothing" — never act on
      // garbage.
      const triage: TriageOutput = triageCall.value ?? { status: 'nothing' }

      if (triage.status === 'nothing') {
        return this.finishSweep('nothing', costDetails(triageCall.costUsd), occurrence)
      }

      // Hallucination/injection guard: only concerns whose (spaceId,
      // surfaceId) pair actually appears in the checklist this sweep built
      // may proceed to the reasoning tier or to execution.
      const checklistBySpace = checklistIndex(checklist)
      const concerns = triage.concerns.filter((concern) =>
        isConcernInChecklist(concern, checklistBySpace),
      )

      if (concerns.length === 0) {
        return this.finishSweep('nothing', costDetails(triageCall.costUsd), occurrence)
      }

      const reasonCall = await this.completeStructured(
        'heartbeat-reasoning',
        buildReasonPrompt(concerns),
        ReasonOutputSchema,
      )
      // Same fail-safe: an unparseable reasoning completion executes zero
      // decisions rather than acting on garbage; the sweep still counts as
      // "acted" because triage did find concerns worth a reasoning pass.
      const decisions = reasonCall.value?.decisions ?? []
      this.executeDecisions(decisions, concerns)

      return this.finishSweep(
        'acted',
        {
          concernCount: concerns.length,
          ...costDetails(sumCosts(triageCall.costUsd, reasonCall.costUsd)),
        },
        occurrence,
      )
    } catch (error) {
      if (!(error instanceof SpendingCapError)) throw error
      return this.finishSweep('skipped-capped', {}, occurrence)
    }
  }

  /**
   * Today's Heartbeat metrics from the System Space Event log. Dedupes by
   * scheduler occurrence: an event carrying a `payload.occurrence` is counted
   * once per distinct occurrence value, so an at-least-once recovery re-run
   * of the same scheduled instant (a LATER wall-clock, same `scheduledFor`)
   * never inflates the count. An event without an `occurrence` (a direct/
   * manual sweep) is inherently unique and always counted. `payload.at` is
   * wall-clock, informational only, never a dedup key. `nothingRatio`'s
   * denominator excludes capped sweeps.
   */
  metrics(): HeartbeatMetrics {
    const date = this.today()
    const startOfTodayIso = `${date}T00:00:00.000Z`
    const events = this.store
      .eventLogSince(SYSTEM_SPACE_ID, startOfTodayIso)
      .filter((event) => event.type === 'heartbeat.sweep')

    const seenOccurrences = new Set<string>()
    let sweeps = 0
    let nothing = 0
    let acted = 0
    const costs: number[] = []

    for (const event of events) {
      const occurrence = event.payload?.['occurrence']
      if (typeof occurrence === 'string') {
        if (seenOccurrences.has(occurrence)) continue
        seenOccurrences.add(occurrence)
      }

      sweeps += 1
      const outcome = event.payload?.['outcome']
      if (outcome === 'nothing') nothing += 1
      else if (outcome === 'acted') acted += 1

      const cost = event.payload?.['costUsd']
      if (typeof cost === 'number') costs.push(cost)
    }

    const denominator = nothing + acted
    return {
      date,
      sweeps,
      nothing,
      acted,
      nothingRatio: denominator === 0 ? null : nothing / denominator,
      avgCostUsd:
        costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0) / costs.length,
    }
  }

  /**
   * One ordered attempt, then one corrective retry, then a caller-provided
   * fallback (`value: undefined`) — never a third attempt, never acting on
   * garbage. Accumulates reported cost across both attempts.
   */
  private async completeStructured<T>(
    purpose: 'heartbeat' | 'heartbeat-reasoning',
    prompt: string,
    schema: z.ZodType<T>,
  ): Promise<{ value: T | undefined; costUsd?: number }> {
    let costUsd: number | undefined

    const attempt = async (text: string) => {
      const responseText = await this.router.execute(
        { purpose, origin: 'proactive' },
        async (model) => {
          const response = await this.complete(model, text)
          if (response.costUsd !== undefined) {
            this.router.recordSpend(model, response.costUsd)
            costUsd = (costUsd ?? 0) + response.costUsd
          }
          return response.text
        },
      )
      return parseJson(responseText, schema)
    }

    const first = await attempt(prompt)
    if (first.ok) return { value: first.value, ...costDetails(costUsd) }

    const second = await attempt(`${prompt}${CORRECTIVE_NOTE}`)
    if (second.ok) return { value: second.value, ...costDetails(costUsd) }

    return { value: undefined, ...costDetails(costUsd) }
  }

  /**
   * Executes decisions deterministically. A decision is only ever acted on
   * when it matches a concern this very sweep's triage actually raised —
   * the reasoning model picks a KIND, never a target of its own choosing,
   * so a hallucinated or injected spaceId/surfaceId can never reach a
   * mutation.
   */
  private executeDecisions(
    decisions: ReasonOutput['decisions'],
    concerns: HeartbeatConcern[],
  ): void {
    const byKey = new Map<string, HeartbeatConcern>()
    for (const concern of concerns)
      byKey.set(concernKey(concern.spaceId, concern.surfaceId), concern)

    for (const decision of decisions) {
      const concern = byKey.get(concernKey(decision.spaceId, decision.surfaceId))
      if (!concern) continue
      if (decision.action === 'arm-timer') this.armTimerForConcern(concern)
      else if (decision.action === 'escalate') this.escalateConcern(concern, decision.justification)
    }
  }

  /** Idempotent: a Surface already covered by an armed, enabled timer is left alone. */
  private armTimerForConcern(concern: HeartbeatConcern): void {
    const surfaceId = concern.surfaceId
    if (!surfaceId) return

    const covered = this.scheduler
      .listAutomations(concern.spaceId)
      .some(
        (automation) =>
          automation.status === 'armed' &&
          automation.enabled &&
          automation.targetSurfaceId === surfaceId,
      )
    if (covered) return

    const automation = this.scheduler.armTimer(
      {
        spaceId: concern.spaceId,
        when: this.nextHeartbeatIso(),
        action: `Heartbeat coverage check (${concern.kind})`,
        targetSurfaceId: surfaceId,
      },
      'trusted:system',
    )
    this.appendSpaceEvent(
      concern.spaceId,
      'heartbeat.action',
      `Heartbeat armed a coverage timer for a Surface (kind: ${concern.kind})`,
      { surfaceId, kind: concern.kind, automationId: automation.id },
    )
  }

  /** Reserved for concerns with no self-heal: a deterministic, daemon-composed notice. */
  private escalateConcern(concern: HeartbeatConcern, justification: string | undefined): void {
    const text =
      concern.kind === 'stale-surface'
        ? 'Heartbeat: a Surface has gone stale with no automated self-heal available — please take a look.'
        : 'Heartbeat: a time-sensitive Surface has no coverage and no automated self-heal available — please take a look.'
    // The same origin this method stamps on its own `heartbeat.escalate`
    // Space event below (issue #18, plan v2 decision 3) — reused, not
    // re-derived, so the notification's provenance always matches the log.
    const origin: Origin = 'trusted:system'
    this.onEscalation?.(concern.spaceId, text, {
      ...(concern.surfaceId === undefined ? {} : { surfaceId: concern.surfaceId }),
      origin,
      ...(justification === undefined ? {} : { justification }),
    })
    this.appendSpaceEvent(concern.spaceId, 'heartbeat.escalate', text, {
      ...(concern.surfaceId === undefined ? {} : { surfaceId: concern.surfaceId }),
      kind: concern.kind,
    })
  }

  /** Record the sweep in the Event log, refresh the metrics Surface, and return the outcome. */
  private finishSweep(
    outcome: SweepOutcome,
    details: { concernCount?: number; costUsd?: number },
    occurrence: string | undefined,
  ): string {
    this.recordSweep(outcome, details, occurrence)
    this.onSwept?.()
    return outcome
  }

  private recordSweep(
    outcome: SweepOutcome,
    details: { concernCount?: number; costUsd?: number },
    occurrence?: string,
  ): void {
    const at = this.nowIso()
    this.store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
      type: 'heartbeat.sweep',
      text: `Heartbeat sweep: ${outcome}`,
      origin: 'trusted:system',
      payload: {
        outcome,
        // Wall-clock, informational only — never the dedup key.
        at,
        // The scheduler occurrence: metrics dedups on this so a recovery
        // re-run of the same instant counts once. Absent for a direct sweep.
        ...(occurrence === undefined ? {} : { occurrence }),
        ...(details.concernCount === undefined ? {} : { concernCount: details.concernCount }),
        ...(details.costUsd === undefined ? {} : { costUsd: details.costUsd }),
      },
      at,
    })
  }

  private appendSpaceEvent(spaceId: string, type: string, text: string, payload: JsonObject): void {
    this.store.spacesEngine.appendEvent(spaceId, {
      type,
      text,
      origin: 'trusted:system',
      payload,
      at: this.nowIso(),
    })
  }

  /** The soonest configured heartbeat time from now, or +24h as a defensive fallback. */
  private nextHeartbeatIso(): string {
    const now = this.now()
    const occurrences = this.config.times.map((time) => nextCronOccurrence(timeToCron(time), now))
    const [first, ...rest] = occurrences
    if (!first) return new Date(now.getTime() + 24 * HOUR_MS).toISOString()
    return rest
      .reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest), first)
      .toISOString()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private today(): string {
    return this.nowIso().slice(0, 10)
  }
}
