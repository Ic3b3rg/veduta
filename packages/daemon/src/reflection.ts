import { z } from 'zod'
import { nextCronOccurrence, timeToCron } from './cron.ts'
import {
  demoteFacts as demoteFactsDocument,
  factIdentityLine,
  factRecordIds,
  type FactRecord,
  type FactsDocument,
} from './facts.ts'
import { projectFacts } from './facts-projection.ts'
import { reconcileManagedJobs } from './managed-jobs.ts'
import type { MemoryConfig } from './memory-config.ts'
import { formatSourceRef, type MemoryIndex } from './memory-index.ts'
import type { Scheduler } from './scheduler.ts'
import { renderEventForContext, type SpaceEvent } from './spaces-engine.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { effectiveOrigin, type Origin } from './taint.ts'

/**
 * The nightly Reflection (issues/021-advanced-memory.md): "sleep-time
 * compute" for every active, non-System Space. Once a night (default 04:00
 * user-local, docs/adr/0006-file-based-memory.md), it distills the day's
 * Event log into summaries and a small number of higher-level insights,
 * consolidates FACTS losslessly through the AUDN Curator, and demotes the
 * least-relevant still-valid facts to `dormant` to bring the injected active
 * set back under the `low` budget
 * watermark. It never deletes, never falsely supersedes, and never hides an
 * active fact from the user: a demoted record stays on disk and in the
 * Event log, just no longer injected by default (`facts.ts`).
 *
 * Mirrors `heartbeat.ts`'s shape (a daemon-owned engine registered as a
 * Scheduler handler, with `register()`/`reconcileJobs()` and an injected
 * completion function) but the injected seam here is a whole-distillation
 * function (`ReflectionDistiller`) rather than a raw model completion,
 * because the Reflection's output is structured (summaries, insights,
 * candidate facts with their own evidence) rather than free text a prompt
 * builder assembles.
 */

const MAX_SUMMARIES = 20
const MAX_SUMMARY_CHARS = 500
const MAX_INSIGHT_CHARS = 500
const MAX_FACTS = 50
const MAX_FACT_TEXT_CHARS = 1000

const DistilledFactSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_FACT_TEXT_CHARS),
    /** Source refs of the events this claim came from (`memory-index.ts`'s `formatSourceRef`). */
    sourceRefs: z.array(z.string().min(1)),
  })
  .strict()

/**
 * `insights` is capped at 3 but has no minimum: issues/021-advanced-memory.md
 * asks the Reflection for "2-3 higher-level insights", but a distiller that
 * returns fewer (or none) is a quality shortfall to surface through
 * `ReflectionRunReport`, not a reason to throw away an otherwise-good
 * distillation — its summaries and facts are still worth keeping.
 */
const ReflectionDistillationSchema = z
  .object({
    summaries: z.array(z.string().trim().min(1).max(MAX_SUMMARY_CHARS)).max(MAX_SUMMARIES),
    insights: z.array(z.string().trim().min(1).max(MAX_INSIGHT_CHARS)).min(0).max(3),
    facts: z.array(DistilledFactSchema).max(MAX_FACTS),
  })
  .strict()

/**
 * The schema's own inferred fact shape for the validated values flowing
 * through `runReflection`.
 *
 * A distilled fact deliberately carries no date of its own. `writeFact` stamps
 * the Curator's `noted` date, and a per-claim effective date would need to
 * travel through the whole write path to mean anything — worth doing, but it is
 * a change to the FACTS write contract rather than to this module, so the field
 * is absent instead of accepted-and-ignored. Bi-temporality lives where it
 * already works: the Event log this claim's `sourceRefs` point at keeps the
 * original dates (docs/adr/0006-file-based-memory.md).
 */
type ParsedDistilledFact = z.infer<typeof DistilledFactSchema>

export interface DistilledFact {
  text: string
  /** Source refs of the events this claim came from. */
  sourceRefs: string[]
}

export interface ReflectionDistillation {
  summaries: string[]
  insights: string[]
  facts: DistilledFact[]
}

export interface ReflectionInput {
  spaceId: string
  timezone: string
  /** The window's events, already rendered taint-aware. */
  renderedEvents: string
  events: { sourceRef: string; event: SpaceEvent }[]
}

export type ReflectionDistiller = (input: ReflectionInput) => Promise<ReflectionDistillation>

