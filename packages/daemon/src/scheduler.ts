import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonObject, PatchOperation } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import {
  automationIdFromStateKey,
  automationsListNode,
  automationsState,
  automationsSurface,
  automationsSurfaceId,
  type AutomationListItem,
} from './automations-surface.ts'
import { nextCronOccurrence, parseCron } from './cron.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'
import {
  ConditionSchema,
  automationFromRow,
  initializeSchedulerSchema,
  type Automation,
  type Condition,
} from './scheduler-persistence.ts'
import type { FastMutationNotice, Store } from './store.ts'
import { effectiveOrigin, isValidOrigin, toolWriteOrigin, type Origin } from './taint.ts'

export { ConditionSchema }
export type { Automation, Condition }

/**
 * The daemon's scheduling system (issue #11, ADR-0005): one-shot timers
 * and recurring jobs, persisted in SQLite, exposed to the Agent as tools
 * and to the user as a per-Space Automations Surface. Timers replace
 * "I'll remember it": every learned deadline arms one.
 *
 * Execution is at-least-once: an occurrence is claimed durably before
 * side effects run, and interrupted claims are re-run on the next boot —
 * a duplicate reminder beats a lost deadline.
 */
export type JudgeVerdict = 'yes' | 'no' | 'unknown'

/**
 * Answers a judgment condition. The server wires this to the triage
 * tier through the ModelRouter with `origin: 'proactive'`, so the
 * daily spending caps govern scheduler judgments too.
 */
export type JudgeFn = (question: string, spaceId: string) => Promise<JudgeVerdict> | JudgeVerdict

/**
 * Context threaded through `onEscalation` for a firing occurrence (issue #18 2-3): `surfaceId` lets
 * the caller build a deep link, `origin` is the occurrence's own re-tainted origin (never a fresh
 * derivation), `automationId` is the durable link back to the Automation that fired.
 */
export interface EscalationContext {
  surfaceId?: string
  origin?: Origin
  automationId?: number
  /**
   * True for daemon-managed handler jobs (issue #16): their escalations
   * carry no Agent decision, so callers must not attribute an
   * "Agent-armed" justification to them.
   */
  managed: boolean
}

export interface SchedulerOptions {
  rootDir: string
  store: Store
  now?: () => Date
  /** Deliver an escalation to the user (chat notice); Space event is appended regardless. */
  onEscalation?: (spaceId: string, text: string, context?: EscalationContext) => void
  judge?: JudgeFn
}

/** Occurrences older than this at run time are reported, not executed (issue #11 catch-up policy). */
const CATCH_UP_LIMIT_MS = 24 * 60 * 60 * 1000
/** The run loop re-checks at least this often, so config drift self-heals. */
const MAX_SLEEP_MS = 15 * 60 * 1000
const MIN_SLEEP_MS = 1000

const ArmTimerSchema = z.object({
  spaceId: z.string().min(1),
  when: z.string().datetime({ offset: true }),
  condition: ConditionSchema.optional(),
  action: z.string().trim().min(1),
  /** The Surface this timer covers, if any (issue #16). */
  targetSurfaceId: z.string().min(1).optional(),
})

const CreateJobSchema = z.object({
  spaceId: z.string().min(1),
  cron: z.string().trim().min(1),
  briefing: z.string().trim().min(1),
  condition: ConditionSchema.optional(),
})

const CancelSchema = z.object({
  automationId: z.number().int().positive(),
})

export class Scheduler {
  private readonly db: DatabaseSync
  private readonly store: Store
  private readonly now: () => Date
  private readonly onEscalation:
    ((spaceId: string, text: string, context?: EscalationContext) => void) | undefined
  private readonly judge: JudgeFn
  private disposeFastMutationObserver: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** The run loop is armed only between start() and stop(). */
  private stopped = true
  /** Registered daemon-owned Automation handlers (issue #16), keyed by `Automation.handler`. */
  private readonly handlers = new Map<
    string,
    (ctx: { automation: Automation; scheduledFor: string }) => Promise<string> | string
  >()

