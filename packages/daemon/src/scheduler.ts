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
import type { FastMutationNotice, Store } from './store.ts'
import { effectiveOrigin, isValidOrigin, toolWriteOrigin, type Origin } from './taint.ts'

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
export const ConditionSchema = z.union([
  z.object({
    kind: z.literal('event-logged'),
    /** Case-insensitive needle over Event log text. */
    textIncludes: z.string().trim().min(1),
    /** Window before the occurrence in which a matching event counts. */
    withinHours: z.number().positive().max(720).default(24),
  }),
  z.object({
    kind: z.literal('judgment'),
    question: z.string().trim().min(1),
  }),
])

export type Condition = z.infer<typeof ConditionSchema>

export type JudgeVerdict = 'yes' | 'no' | 'unknown'

/**
 * Answers a judgment condition. The server wires this to the triage
 * tier through the ModelRouter with `origin: 'proactive'`, so the
 * daily spending caps govern scheduler judgments too.
 */
export type JudgeFn = (question: string, spaceId: string) => Promise<JudgeVerdict> | JudgeVerdict

export interface Automation {
  id: number
  kind: 'timer' | 'job'
  spaceId: string
  description: string
  enabled: boolean
  /** One-shot timers: the ISO instant to fire at. */
  fireAt?: string
  /** Recurring jobs: the cron expression. */
  cron?: string
  condition?: Condition
  /** Materialized next occurrence; absent once completed or cancelled. */
  nextRunAt?: string
  status: 'armed' | 'completed' | 'cancelled'
  lastRunAt?: string
  lastOutcome?: string
  createdAt: string
  /** Origin of the turn that created this Automation. Absent = legacy = trusted:system. */
  origin?: Origin
}

export interface SchedulerOptions {
  rootDir: string
  store: Store
  now?: () => Date
  /** Deliver an escalation to the user (chat notice); Space event is appended regardless. */
  onEscalation?: (spaceId: string, text: string) => void
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
  private readonly onEscalation: ((spaceId: string, text: string) => void) | undefined
  private readonly judge: JudgeFn
  private disposeFastMutationObserver: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** The run loop is armed only between start() and stop(). */
  private stopped = true

  constructor(options: SchedulerOptions) {
    this.db = new DatabaseSync(join(options.rootDir, 'scheduler.sqlite'))
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.onEscalation = options.onEscalation
    this.judge = options.judge ?? (() => 'unknown')
    this.initializeSchema()
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
      this.onEscalation?.(automation.spaceId, text)
      return 'skipped:overdue'
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
    this.onEscalation?.(automation.spaceId, text)
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
      const windowStart = new Date(
        new Date(scheduledFor).getTime() - condition.withinHours * 60 * 60 * 1000,
      ).toISOString()
      const windowEnd = this.nowIso()
      // Only user-originated events can satisfy a condition: untrusted
      // content must never suppress an escalation (SECURITY.md), and
      // system-written projection events must not self-satisfy it. A
      // redundant reminder beats a suppressed one.
      return this.store
        .eventLogSince(automation.spaceId, windowStart)
        .some(
          (event) =>
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
    let nextRunAt: string | null
    try {
      nextRunAt = nextCronOccurrence(automation.cron, this.now()).toISOString()
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
  }): Automation {
    const result = this.db
      .prepare(
        `insert into automations
           (kind, space_id, description, enabled, fire_at, cron, condition_json, next_run_at, status, created_at, origin)
         values (?, ?, ?, 1, ?, ?, ?, ?, 'armed', ?, ?)`,
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

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists automations (
        id integer primary key autoincrement,
        kind text not null check (kind in ('timer', 'job')),
        space_id text not null,
        description text not null,
        enabled integer not null default 1,
        fire_at text,
        cron text,
        condition_json text,
        next_run_at text,
        status text not null default 'armed'
          check (status in ('armed', 'completed', 'cancelled')),
        last_run_at text,
        last_outcome text,
        created_at text not null,
        origin text
      );
      create index if not exists automations_due
        on automations (status, next_run_at);

      create table if not exists automation_runs (
        automation_id integer not null references automations(id),
        scheduled_for text not null,
        started_at text not null,
        outcome text,
        finished_at text,
        primary key (automation_id, scheduled_for)
      );
    `)
    // Defensive migration: a `scheduler.sqlite` created before this column
    // existed must keep working — `create table if not exists` above only
    // applies to a fresh database, so an existing one is migrated here.
    this.ensureColumn('automations', 'origin', 'text')
  }

  /** Adds `column` to `table` if an existing (pre-migration) database lacks it. */
  private ensureColumn(table: string, column: string, sqlType: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all()
    const exists = columns.some((row) => requiredString(row, 'name') === column)
    if (!exists) this.db.exec(`alter table ${table} add column ${column} ${sqlType}`)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function scheduleText(automation: Automation): string {
  const base =
    automation.kind === 'timer'
      ? `once at ${utcLabel(automation.fireAt)}`
      : `cron ${automation.cron} — next ${utcLabel(automation.nextRunAt)}`
  const done = automation.status === 'completed' ? ' — done' : ''
  const last = automation.lastOutcome ? ` — last: ${automation.lastOutcome}` : ''
  return `${base}${done}${last}`
}

function utcLabel(iso: string | undefined): string {
  if (!iso) return 'n/a'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function automationFromRow(row: Record<string, unknown>): Automation {
  const conditionJson = optionalString(row, 'condition_json')
  const fireAt = optionalString(row, 'fire_at')
  const cron = optionalString(row, 'cron')
  const nextRunAt = optionalString(row, 'next_run_at')
  const lastRunAt = optionalString(row, 'last_run_at')
  const lastOutcome = optionalString(row, 'last_outcome')
  const status = requiredString(row, 'status')
  const kind = requiredString(row, 'kind')
  // `origin` may be absent on rows written before this column existed, or
  // on a legacy database not yet migrated; either way, absent = trusted.
  const originValue = optionalString(row, 'origin')
  const origin = originValue !== undefined && isValidOrigin(originValue) ? originValue : undefined
  if (status !== 'armed' && status !== 'completed' && status !== 'cancelled') {
    throw new Error(`unexpected automation status: ${status}`)
  }
  if (kind !== 'timer' && kind !== 'job') throw new Error(`unexpected automation kind: ${kind}`)
  return {
    id: requiredNumber(row, 'id'),
    kind,
    spaceId: requiredString(row, 'space_id'),
    description: requiredString(row, 'description'),
    enabled: requiredNumber(row, 'enabled') === 1,
    status,
    createdAt: requiredString(row, 'created_at'),
    ...(fireAt === undefined ? {} : { fireAt }),
    ...(cron === undefined ? {} : { cron }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(lastOutcome === undefined ? {} : { lastOutcome }),
    ...(origin === undefined ? {} : { origin }),
    ...(conditionJson === undefined
      ? {}
      : { condition: ConditionSchema.parse(JSON.parse(conditionJson)) }),
  }
}