export interface ReflectionOptions {
  store: Store
  scheduler: Scheduler
  index: MemoryIndex
  config: MemoryConfig
  distiller: ReflectionDistiller
  now?: () => Date
  /**
   * Fired with a Space's id after every run that produced a report for it,
   * including a skipped (empty-window) one, so the report Surface manager can
   * re-project. Without it the browsable report issues/021-advanced-memory.md
   * asks for would only ever show what was true at boot: the Reflection runs
   * overnight, and a daemon that stays up for a week would keep serving the
   * Surface it built on the day it started. Same shape as the Heartbeat's
   * `onSwept`, and wired the same way in `server.ts`.
   */
  onReflected?: (spaceId: string) => void
}

export interface ReflectionRunReport {
  spaceId: string
  windowFrom: string
  windowTo: string
  eventCount: number
  summaries: string[]
  insights: string[]
  consolidated: number
  reactivated: number
  droppedWithoutEvidence: number
  demoted: number
  activeSize: number
  underBudget: boolean
}

type TerminalType = 'reflection.done' | 'reflection.skip'

/**
 * A terminal marker the Reflection may trust: the right type, and written by
 * the daemon itself.
 *
 * The origin check is the load-bearing part. These markers are ordinary Event
 * log entries, so `append_event` from a tainted turn can produce something
 * that looks exactly like one; matching on type and payload alone would let
 * untrusted content decide whether the Reflection ever runs again
 * (docs/SECURITY.md §3.2). Only the daemon writes its own bookkeeping — the
 * same reasoning that stops `toolWriteOrigin` from ever stamping
 * `trusted:user` on a tool write.
 */