  constructor(options: SchedulerOptions) {
    this.db = new DatabaseSync(join(options.rootDir, 'scheduler.sqlite'))
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.onEscalation = options.onEscalation
    this.judge = options.judge ?? (() => 'unknown')
    initializeSchedulerSchema(this.db)
    this.recoverInterruptedRuns()
    this.ensureSurfaces()
    this.subscribeToggles()
  }

  /** Arm the run loop: a single timeout to the earliest due occurrence. */
  start(): void {
    this.stopped = false
    if (!this.disposeFastMutationObserver) this.subscribeToggles()
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.disposeFastMutationObserver?.()
    this.disposeFastMutationObserver = undefined
  }

  private subscribeToggles(): void {
    this.disposeFastMutationObserver = this.store.onFastMutation((notice) =>
      this.syncToggleFromSurface(notice),
    )
  }

  armTimer(input: z.input<typeof ArmTimerSchema>, origin?: Origin): Automation {
    const parsed = ArmTimerSchema.parse(input)
    this.requireSpace(parsed.spaceId)
    const fireAt = new Date(parsed.when).toISOString()
    if (fireAt <= this.nowIso()) throw new Error(`timer must fire in the future: ${parsed.when}`)

    const automation = this.insertAutomation({
      kind: 'timer',
      spaceId: parsed.spaceId,
      description: parsed.action,
      fireAt,
      nextRunAt: fireAt,
      ...(parsed.condition === undefined ? {} : { condition: parsed.condition }),
      ...(parsed.targetSurfaceId === undefined ? {} : { targetSurfaceId: parsed.targetSurfaceId }),
      ...(origin === undefined ? {} : { origin }),
    })
    this.appendEvent(
      parsed.spaceId,
      'automation.arm',
      `Armed timer "${parsed.action}" for ${fireAt}`,
      {
        automationId: automation.id,
      },
      origin,
    )
    this.refreshSurface(parsed.spaceId)
    this.schedule()
    return automation
  }

  createJob(input: z.input<typeof CreateJobSchema>, origin?: Origin): Automation {
    const parsed = CreateJobSchema.parse(input)
    this.requireSpace(parsed.spaceId)
    parseCron(parsed.cron)
    const nextRunAt = nextCronOccurrence(parsed.cron, this.now()).toISOString()

    const automation = this.insertAutomation({
      kind: 'job',
      spaceId: parsed.spaceId,
      description: parsed.briefing,
      cron: parsed.cron,
      nextRunAt,
      ...(parsed.condition === undefined ? {} : { condition: parsed.condition }),
      ...(origin === undefined ? {} : { origin }),
    })
    this.appendEvent(
      parsed.spaceId,
      'automation.arm',
      `Created job "${parsed.briefing}" (cron ${parsed.cron}, next ${nextRunAt})`,
      { automationId: automation.id },
      origin,
    )
    this.refreshSurface(parsed.spaceId)
    this.schedule()
    return automation
  }

  /**
   * Internal-only counterpart to `createJob` (issue #16): creates a job
   * wired to a registered handler instead of the generic "briefing"
   * escalation. Deliberately not exposed as an Agent tool or through
   * `CreateJobSchema` — only daemon code may create handler-driven jobs.
   */
  createManagedJob(
    input: {
      spaceId: string
      cron: string
      description: string
      handler: string
      targetSurfaceId?: string
      /** Local wall-clock zone for `cron` (issue #21); see `Automation.timezone`. */
      timezone?: string
    },
    origin?: Origin,
  ): Automation {
    const handler = input.handler.trim()
    // An empty/blank handler must never reach a row: a job with no
    // registered handler falls through `executeOccurrence` to the
    // generic "Scheduled briefing" escalation, silently losing the
    // handler-driven behavior the caller intended.
    if (!handler) throw new Error('createManagedJob requires a non-empty handler name')

    this.requireSpace(input.spaceId)
    parseCron(input.cron)
    // An invalid timezone surfaces here, from `nextCronOccurrence`'s own
    // `assertTimeZone` call — no separate validation needed.
    const nextRunAt = nextCronOccurrence(input.cron, this.now(), input.timezone).toISOString()

    const automation = this.insertAutomation({
      kind: 'job',
      spaceId: input.spaceId,
      description: input.description,
      cron: input.cron,
      nextRunAt,
      handler,
      ...(input.targetSurfaceId === undefined ? {} : { targetSurfaceId: input.targetSurfaceId }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(origin === undefined ? {} : { origin }),
    })
    this.appendEvent(
      input.spaceId,
      'automation.arm',
      `Created job "${input.description}" (cron ${input.cron}, next ${nextRunAt})`,
      { automationId: automation.id },
      origin,
    )
    this.refreshSurface(input.spaceId)
    this.schedule()
    return automation
  }

  /**
   * Registers a daemon-owned Automation handler by name (issue #16): a
   * managed job's `handler` field looks up its function here at occurrence
   * time. This file is generic — it knows nothing about what any
   * registered handler does; the returned string becomes the occurrence
   * outcome, same as any other automation.
   */
  registerHandler(
    name: string,
    fn: (ctx: { automation: Automation; scheduledFor: string }) => Promise<string> | string,
  ): void {
    this.handlers.set(name, fn)
  }

  cancel(automationId: number, origin?: Origin): Automation {
    const automation = this.requireAutomation(automationId)
    if (automation.status === 'cancelled') return automation
    this.db
      .prepare(`update automations set status = 'cancelled', next_run_at = null where id = ?`)
      .run(automationId)
    this.appendEvent(
      automation.spaceId,
      'automation.cancel',
      `Cancelled automation "${automation.description}"`,
      { automationId },
      // The event embeds the automation's description: an untrusted-born
      // automation keeps its mark on every event that carries its text.
      effectiveOrigin([automation.origin, origin], origin ?? 'trusted:system'),
    )
    this.refreshSurface(automation.spaceId)
    return this.requireAutomation(automationId)
  }

  setEnabled(automationId: number, enabled: boolean, source: 'surface' | 'tool'): Automation {
    const automation = this.requireAutomation(automationId)
    if (automation.enabled === enabled) return automation
    this.db
      .prepare('update automations set enabled = ? where id = ?')
      .run(enabled ? 1 : 0, automationId)
    this.appendEvent(
      automation.spaceId,
      'automation.toggle',
      `Automation "${automation.description}" switched ${enabled ? 'on' : 'off'}`,
      { automationId, enabled },
      // Same rule as cancel(): the description's provenance wins over the
      // caller's — a tainted description never re-enters context as trusted.
      effectiveOrigin(
        [automation.origin],
        source === 'surface' ? 'trusted:user' : 'trusted:system',
      ),
    )
    // A Surface-originated toggle already mutated the Surface state on the
    // fast path; re-projecting would only duplicate events.
    if (source === 'tool') this.refreshSurface(automation.spaceId)
    return this.requireAutomation(automationId)
  }

  listAutomations(spaceId?: string): Automation[] {
    const rows =
      spaceId === undefined
        ? this.db.prepare('select * from automations order by id').all()
        : this.db.prepare('select * from automations where space_id = ? order by id').all(spaceId)
    return rows.map(automationFromRow)
  }

  /**
   * Claim and run every due occurrence. Single-flight: overlapping calls
   * return without running (the claim table still guards across restarts).
   */
  async runDue(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = this.nowIso()
      const due = this.db
        .prepare(
          `select * from automations where status = 'armed' and next_run_at <= ? order by id`,
        )
        .all(now)
        .map(automationFromRow)
      for (const automation of due) await this.runOccurrence(automation)
    } finally {
      this.running = false
    }
  }