function isTerminalMarker(event: SpaceEvent): boolean {
  return (
    (event.type === 'reflection.done' || event.type === 'reflection.skip') &&
    event.origin === 'trusted:system'
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How far back a run looks for its own terminal markers. Wide enough that a
 * run of consecutive failed or missed nights is still picked up from the last
 * night that genuinely completed, instead of each run quietly starting from
 * "yesterday" and losing everything in between. Past this, a run falls back to
 * the previous occurrence and the older windows are not re-distilled — the same
 * bounded-catch-up stance the Scheduler already takes for a long outage, and
 * nothing is lost from the Event log itself, which is never rewritten.
 */
const MARKER_LOOKBACK_DAYS = 30
/** Safety cap on the forward walk in `previousReflectionOccurrence`: a daily cron starting 2 days back needs at most a handful of steps. */
const MAX_OCCURRENCE_WALK_STEPS = 10

export class Reflection {
  private readonly store: Store
  private readonly scheduler: Scheduler
  private readonly index: MemoryIndex
  private readonly config: MemoryConfig
  private readonly distiller: ReflectionDistiller
  private readonly now: () => Date
  private readonly onReflected: ((spaceId: string) => void) | undefined
  private readonly reports = new Map<string, ReflectionRunReport>()

  constructor(options: ReflectionOptions) {
    this.store = options.store
    this.scheduler = options.scheduler
    this.index = options.index
    this.config = options.config
    this.distiller = options.distiller
    this.now = options.now ?? (() => new Date())
    this.onReflected = options.onReflected
  }

  /**
   * The single place a run's report becomes visible: stores it for
   * `lastReport` and notifies the observer. Both exit paths of a run go
   * through here so a skipped run refreshes the Surface too — otherwise the
   * report would keep claiming the previous run's window.
   */
  private recordReport(report: ReflectionRunReport): ReflectionRunReport {
    this.reports.set(report.spaceId, report)
    this.onReflected?.(report.spaceId)
    return report
  }

  /**
   * Reconciles the System-Space Automation that fires the Reflection to
   * exactly the configured daily cron. Call at construction/boot, before
   * `scheduler.start()`. Shares `reconcileManagedJobs` with the Heartbeat
   * (`managed-jobs.ts`) rather than a second copy of the same convergence
   * logic.
   */
  reconcileJobs(): void {
    reconcileManagedJobs({
      scheduler: this.scheduler,
      spaceId: SYSTEM_SPACE_ID,
      handler: 'reflection',
      enabled: this.config.reflection.enabled,
      desired: new Map([
        [
          timeToCron(this.config.reflection.time),
          `Nightly Reflection at ${this.config.reflection.time} ${this.config.timezone}`,
        ],
      ]),
      timezone: this.config.timezone,
    })
  }

  /** Wires the Scheduler's generic handler registry to `runOccurrence`. Call before `scheduler.start()`. */
  register(): void {
    this.scheduler.registerHandler('reflection', (ctx) =>
      this.runOccurrence(ctx.automation.id, ctx.scheduledFor),
    )
  }

  /**
   * The Scheduler handler body: runs `runReflection` for every active,
   * non-System Space. A failure in one Space is caught and reported in the
   * returned outcome string rather than re-thrown — a single bad Space (a
   * throwing distiller, a transient I/O error) must never cost every other
   * Space its nightly consolidation.
   */
  async runOccurrence(automationId: number, scheduledFor: string): Promise<string> {
    let reflected = 0
    let skipped = 0
    const failures: string[] = []

    for (const space of this.store.listSpaces()) {
      if (space.id === SYSTEM_SPACE_ID) continue
      try {
        const report = await this.runReflection(space.id, automationId, scheduledFor)
        if (report === undefined) skipped += 1
        else reflected += 1
      } catch (error) {
        failures.push(`${space.id}:${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const parts = [`reflected:${reflected}`, `skipped:${skipped}`]
    if (failures.length > 0) parts.push(`failed:${failures.join(',')}`)
    return parts.join(' ')
  }

  /**
   * Runs the Reflection for one Space and one Scheduler occurrence. Returns
   * `undefined` when this exact `(automationId, scheduledFor)` pair was
   * already completed for this Space (idempotent re-run after a restart
   * between the handler finishing and the Scheduler advancing its claim —
   * the Scheduler is at-least-once by design). Throws on failure without
   * ever writing a terminal marker, so `completedThrough` stays where it
   * was and the next run re-reads the same window instead of losing it.
   */
  async runReflection(
    spaceId: string,
    automationId: number,
    scheduledFor: string,
  ): Promise<ReflectionRunReport | undefined> {
    if (this.findTerminalMarker(spaceId, automationId, scheduledFor)) return undefined

    const previousOccurrence = this.previousReflectionOccurrence(scheduledFor)
    // The marker scan reaches back further than the previous occurrence on
    // purpose. A failed run records no marker, so if last night failed the most
    // recent marker is two or more nights old — reading only from the previous
    // occurrence would miss it, fall back to the previous occurrence, and
    // silently drop the window the failed run was supposed to cover. The
    // fallback stays the previous occurrence, for a genuine first run.
    const scanFloor = new Date(
      new Date(scheduledFor).getTime() - MARKER_LOOKBACK_DAYS * DAY_MS,
    ).toISOString()
    const boundary =
      this.latestCompletedThrough(spaceId, scanFloor, scheduledFor) ?? previousOccurrence
    const windowEvents = this.collectWindowEvents(spaceId, boundary, scheduledFor)

    if (windowEvents.length === 0) {
      this.appendTerminal(spaceId, 'reflection.skip', automationId, scheduledFor)
      const projection = projectFacts(this.store.spacesEngine.readFacts(spaceId))
      const report: ReflectionRunReport = {
        spaceId,
        windowFrom: boundary,
        windowTo: scheduledFor,
        eventCount: 0,
        summaries: [],
        insights: [],
        consolidated: 0,
        reactivated: 0,
        droppedWithoutEvidence: 0,
        demoted: 0,
        activeSize: projection.activeSize,
        underBudget: projection.activeSize <= this.config.budget.low,
      }
      return this.recordReport(report)
    }

    const renderedEvents = windowEvents.map(({ event }) => renderEventForContext(event)).join('\n')
    const distillation = await this.distiller({
      spaceId,
      timezone: this.config.timezone,
      renderedEvents,
      events: windowEvents,
    })
    const distilled = ReflectionDistillationSchema.parse(distillation)

    const windowSourceRefs = new Set(windowEvents.map((entry) => entry.sourceRef))
    let consolidated = 0
    let reactivated = 0
    let droppedWithoutEvidence = 0

    for (const fact of distilled.facts) {
      const evidence = this.validateFactEvidence(fact, windowSourceRefs)
      if (!evidence) {
        droppedWithoutEvidence += 1
        continue
      }

      const result = this.store.spacesEngine.writeFact(spaceId, fact.text, evidence.origin)
      if (result.operation === 'reactivate') {
        reactivated += 1
      } else if (result.operation === 'noop') {
        this.recordEvidenceForNoop(spaceId, result.fact, evidence)
      } else {
        consolidated += 1
      }
    }

    const demotion = this.demoteToBudget(spaceId)
    if (!demotion.underBudget) {
      this.store.spacesEngine.appendEvent(spaceId, {
        type: 'reflection.overBudget',
        text: 'Reflection could not bring the active FACTS set back under budget by demoting valid facts.',
        origin: 'trusted:system',
        payload: { activeSize: demotion.activeSize, low: this.config.budget.low },
      })
    }

    this.appendTerminal(spaceId, 'reflection.done', automationId, scheduledFor, {
      consolidated,
      reactivated,
      droppedWithoutEvidence,
      demoted: demotion.demoted,
    })

    const report: ReflectionRunReport = {
      spaceId,
      windowFrom: boundary,
      windowTo: scheduledFor,
      eventCount: windowEvents.length,
      summaries: distilled.summaries,
      insights: distilled.insights,
      consolidated,
      reactivated,
      droppedWithoutEvidence,
      demoted: demotion.demoted,
      activeSize: demotion.activeSize,
      underBudget: demotion.underBudget,
    }
    return this.recordReport(report)
  }

  lastReport(spaceId: string): ReflectionRunReport | undefined {
    return this.reports.get(spaceId)
  }

  // --- internals ---

  /**
   * Both `reflection.done` and `reflection.skip` are terminal and both
   * carry `{ automationId, scheduledFor, completedThrough }`. Searched from
   * `scheduledFor` onward (a terminal marker for this occurrence can only
   * be recorded at or after the moment it fires), never from the whole
   * log, so a busy Space's history does not have to be scanned on every
   * occurrence just to answer "did this one already run".
   */
  private findTerminalMarker(
    spaceId: string,
    automationId: number,
    scheduledFor: string,
  ): SpaceEvent | undefined {
    return this.store
      .eventLogSince(spaceId, scheduledFor)
      .find(
        (event) =>
          isTerminalMarker(event) &&
          event.payload?.['automationId'] === automationId &&
          event.payload?.['scheduledFor'] === scheduledFor,
      )
  }

  /**
   * The greatest `completedThrough` across this Space's terminal markers,
   * clamped to `scheduledFor`.
   *
   * Both guards matter, because a terminal marker is an ordinary Event log
   * entry and `append_event` can write one. Without the origin check in
   * `isTerminalMarker`, a single tool call from a tainted turn — a
   * `reflection.done` payload claiming `completedThrough` in the year 9999 —
   * would pin this boundary in the future forever: every later occurrence
   * would find an empty window, terminate as a skip, and silently stop
   * consolidating FACTS, recording evidence and demoting to budget. The log is
   * append-only (ADR-0003), so there would be no way to take it back. The
   * clamp is the second line: even a genuine marker must never be able to move
   * the boundary past the occurrence being run.
   *
   * Bounded read: markers are only interesting from the previous occurrence
   * onward, so this reads from `floor` rather than scanning the Space's whole
   * history on every nightly run.
   */
  private latestCompletedThrough(
    spaceId: string,
    floor: string,
    scheduledFor: string,
  ): string | undefined {
    let latest: string | undefined
    for (const event of this.store.eventLogSince(spaceId, floor)) {
      if (!isTerminalMarker(event)) continue
      const completedThrough = event.payload?.['completedThrough']
      if (typeof completedThrough !== 'string') continue
      const bounded = completedThrough > scheduledFor ? scheduledFor : completedThrough
      if (latest === undefined || bounded > latest) latest = bounded
    }
    return latest
  }

  /**
   * With no prior terminal marker, the window's lower bound is the previous
   * occurrence of the Reflection's own cron before `scheduledFor`, in the
   * configured timezone — never `scheduledFor - 24h`, which drops or
   * repeats an hour across a DST transition and does not match the job's
   * real cadence (`cron.ts`'s `nextCronOccurrence` already resolves both
   * sides of a transition correctly; re-deriving it by fixed subtraction
   * would throw that away). `timeToCron` always produces a daily
   * `M H * * *` expression, so walking forward from 2 days before
   * `scheduledFor` and keeping the last result strictly before it finds
   * the answer in at most a couple of steps. If the walk finds nothing — a
   * cron shape this code does not expect — it falls back to a fixed 24h
   * step back rather than throwing: a slightly wrong window beats a
   * Reflection that can never run for this Space again.
   */
  private previousReflectionOccurrence(scheduledFor: string): string {
    const scheduledDate = new Date(scheduledFor)
    const fallback = new Date(scheduledDate.getTime() - DAY_MS)

    let cron: string
    try {
      cron = timeToCron(this.config.reflection.time)
    } catch {
      return fallback.toISOString()
    }

    let from = new Date(scheduledDate.getTime() - 2 * DAY_MS)
    let last: Date | undefined
    for (let step = 0; step < MAX_OCCURRENCE_WALK_STEPS; step += 1) {
      let next: Date
      try {
        next = nextCronOccurrence(cron, from, this.config.timezone)
      } catch {
        break
      }
      if (next.getTime() >= scheduledDate.getTime()) break
      last = next
      from = next
    }

    return (last ?? fallback).toISOString()
  }

  /**
   * Every event in `(boundary, scheduledFor]` — exclusive at the lower
   * bound, so a previous run's own terminal marker (which lands exactly at
   * the boundary or later) can never make the next window non-empty on its
   * own — with every `reflection.*` event filtered out for the same reason.
   * Reads through `SpacesEngine.readLogEntriesFrom` rather than
   * `readSince` so each event comes back paired with the `(file, line)`
   * needed to build its `sourceRef` (`memory-index.ts`'s `formatSourceRef`).
   * Narrowed to the log files whose day falls inside the window before
   * reading them; the per-event bounds check below is what actually
   * enforces exclusivity, this is only there to avoid reading files that
   * cannot contain a matching event.
   */
  private collectWindowEvents(
    spaceId: string,
    boundary: string,
    scheduledFor: string,
  ): { sourceRef: string; event: SpaceEvent }[] {
    const boundaryDay = boundary.slice(0, 10)
    const scheduledDay = scheduledFor.slice(0, 10)
    const files = this.store.spacesEngine.listLogFiles(spaceId).filter((file) => {
      const day = file.file.slice(0, 10)
      return day >= boundaryDay && day <= scheduledDay
    })

    const collected: { sourceRef: string; event: SpaceEvent }[] = []
    for (const file of files) {
      const { entries } = this.store.spacesEngine.readLogEntriesFrom(spaceId, file.file, 0, 0)
      for (const entry of entries) {
        if (entry.event.type.startsWith('reflection.')) continue
        if (entry.event.at <= boundary || entry.event.at > scheduledFor) continue
        collected.push({
          sourceRef: formatSourceRef({ kind: 'event', spaceId, file: file.file, line: entry.line }),
          event: entry.event,
        })
      }
    }
    return collected.sort((left, right) => left.event.at.localeCompare(right.event.at))
  }

  /**
   * Keeps only the `sourceRefs` that are non-empty, belong to this window,
   * and still dereference through the memory index — a claim whose
   * evidence is not in the window it was distilled from is a fabrication,
   * and writing it would put an unfounded claim into FACTS, exactly what
   * "extraction is never truth" (docs/adr/0006-file-based-memory.md)
   * forbids. Returns `undefined` when nothing survives, so the caller can
   * drop the fact and count it. The origin is derived from the *validated*
   * evidence events only — each fact takes the provenance of its own
   * evidence, never a caller-wide default, so an untrusted-derived claim
   * keeps its mark.
   */
  private validateFactEvidence(
    fact: ParsedDistilledFact,
    windowSourceRefs: Set<string>,
  ): { validRefs: string[]; origin: Origin } | undefined {
    const validRefs: string[] = []
    const origins: Origin[] = []
    for (const ref of fact.sourceRefs) {
      if (!ref || !windowSourceRefs.has(ref)) continue
      const result = this.index.dereference(ref)
      if (!result.ok) continue
      validRefs.push(ref)
      origins.push(
        result.kind === 'event' ? result.event.origin : (result.fact.origin ?? 'trusted:system'),
      )
    }
    if (validRefs.length === 0) return undefined
    return { validRefs, origin: effectiveOrigin(origins, 'trusted:system') }
  }

  /**
   * A repeated fact the Curator recognizes as already-known (`noop`) writes
   * nothing to FACTS.md — so without this, the evidence trail would
   * silently stop growing at the first repetition, which is exactly the
   * loss the lossless-consolidation requirement forbids. Appends a
   * content-free `fact.evidence` event carrying the record id (looked up
   * by identity line rather than object identity, since `noop`'s `fact` is
   * a record from a document read before this call, not the one read here)
   * and the newly validated refs, so every repetition's evidence stays
   * recoverable from the log even though the record's own text never
   * changes again.
   */
  private recordEvidenceForNoop(
    spaceId: string,
    fact: FactRecord,
    evidence: { validRefs: string[]; origin: Origin },
  ): void {
    const fallbackDate = this.today()
    const document = this.store.spacesEngine.readFacts(spaceId)
    const recordId = findRecordId(document, fallbackDate, fact)
    if (recordId === undefined) return
    this.store.spacesEngine.appendEvent(spaceId, {
      type: 'fact.evidence',
      text: 'Reflection recorded additional evidence for an already-known fact.',
      origin: evidence.origin,
      payload: { recordId, sourceRefs: evidence.validRefs },
    })
  }

  /**
   * While the active FACTS projection is over `config.budget.low`, demotes
   * the next candidate — active records ranked oldest `noted` first,
   * tie-broken on record id — re-projecting after each candidate is added
   * to the selected set so the loop stops the moment the projection would
   * fit. There is no recency veto and no floor: if reaching `low` requires
   * demoting every active record, including the newest, this demotes it
   * too. Demotion happens in exactly one `SpacesEngine.demoteFacts` call
   * once the full selected set is known.
   */
  private demoteToBudget(spaceId: string): {
    demoted: number
    activeSize: number
    underBudget: boolean
  } {
    const fallbackDate = this.today()
    const low = this.config.budget.low
    const document = this.store.spacesEngine.readFacts(spaceId)
    let projection = projectFacts(document)

    if (projection.activeSize <= low) {
      return { demoted: 0, activeSize: projection.activeSize, underBudget: true }
    }

    const recordIds = factRecordIds(document, fallbackDate)
    const ranked = document.active
      .map((candidate) => ({ fact: candidate, id: recordIds.get(candidate) }))
      .filter((entry): entry is { fact: FactRecord; id: string } => entry.id !== undefined)
      .sort((left, right) => {
        const notedCompare = (left.fact.noted ?? '').localeCompare(right.fact.noted ?? '')
        return notedCompare !== 0 ? notedCompare : left.id.localeCompare(right.id)
      })

    const selected: string[] = []
    for (const candidate of ranked) {
      selected.push(candidate.id)
      const attempt = demoteFactsDocument(document, selected, fallbackDate)
      projection = projectFacts(attempt.document)
      if (projection.activeSize <= low) break
    }

    const demoted = this.store.spacesEngine.demoteFacts(spaceId, selected)
    const finalProjection = projectFacts(this.store.spacesEngine.readFacts(spaceId))
    return {
      demoted: demoted.length,
      activeSize: finalProjection.activeSize,
      underBudget: finalProjection.activeSize <= low,
    }
  }

  private appendTerminal(
    spaceId: string,
    type: TerminalType,
    automationId: number,
    scheduledFor: string,
    counts?: {
      consolidated: number
      reactivated: number
      droppedWithoutEvidence: number
      demoted: number
    },
  ): void {
    const text =
      type === 'reflection.done'
        ? 'Reflection completed for this occurrence.'
        : 'Reflection found no new events to distill for this occurrence.'
    this.store.spacesEngine.appendEvent(spaceId, {
      type,
      text,
      origin: 'trusted:system',
      payload: {
        automationId,
        scheduledFor,
        completedThrough: scheduledFor,
        ...(counts ?? {}),
      },
    })
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }
}

/**
 * Finds the record id (`facts.ts`'s `factRecordIds`) for a `FactRecord`
 * that came from a different in-memory copy of `FactsDocument` than the one
 * passed in here — `factRecordIds` returns a `Map<FactRecord, string>` keyed
 * by object identity, which cannot answer "what id does this equivalent
 * record have in a freshly-read document". Matching on `factIdentityLine`
 * (text, noted date, and untrusted origin) instead compares by value, which
 * is exactly what a record freshly read off disk needs.
 */
function findRecordId(
  document: FactsDocument,
  fallbackDate: string,
  fact: FactRecord,
): string | undefined {
  const recordIds = factRecordIds(document, fallbackDate)
  const targetLine = factIdentityLine(fact, fallbackDate)
  for (const [record, id] of recordIds) {
    if (factIdentityLine(record, fallbackDate) === targetLine) return id
  }
  return undefined
}