  tools(): ToolDef[] {
    return [
      defineTool({
        name: 'arm_timer',
        description:
          'Arm a one-shot timer for a learned deadline or habit: at `when` the condition is checked and the user is escalated to unless it is already satisfied. Never promise to remember a deadline instead of arming a timer.',
        schema: ArmTimerSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const automation = this.armTimer(input, toolWriteOrigin(context.origin))
          return {
            content: `armed timer ${automation.id} for ${automation.nextRunAt}`,
            details: { automation },
          }
        },
      }),
      defineTool({
        name: 'create_job',
        description:
          'Create a recurring job (5-field cron, UTC) that delivers a briefing on every occurrence. Visible to the user as an Automation in its Space.',
        schema: CreateJobSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const automation = this.createJob(input, toolWriteOrigin(context.origin))
          return {
            content: `created job ${automation.id}, next run ${automation.nextRunAt}`,
            details: { automation },
          }
        },
      }),
      defineTool({
        name: 'cancel',
        description:
          'Cancel an Automation (timer or job) by id. It stops firing and leaves the Space Surface.',
        schema: CancelSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const automation = this.cancel(input.automationId, toolWriteOrigin(context.origin))
          return { content: `cancelled automation ${automation.id}`, details: { automation } }
        },
      }),
    ]
  }

  private async runOccurrence(automation: Automation): Promise<void> {
    const scheduledFor = automation.nextRunAt
    if (!scheduledFor) return
    if (!this.claim(automation.id, scheduledFor)) return

    let outcome: string
    try {
      outcome = await this.executeOccurrence(automation, scheduledFor)
    } catch (error) {
      outcome = `error:${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    }
    // Atomically: a finished claim always comes with the advanced
    // automation, or a crash leaves the claim unfinished and boot
    // recovery re-runs the occurrence. No half-finished zombies.
    withImmediateTransaction(this.db, () => {
      this.finishClaim(automation.id, scheduledFor, outcome)
      this.advance(automation, outcome)
    })
    this.refreshSurface(automation.spaceId)
  }

  private async executeOccurrence(automation: Automation, scheduledFor: string): Promise<string> {
    // Firing events carry the automation's own provenance (default
    // trusted:system for legacy/tool-armed automations): an automation
    // born from a tainted turn re-taints every occurrence it fires.
    const firingOrigin = automation.origin ?? 'trusted:system'
    // Shared by every onEscalation call this occurrence may make below: the
    // deep-link Surface (if any), the occurrence's own re-tainted origin
    // (never a fresh derivation), and the durable Automation link.
    const escalationContext: EscalationContext = {
      ...(automation.targetSurfaceId === undefined
        ? {}
        : { surfaceId: automation.targetSurfaceId }),
      origin: firingOrigin,
      automationId: automation.id,
      managed: automation.handler !== undefined,
    }
    if (!automation.enabled) {
      this.appendEvent(
        automation.spaceId,
        'automation.skip',
        `Automation "${automation.description}" was due while switched off — not run`,
        { automationId: automation.id, scheduledFor },
        firingOrigin,
      )
      return 'skipped:disabled'
    }

    const overdueMs = this.now().getTime() - new Date(scheduledFor).getTime()
    if (overdueMs >= CATCH_UP_LIMIT_MS) {
      const text = `Missed automation "${automation.description}": it was due ${scheduledFor} while the daemon was down for more than 24h, so it was not run.`
      this.appendEvent(
        automation.spaceId,
        'automation.skip',
        text,
        { automationId: automation.id, scheduledFor },
        firingOrigin,
      )
      this.onEscalation?.(automation.spaceId, text, escalationContext)
      return 'skipped:overdue'
    }

    if (automation.handler) {
      const handler = this.handlers.get(automation.handler)
      if (!handler) {
        this.appendEvent(
          automation.spaceId,
          'automation.skip',
          `Automation "${automation.description}" was due but its handler "${automation.handler}" is not registered — not run`,
          { automationId: automation.id, scheduledFor },
          firingOrigin,
        )
        return 'skipped:unknown-handler'
      }
      return await handler({ automation, scheduledFor })
    }

    if (await this.conditionSatisfied(automation, scheduledFor)) {
      this.appendEvent(
        automation.spaceId,
        'automation.fire',
        `Automation "${automation.description}" fired — condition already satisfied, no action`,
        { automationId: automation.id, scheduledFor },
        firingOrigin,
      )
      return 'condition-met:no-action'
    }

    const text =
      automation.kind === 'timer'
        ? `Reminder: ${automation.description}`
        : `Scheduled briefing: ${automation.description}`
    this.appendEvent(
      automation.spaceId,
      'automation.fire',
      `Automation "${automation.description}" fired — escalated to the user`,
      { automationId: automation.id, scheduledFor },
      firingOrigin,
    )
    this.onEscalation?.(automation.spaceId, text, escalationContext)
    return 'escalated'
  }

  /**
   * Deterministic first (ADR-0005): the Event log answers `event-logged`
   * conditions with zero LLM calls; only `judgment` consults the judge.
   * A judge failure escalates — never silently drop a deadline.
   */
  private async conditionSatisfied(automation: Automation, scheduledFor: string): Promise<boolean> {
    const condition = automation.condition
    if (!condition) return false

    if (condition.kind === 'event-logged') {
      const needle = condition.textIncludes.toLowerCase()
      const lookbackStart = new Date(
        new Date(scheduledFor).getTime() - condition.withinHours * 60 * 60 * 1000,
      ).toISOString()
      // Never look further back than when the Automation itself was armed
      // (issue #37): a chat turn is logged to the Space Event log the
      // instant it arrives (ADR-0003), so the very request that arms a
      // reminder — "remind me to log my weight by 9pm" — already contains
      // the condition's own needle. Without this floor, that request would
      // immediately satisfy its own condition and the reminder would never
      // escalate. `withinHours`'s lookback still applies for anything
      // armed further in the past.
      const windowStart =
        automation.createdAt > lookbackStart ? automation.createdAt : lookbackStart
      const windowEnd = this.nowIso()
      // Only user-originated events can satisfy a condition: untrusted
      // content must never suppress an escalation (SECURITY.md), and
      // system-written projection events must not self-satisfy it. A
      // redundant reminder beats a suppressed one.
      return this.store
        .eventLogSince(automation.spaceId, windowStart)
        .some(
          (event) =>
            event.at > automation.createdAt &&
            event.at <= windowEnd &&
            event.origin === 'trusted:user' &&
            !event.type.startsWith('automation.') &&
            event.text.toLowerCase().includes(needle),
        )
    }

    try {
      return (await this.judge(condition.question, automation.spaceId)) === 'yes'
    } catch {
      return false
    }
  }

  /** Durable anti-double-execution lock: one row per (automation, occurrence). */
  private claim(automationId: number, scheduledFor: string): boolean {
    const result = this.db
      .prepare(
        `insert or ignore into automation_runs (automation_id, scheduled_for, started_at)
         values (?, ?, ?)`,
      )
      .run(automationId, scheduledFor, this.nowIso())
    return Number(result.changes) === 1
  }

  private finishClaim(automationId: number, scheduledFor: string, outcome: string): void {
    this.db
      .prepare(
        `update automation_runs set outcome = ?, finished_at = ?
         where automation_id = ? and scheduled_for = ?`,
      )
      .run(outcome, this.nowIso(), automationId, scheduledFor)
  }

  private advance(automation: Automation, outcome: string): void {
    const lastRunAt = this.nowIso()
    if (automation.kind === 'timer' || !automation.cron) {
      this.db
        .prepare(
          `update automations
           set status = 'completed', next_run_at = null, last_run_at = ?, last_outcome = ?
           where id = ?`,
        )
        .run(lastRunAt, outcome, automation.id)
      return
    }
    // Fast-forward past every missed occurrence: catch-up never bursts.
    // Passing `automation.timezone` through keeps a zoned recurring job
    // firing at the same local time across a DST boundary (issue #21).
    let nextRunAt: string | null
    try {
      nextRunAt = nextCronOccurrence(automation.cron, this.now(), automation.timezone).toISOString()
    } catch {
      nextRunAt = null
    }
    this.db
      .prepare(
        `update automations
         set status = case when ? is null then 'completed' else status end,
             next_run_at = ?, last_run_at = ?, last_outcome = ?
         where id = ?`,
      )
      .run(nextRunAt, nextRunAt, lastRunAt, outcome, automation.id)
  }

  /**
   * A claim without `finished_at` is an interrupted run (crash between
   * claim and completion). Delete it so `runDue` re-claims: at-least-once.
   */
  private recoverInterruptedRuns(): void {
    const interrupted = this.db
      .prepare(
        `select runs.automation_id as automation_id, runs.scheduled_for as scheduled_for,
                automations.space_id as space_id, automations.description as description,
                automations.origin as origin
         from automation_runs runs
         join automations on automations.id = runs.automation_id
         where runs.finished_at is null`,
      )
      .all()
    for (const row of interrupted) {
      const automationId = requiredNumber(row, 'automation_id')
      const scheduledFor = requiredString(row, 'scheduled_for')
      this.db
        .prepare('delete from automation_runs where automation_id = ? and scheduled_for = ?')
        .run(automationId, scheduledFor)
      try {
        const storedOrigin = optionalString(row, 'origin')
        this.appendEvent(
          requiredString(row, 'space_id'),
          'automation.recover',
          `Recovered interrupted run of automation "${requiredString(row, 'description')}" — it will run again`,
          { automationId, scheduledFor },
          // The recovery event embeds the description too: keep its mark.
          isValidOrigin(storedOrigin) ? storedOrigin : 'trusted:system',
        )
      } catch {
        // The Space may be gone; recovery must never block boot.
      }
    }
  }

  /**
   * Pre-create the Automations Surface for every active Space so it is
   * in the first snapshot: Surfaces created mid-session reach clients
   * only on the next snapshot, patches on known Surfaces stream live.
   */
  private ensureSurfaces(): void {
    for (const space of this.store.listSpaces()) {
      if (!this.store.getSurface(automationsSurfaceId(space.slug))) this.refreshSurface(space.id)
    }
  }

  /** Project SQLite (the source of truth) onto the Space's Automations Surface. */
  private refreshSurface(spaceId: string): void {
    const space = this.store.getSpace(spaceId)
    if (!space) return
    const listed = this.listAutomations(spaceId).filter(
      (automation) => automation.status !== 'cancelled',
    )
    const items = listed.map((automation) => this.listItem(automation))
    // The Surface projection derives from every listed automation: if any of
    // them was born from a tainted turn, the projection's Space events carry
    // that mark too (issue #13 — the mark propagates to everything derived).
    const origin = effectiveOrigin(
      listed.map((automation) => automation.origin),
      'trusted:system',
    )
    const surfaceId = automationsSurfaceId(space.slug)
    const existing = this.store.getSurface(surfaceId)

    if (!existing) {
      this.store.createSurface(
        automationsSurface(space, items, { updatedAt: this.nowIso(), updatedBy: 'job' }),
        'job',
        { origin },
      )
      return
    }

    // Ordered so every intermediate Surface validates (tree -> state
    // bindings): add keys, replace the list node, drop stale keys.
    const targetState = automationsState(items)
    const setOps: PatchOperation[] = Object.entries(targetState).map(([key, value]) => ({
      target: 'state',
      op: Object.prototype.hasOwnProperty.call(existing.state, key) ? 'replace' : 'add',
      path: `/${key}`,
      value,
    }))
    // Every `store.patch*` call below reaches connected clients through the
    // Gateway's central Surface-event subscription; nothing here broadcasts.
    if (setOps.length > 0) {
      this.store.patchState(surfaceId, setOps, { updatedBy: 'job', origin })
    }

    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return
    this.store.patchTree(
      surfaceId,
      [{ target: 'tree', op: 'replace', path: '/children/1', value: automationsListNode(items) }],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job', origin },
    )

    const staleOps: PatchOperation[] = Object.keys(existing.state)
      .filter((key) => automationIdFromStateKey(key) !== undefined && !(key in targetState))
      .map((key) => ({ target: 'state', op: 'remove', path: `/${key}` }))
    if (staleOps.length > 0) {
      this.store.patchState(surfaceId, staleOps, { updatedBy: 'job', origin })
    }
  }

  private listItem(automation: Automation): AutomationListItem {
    return {
      id: automation.id,
      description: automation.description,
      enabled: automation.enabled,
      scheduleText: scheduleText(automation),
    }
  }

  private syncToggleFromSurface(notice: FastMutationNotice): void {
    const automationId = automationIdFromStateKey(notice.stateKey)
    if (automationId === undefined) return
    const automation = this.getAutomation(automationId)
    if (!automation) return
    const space = this.store.getSpace(automation.spaceId)
    if (!space || notice.surfaceId !== automationsSurfaceId(space.slug)) return
    // The toggle contract is an explicit boolean; anything else must not
    // silently flip a job (truthy strings like "false" would invert it).
    // The fast path already persisted the malformed value into Surface
    // state, so re-project from SQLite to heal it — on a microtask: the
    // Gateway broadcasts the malformed patch after this observer returns,
    // and clients must receive the healing patches (higher cursors) last.
    if (typeof notice.value !== 'boolean') {
      queueMicrotask(() => this.refreshSurface(automation.spaceId))
      return
    }
    this.setEnabled(automationId, notice.value, 'surface')
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const row = this.db
      .prepare(`select min(next_run_at) as next from automations where status = 'armed'`)
      .get()
    const next = row ? optionalString(row, 'next') : undefined
    const delay = next
      ? Math.min(
          Math.max(new Date(next).getTime() - this.now().getTime(), MIN_SLEEP_MS),
          MAX_SLEEP_MS,
        )
      : MAX_SLEEP_MS
    this.timer = setTimeout(() => {
      void this.runDue()
        .catch((error: unknown) => console.error('scheduler runDue failed', error))
        .finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }

  private insertAutomation(input: {
    kind: 'timer' | 'job'
    spaceId: string
    description: string
    fireAt?: string
    cron?: string
    condition?: Condition
    nextRunAt: string
    origin?: Origin
    handler?: string
    targetSurfaceId?: string
    timezone?: string
  }): Automation {
    const result = this.db
      .prepare(
        `insert into automations
           (kind, space_id, description, enabled, fire_at, cron, condition_json, next_run_at, status, created_at, origin, handler, target_surface_id, timezone)
         values (?, ?, ?, 1, ?, ?, ?, ?, 'armed', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.spaceId,
        input.description,
        input.fireAt ?? null,
        input.cron ?? null,
        input.condition === undefined ? null : JSON.stringify(input.condition),
        input.nextRunAt,
        this.nowIso(),
        input.origin ?? null,
        input.handler ?? null,
        input.targetSurfaceId ?? null,
        input.timezone ?? null,
      )
    return this.requireAutomation(Number(result.lastInsertRowid))
  }

  private getAutomation(id: number): Automation | undefined {
    const row = this.db.prepare('select * from automations where id = ?').get(id)
    return row ? automationFromRow(row) : undefined
  }

  private requireAutomation(id: number): Automation {
    const automation = this.getAutomation(id)
    if (!automation) throw new Error(`unknown automation: ${id}`)
    return automation
  }

  private requireSpace(spaceId: string): void {
    if (!this.store.getSpace(spaceId)) throw new Error(`unknown Space: ${spaceId}`)
  }

  private appendEvent(
    spaceId: string,
    type: string,
    text: string,
    payload: JsonObject,
    origin: Origin = 'trusted:system',
  ): void {
    this.store.spacesEngine.appendEvent(spaceId, {
      type,
      text,
      origin,
      payload,
      at: this.nowIso(),
    })
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function scheduleText(automation: Automation): string {
  // Unzoned jobs keep the historical label untouched, byte-for-byte: only a
  // zoned managed job (issue #21) gets the parenthesized zone marker, so
  // `cron` still reads as UTC by default everywhere it already did.
  const zoneLabel = automation.timezone ? ` (${automation.timezone})` : ''
  const base =
    automation.kind === 'timer'
      ? `once at ${utcLabel(automation.fireAt)}`
      : `cron ${automation.cron}${zoneLabel} — next ${utcLabel(automation.nextRunAt)}`
  const done = automation.status === 'completed' ? ' — done' : ''
  const last = automation.lastOutcome ? ` — last: ${automation.lastOutcome}` : ''
  return `${base}${done}${last}`
}

function utcLabel(iso: string | undefined): string {
  if (!iso) return 'n/a'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
