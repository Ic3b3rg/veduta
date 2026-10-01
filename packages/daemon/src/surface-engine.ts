import { randomUUID } from 'node:crypto'
import { FastActionLedger } from './fast-action-ledger.ts'
import {
  stampFastActionRevisions,
  reduceFastAction,
  SurfaceActionError,
  freezeFastActionPreflight,
} from './fast-action.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AgentActionTurnSchema,
  AutomationOutcomeStatusesSchema,
  type AutomationOutcomeKind,
  AtomNodeSchema,
  JsonObjectSchema,
  PatchOperationSchema,
  PatchSchema,
  SYSTEM_SPACE_ID,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfaceMovedEventSchema,
  SurfacePatchEventSchema,
  SurfacePinnedEventSchema,
  SurfaceOrderSchema,
  SurfaceSchema,
  SurfacePresentationSchema,
  SurfacePresentationEventSchema,
  applySurfacePatch,
  findAtom,
  findDeclaredAgentAction,
  surfaceRelativeTimeStatus,
  FastActionInvocationSchema,
  CommittedFastActionOutcomeSchema,
  canonicalJson,
  owningActionInputs,
  actionValueMatches,
  type FastActionInvocation,
  type FastAction,
  type FastActionOutcome,
  type CommittedFastActionMetadata,
  type CommittedFastActionOutcome,
  type AgentActionInvocation,
  type AgentActionTurn,
  type ChatMessage,
  type AtomNode,
  type ChatTurnCorrelation,
  type Freshness,
  type JsonObject,
  type PatchOperation,
  type Surface,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfaceMovedEvent,
  type SurfaceMoveDirection,
  type SurfacePatchEvent,
  type SurfacePinnedEvent,
  type SurfaceOrder,
  type SurfacePresentation,
  type SurfacePresentationEvent,
  type SurfaceRelativeTimeStatus,
} from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { AppendSpaceEventInput } from './spaces-engine.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'
import {
  RelativeTimeAuthoringSchema,
  buildRelativeTimeValidity,
  validityAfterStatePatch,
  type RelativeTimeAuthoring,
} from './relative-time-surface.ts'
import { isSurfacePinnable } from './surface-pinnability.ts'
import {
  agentTurnFromRow,
  surfaceEngineEventFromRow,
  surfaceFromRow,
  treeProposalFromRow,
} from './surface-engine-rows.ts'
import { initializeSurfaceSchema } from './surface-engine-schema.ts'
import {
  SurfaceCommitJournal,
  SurfaceCommitRecoveryPendingError,
  type SurfaceCommitRecord,
  type SurfaceCommitTransport,
} from './surface-commit.ts'
import {
  effectiveToolWriteOrigin,
  effectiveOrigin,
  isValidOrigin,
  neutralizeDelimiters,
  type Origin,
} from './taint.ts'

export { surfaceEngineEventFromRow }
export { SurfaceCommitRecoveryPendingError }

type SurfaceWriteActor = Extract<Freshness['updatedBy'], 'agent' | 'user' | 'job'>

/**
 * Cap on the Surface title rendered into `setPinned`'s `surface.pin` Event
 * log text. A title can carry attacker-influenced Template content, and this
 * Event text has no other size bound.
 */
const PIN_EVENT_TITLE_MAX_CHARS = 200

export interface FastActionPreflightContext {
  actor: 'trusted:user'
  surface: Surface
  node: AtomNode
  action: FastAction
  invocation: FastActionInvocation
  nextSurface: Surface
  operations: PatchOperation[]
}

export interface SurfaceMutation {
  surface: Surface
  event: SurfacePatchEvent
  duplicate: boolean
}

export interface SurfacePinMutation {
  surface: Surface
  changed: boolean
  order: SurfaceOrder
}

export interface SurfacePresentationOptions {
  updatedBy: 'agent' | 'user'
  origin: Origin
  userRequest: { text: string; origin: 'trusted:user' }
  idempotencyKey?: string
}

export interface SurfacePresentationMutation {
  surface: Surface
  changed: boolean
  duplicate: boolean
  event?: SurfacePresentationEvent
}

type CommittedSurfacePinMutation =
  | { surface: Surface; changed: false; order: SurfaceOrder }
  | { surface: Surface; changed: true; order: SurfaceOrder; event: SurfacePinnedEvent }

/**
 * `patchTree`'s result when the target Surface is pinned and the caller did
 * not pass `bypassPin`: nothing was mutated, a `pending` row was recorded
 * instead (`issue #22`). Discriminate a `patchTree`
 * result with `'proposed' in result` rather than a shared field, since
 * `SurfaceMutation` gains none.
 */
export interface TreeProposalRecorded {
  proposed: true
  proposalId: number
  surfaceId: string
}

export type TreeProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale'

/** A recorded Tree proposal, as read by `listTreeProposals`/`getTreeProposal`. */
export interface TreeProposal {
  id: number
  surfaceId: string
  spaceId: string
  operations: PatchOperation[]
  expectedTreeVersion: number
  origin: Origin
  status: TreeProposalStatus
  createdAt: string
  resolvedAt?: string
  resolvedBy?: 'trusted:user'
}

export interface SurfaceVersion {
  version: number
  treeVersion: number
}

/** The compact, model-facing identity of one Surface the Agent may author. */
export interface AuthorableSurfaceSummary {
  id: string
  title: string
  freshness: Freshness
  pinned: boolean
  presentation: Surface['presentation']
  relativeTime?: SurfaceRelativeTimeStatus
}

/** A Space-scoped inventory plus the whole-Surface origins of its rendered titles. */
export interface AuthorableSurfaceInventory {
  surfaces: AuthorableSurfaceSummary[]
  origins: Origin[]
}

/** A complete, validated Surface read with its stored concurrency metadata and origin. */
export interface AuthorableSurfaceRead extends SurfaceVersion {
  surface: Surface
  origins: Origin[]
  relativeTime?: SurfaceRelativeTimeStatus
}

/**
 * One committed Surface-lifecycle event, as replayed or observed: `kind`
 * selects which protocol schema validated `event`, so callers get a typed
 * union instead of re-discriminating on shape.
 */
export type SurfaceEngineEvent =
  | { kind: 'patch'; event: SurfacePatchEvent }
  | { kind: 'created'; event: SurfaceCreatedEvent; initiatingTurn?: ChatTurnCorrelation }
  | { kind: 'archived'; event: SurfaceArchivedEvent }
  | { kind: 'pinned'; event: SurfacePinnedEvent }
  | { kind: 'moved'; event: SurfaceMovedEvent }
  | { kind: 'presentation'; event: SurfacePresentationEvent }

export type QueuedAgentTurn = AgentActionTurn & {
  at: string
  payload: JsonObject
  surface: Surface
  atom: AtomNode
  contentOrigin: Origin
}

/** Projects a durable private execution snapshot onto its strict public status. */
export function agentActionTurnSummary(turn: QueuedAgentTurn): AgentActionTurn {
  const {
    at: _at,
    payload: _payload,
    surface: _surface,
    atom: _atom,
    contentOrigin: _origin,
    ...summary
  } = turn
  return AgentActionTurnSchema.parse(summary)
}

export interface SurfaceEngineOptions {
  rootDir: string
  now: () => Date
  timeZone?: string
  seed?: Surface[]
  hasSpace: (spaceId: string) => boolean
  surfaceCommits?: SurfaceCommitTransport
}

export class SurfaceTreeConflictError extends Error {
  constructor(
    readonly surfaceId: string,
    readonly expectedTreeVersion: number,
    readonly actualTreeVersion: number,
  ) {
    super(
      `tree version conflict for Surface ${surfaceId}: expected ${expectedTreeVersion}, actual ${actualTreeVersion}`,
    )
    this.name = 'SurfaceTreeConflictError'
  }
}

export class SurfaceVersionConflictError extends Error {
  constructor(
    readonly surfaceId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `version conflict for Surface ${surfaceId}: expected ${expectedVersion}, actual ${actualVersion}`,
    )
    this.name = 'SurfaceVersionConflictError'
  }
}

/**
 * Raised by generic Agent Surface writes when the target belongs to the
 * Gateway: either a daemon-owned Surface or any Surface in the canonical
 * System Space. Enforced in the engine so no tool wrapper can bypass the
 * ownership boundary. `updatedBy: 'user'` (fast-path clicks) and
 * `updatedBy: 'job'` (the owning manager's writes) remain allowed.
 */
export class SurfaceOwnershipError extends Error {
  constructor(
    readonly surfaceId: string,
    ownership: 'daemon' | 'system' = 'daemon',
  ) {
    super(
      ownership === 'system'
        ? `Surface ${surfaceId} is in the Gateway-owned System Space and cannot be written by the Agent`
        : `Surface ${surfaceId} is daemon-owned and cannot be written by the Agent`,
    )
    this.name = 'SurfaceOwnershipError'
  }
}

/**
 * Raised by `setPinned` when the target Surface is unknown or not eligible
 * for user pinning. Gateway-owned System Surfaces are the deliberate
 * daemon-owned exception because their pin is a presentation preference.
 */
export class SurfaceNotPinnableError extends Error {
  constructor(readonly surfaceId: string) {
    super(`Surface ${surfaceId} is not pinnable or unknown`)
    this.name = 'SurfaceNotPinnableError'
  }
}

export type SurfaceMoveErrorCode = 'unavailable' | 'wrong_space' | 'boundary'

export class SurfaceMoveError extends Error {
  constructor(
    readonly code: SurfaceMoveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SurfaceMoveError'
  }
}

/**
 * One non-disclosing refusal for every Surface the Agent may not read through
 * a Space-scoped authoring registry: missing, archived, daemon-owned, or in a
 * different Space. The message deliberately reveals none of those cases.
 */
export class SurfaceReadError extends Error {
  constructor() {
    super('Surface is not available for authoring in this Space')
    this.name = 'SurfaceReadError'
  }
}

/**
 * A Surface's provenance: which Template it was instantiated from (if any),
 * the Space that Template lives in, and the origin of its tree/state
 * *content* — distinct from `Freshness`, which tracks who last touched it.
 * `templateSpaceId` is required whenever `templateId` is present because a
 * Template id is only unique within its own Space
 * (`templates.ts`'s `templateId` is derived per-Space), so `templateId`
 * alone cannot say which Template a reused Surface actually came from —
 * two Spaces can each hold a Template with the same id. `contentOrigin` is
 * what `enqueueAgentAction` folds into the `agent_path` Event log entry so
 * an imported Template's text cannot be laundered as something the user
 * typed (docs/SECURITY.md §3.2).
 */
export interface SurfaceProvenance {
  templateId?: string
  templateSpaceId?: string
  contentOrigin: Origin
}

export const CreateSurfaceToolInputSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  tree: AtomNodeSchema,
  state: JsonObjectSchema,
  presentation: SurfacePresentationSchema.optional(),
  relativeTime: RelativeTimeAuthoringSchema.optional(),
})

const SurfacePatchToolInputSchema = z.object({
  surfaceId: z.string().min(1),
  operations: z.array(PatchOperationSchema).min(1),
})

const PatchStateToolInputSchema = SurfacePatchToolInputSchema.extend({
  relativeTime: RelativeTimeAuthoringSchema.optional(),
})

const PatchTreeToolInputSchema = SurfacePatchToolInputSchema.extend({
  expectedTreeVersion: z.number().int().nonnegative(),
})

const ArchiveSurfaceToolInputSchema = z.object({
  surfaceId: z.string().min(1),
})

const SetSurfacePresentationToolInputSchema = z.object({
  surfaceId: z.string().min(1),
  presentation: SurfacePresentationSchema,
  userRequest: z.string().min(1),
})

type CreateSurfaceInput = z.infer<typeof CreateSurfaceToolInputSchema>

export interface CreateSurfaceOptions {
  origin?: Origin
  /**
   * Live PWA turn that requested this creation. It is attached only to the
   * post-commit notification and is never written into `surface_events`.
   */
  initiatingTurn?: ChatTurnCorrelation
  /**
   * Marks the created Surface as owned by the daemon itself (approval
   * cards, trust admin Surfaces), not by the Agent: `patchState`/
   * `patchTree`/`archiveSurface` then refuse `updatedBy: 'agent'` writes
   * against it (see `SurfaceOwnershipError`). Defaults to `false` — an
   * ordinary Agent-created Surface (the `create_surface` tool) stays fully
   * writable by the Agent, as before.
   */
  daemonOwned?: boolean
  /** The Template this Surface was instantiated from, if any (provenance). */
  templateId?: string
  /**
   * The Space `templateId` lives in (provenance), required whenever
   * `templateId` is supplied. A Template id is only unique within its own
   * Space, so `templateId` alone is ambiguous about
   * which Template a reused Surface came from. See `SurfaceProvenance`.
   */
  templateSpaceId?: string
  /**
   * The origin of this Surface's tree/state *content*, distinct from who
   * performed the write (`updatedBy`). Defaults to this call's own `origin`
   * (falling back to `'trusted:user'` when neither is supplied). It must
   * preserve an `origin` derived from a tainted turn's
   * live-taint accumulator (`create_surface`'s tool handler,
   * `effectiveToolWriteOrigin`), which would launder that turn's own Surface
   * back in as trusted. A Surface instantiated from an imported Template
   * still carries that Template's origin here explicitly, so
   * `enqueueAgentAction` can derive an honest `agent_path` origin later
   * instead of hardcoding `'trusted:user'` (docs/SECURITY.md §3.2).
   */
  contentOrigin?: Origin
}

/**
 * SQLite-backed owner of persistent Surfaces.
 *
 * The Gateway remains the only caller on the fast path, but this class owns the
 * state transition: patch, validate, persist, log, and produce a replayable
 * patch event. The Agent receives tools over the same API, so there is one write
 * path for Surface state and tree changes.
 */
export class SurfaceEngine {
  private readonly db: DatabaseSync
  private readonly now: () => Date
  private readonly timeZone: string
  private readonly hasSpace: (spaceId: string) => boolean
  private readonly surfaceCommitJournal?: SurfaceCommitJournal
  private stagedSurfaceCommits: SurfaceCommitRecord[] | undefined
  private readonly fastActionLedger: FastActionLedger
  private readonly fastActionPreflights = new Set<(context: FastActionPreflightContext) => void>()
  private readonly surfaceEventObservers = new Set<(event: SurfaceEngineEvent) => void>()
  private readonly treeProposalObservers = new Set<
    (proposal: TreeProposal, initiatingTurn?: ChatTurnCorrelation) => void
  >()

  constructor(options: SurfaceEngineOptions) {
    mkdirSync(options.rootDir, { recursive: true })
    this.db = new DatabaseSync(join(options.rootDir, 'surfaces.sqlite'))
    this.now = options.now
    this.timeZone = options.timeZone ?? 'UTC'
    this.hasSpace = options.hasSpace
    initializeSurfaceSchema(this.db)
    this.fastActionLedger = new FastActionLedger(this.db)
    if (options.surfaceCommits) {
      this.surfaceCommitJournal = new SurfaceCommitJournal(
        this.db,
        options.surfaceCommits,
        this.now,
      )
    }
    if (this.surfaceCount() === 0) this.seed(options.seed ?? [])
    this.initializeSurfaceOrders()
    for (const failure of this.reconcilePendingSurfaceCommits()) {
      console.error('Surface commit boot recovery pending', failure)
    }
    this.interruptAgentTurns()
  }

  recoveryPending(spaceId?: string): SurfaceCommitRecord[] {
    return this.surfaceCommitJournal?.pending(spaceId) ?? []
  }

  reconcilePendingSurfaceCommits(): SurfaceCommitRecoveryPendingError[] {
    if (!this.surfaceCommitJournal) return []
    const failures: SurfaceCommitRecoveryPendingError[] = []
    for (const spaceId of new Set(
      this.surfaceCommitJournal.pending().map((record) => record.spaceId),
    )) {
      try {
        this.notifyRecoveredSurfaceCommits(this.surfaceCommitJournal.reconcileSpace(spaceId))
      } catch (error) {
        if (!(error instanceof SurfaceCommitRecoveryPendingError)) throw error
        failures.push(error)
      }
    }
    return failures
  }

  assertSpaceReadyForAgent(spaceId: string): void {
    if (this.surfaceCommitJournal) {
      this.notifyRecoveredSurfaceCommits(this.surfaceCommitJournal.reconcileSpace(spaceId))
    }
  }

  private notifyRecoveredSurfaceCommits(records: readonly SurfaceCommitRecord[]): void {
    for (const record of records) {
      if (record.surfaceEventCursor !== undefined) {
        const row = this.db
          .prepare('select kind, event_json from surface_events where cursor = ?')
          .get(record.surfaceEventCursor)
        if (row) this.notifySurfaceEvent(surfaceEngineEventFromRow(row))
      } else if (record.event.type === 'surface.tree_proposal') {
        const proposalId = record.event.payload?.['proposalId']
        if (typeof proposalId === 'number') {
          const proposal = this.getTreeProposal(proposalId)
          if (proposal) this.notifyTreeProposal(proposal)
        }
      }
    }
    this.fastActionLedger.publish()
  }

  listSurfaces(spaceId?: string): Surface[] {
    const rows =
      spaceId === undefined
        ? this.db
            .prepare(
              `select surfaces.* from surfaces
               left join surface_order_items on surface_order_items.surface_id = surfaces.id
               where surfaces.archived = 0
               order by surfaces.space_id,
                 case surface_order_items.group_name
                   when 'pinned' then 0
                   when 'regular' then 1
                   else 2
                 end,
                 surface_order_items.position,
                 surfaces.id`,
            )
            .all()
        : this.db
            .prepare(
              `select surfaces.* from surfaces
               left join surface_order_items on surface_order_items.surface_id = surfaces.id
               where surfaces.archived = 0 and surfaces.space_id = ?
               order by case surface_order_items.group_name
                   when 'pinned' then 0
                   when 'regular' then 1
                   else 2
                 end,
                 surface_order_items.position,
                 surfaces.id`,
            )
            .all(spaceId)
    return rows.map(surfaceFromRow)
  }

  surfaceOrder(spaceId: string): SurfaceOrder {
    this.requireKnownSpace(spaceId)
    return this.readSurfaceOrder(spaceId)
  }

  getSurface(id: string): Surface | undefined {
    const row = this.db.prepare('select * from surfaces where id = ? and archived = 0').get(id)
    return row ? surfaceFromRow(row) : undefined
  }

  getSurfaceVersion(id: string): SurfaceVersion | undefined {
    const row = this.db.prepare('select version, tree_version from surfaces where id = ?').get(id)
    if (!row) return undefined
    return {
      version: requiredNumber(row, 'version'),
      treeVersion: requiredNumber(row, 'tree_version'),
    }
  }

  /**
   * Active, non-daemon-owned Surfaces the Agent may author in `spaceId`, in
   * the same stable title/id order used by the ordinary Surface listing.
   * Projected FACTS never enter this SQLite store, so they cannot appear.
   */
  listAuthorableSurfaces(spaceId: string): AuthorableSurfaceInventory {
    this.requireKnownSpace(spaceId)
    if (spaceId === SYSTEM_SPACE_ID) return { surfaces: [], origins: [] }
    const rows = this.db
      .prepare(
        `select * from surfaces
         where space_id = ? and archived = 0 and daemon_owned = 0
         order by title, id`,
      )
      .all(spaceId)
    const origins: Origin[] = []
    const seenOrigins = new Set<Origin>()
    const surfaces = rows.map((row) => {
      const surface = surfaceFromRow(row)
      const origin = contentOriginFromRow(row)
      if (!seenOrigins.has(origin)) {
        seenOrigins.add(origin)
        origins.push(origin)
      }
      return {
        id: surface.id,
        title: surface.title,
        freshness: surface.freshness,
        pinned: surface.pinned ?? false,
        presentation: surface.presentation,
        ...relativeTimeSummary(surface, this.now()),
      }
    })
    return { surfaces, origins }
  }

  /**
   * Reads exactly one authorable Surface inside `spaceId`. Resolution and all
   * exclusion checks happen in one scoped query, so every rejected id gets
   * the same `SurfaceReadError` without exposing content from the row.
   */
  readAuthorableSurface(spaceId: string, surfaceId: string): AuthorableSurfaceRead {
    this.requireKnownSpace(spaceId)
    if (spaceId === SYSTEM_SPACE_ID) throw new SurfaceReadError()
    const row = this.db
      .prepare(
        `select * from surfaces
         where id = ? and space_id = ? and archived = 0 and daemon_owned = 0`,
      )
      .get(surfaceId, spaceId)
    if (!row) throw new SurfaceReadError()
    const surface = surfaceFromRow(row)
    return {
      surface,
      version: requiredNumber(row, 'version'),
      treeVersion: requiredNumber(row, 'tree_version'),
      origins: [contentOriginFromRow(row)],
      ...relativeTimeSummary(surface, this.now()),
    }
  }

  latestSurfaceCursor(): number {
    const row = this.db
      .prepare('select coalesce(max(cursor), 0) as cursor from surface_events')
      .get()
    return row ? requiredNumber(row, 'cursor') : 0
  }

  surfaceEventsAfter(cursor: number): SurfaceEngineEvent[] {
    return this.db
      .prepare(
        `select surface_events.kind, surface_events.event_json from surface_events
         left join surface_commits on surface_commits.surface_event_cursor = surface_events.cursor
         where surface_events.cursor > ?
           and (surface_commits.id is null or surface_commits.state = 'delivered')
         order by surface_events.cursor`,
      )
      .all(cursor)
      .map((row) => surfaceEngineEventFromRow(row))
  }

  /**
   * Observe every committed Surface event exactly once after its SQLite
   * write transaction commits. The Gateway subscribes once, centrally, so
   * nothing double-broadcasts.
   */
  onSurfaceEvent(observer: (event: SurfaceEngineEvent) => void): () => void {
    this.surfaceEventObservers.add(observer)
    return () => this.surfaceEventObservers.delete(observer)
  }

  /**
   * Observe every newly recorded Tree proposal exactly once, after its
   * recording transaction commits (`recordTreeProposal`,
   * `issue #22`). This is how
   * `TreeProposalSurfaceManager` learns a proposal was recorded and builds
   * its preview Surface — the same shape as `onSurfaceEvent`, kept separate
   * because a Tree proposal is not itself a `SurfaceEngineEvent`.
   */
  onTreeProposal(
    observer: (proposal: TreeProposal, initiatingTurn?: ChatTurnCorrelation) => void,
  ): () => void {
    this.treeProposalObservers.add(observer)
    return () => this.treeProposalObservers.delete(observer)
  }

  close(): void {
    this.fastActionLedger.close()
    this.db.close()
  }

  createSurface(
    input: Surface | CreateSurfaceInput,
    updatedBy: SurfaceWriteActor,
    options?: CreateSurfaceOptions,
  ): Surface {
    const daemonOwned = options?.daemonOwned ?? false
    const surface = this.surfaceForWrite(input, updatedBy, daemonOwned)
    if (Object.prototype.hasOwnProperty.call(surface.state, AUTOMATION_OUTCOMES_STATE_KEY)) {
      throw new Error('Automation outcome state is owned by the Gateway')
    }
    this.requireKnownSpace(surface.spaceId)
    this.assertSpaceWritableByAgent(surface.spaceId, surface.id, updatedBy)
    this.assertSpaceReadyForAgent(surface.spaceId)
    // See `CreateSurfaceOptions.contentOrigin`: default to this call's own
    // write origin, never a flat `'trusted:user'`.
    const contentOrigin = options?.contentOrigin ?? options?.origin ?? 'trusted:user'
    const event = this.runWrite(() => {
      const currentOrder = this.ensureSurfaceOrder(surface.spaceId)
      const existing = this.db.prepare('select id from surfaces where id = ?').get(surface.id)
      if (existing) throw new Error(`Surface already exists: ${surface.id}`)
      this.insertSurface(surface, {
        version: 1,
        treeVersion: 1,
        archived: false,
        daemonOwned,
        treeUpdatedAt: surface.freshness.updatedAt,
        ...(options?.templateId === undefined ? {} : { templateId: options.templateId }),
        ...(options?.templateSpaceId === undefined
          ? {}
          : { templateSpaceId: options.templateSpaceId }),
        contentOrigin,
      })
      this.stageSpaceEvent(
        surface.spaceId,
        {
          at: surface.freshness.updatedAt,
          type: 'surface.create',
          text: `Created Surface "${surface.title}"`,
          origin: options?.origin ?? 'trusted:system',
          payload: { surfaceId: surface.id },
        },
        this.latestSurfaceCursor() + 1,
      )
      const cursor = this.latestSurfaceCursor() + 1
      const order = this.writeSurfaceOrder(
        surface.spaceId,
        currentOrder.pinnedSurfaceIds,
        [surface.id, ...currentOrder.regularSurfaceIds],
        cursor,
      )
      const createdEvent = this.insertCreatedEvent(surface, order)
      return createdEvent
    })
    this.notifySurfaceEvent({
      kind: 'created',
      event,
      ...(options?.initiatingTurn === undefined ? {} : { initiatingTurn: options.initiatingTurn }),
    })
    return surface
  }

  /**
   * Locks or unlocks a Surface's tree (`issue #22`),
   * appending `surface.pin` to the Space's Event log inside the same write
   * transaction as the column update (ADR-0003: no silent state change).
   * Refuses an unknown or non-pinnable Surface with `SurfaceNotPinnableError`
   * before any transaction opens. Gateway-owned System Surfaces stay
   * pinnable because this mutation changes presentation, not ownership.
   *
   * `updatedBy`/`origin` come from the caller: a
   * hardcoded `updatedBy: 'user'`/`origin: 'trusted:user'` would let a
   * tool-driven pin forge a genuine user event — `scheduler.ts`'s condition
   * rule admits only `trusted:user` events, so that could self-satisfy a
   * pending escalation. The Event log entry's origin is the most-untrusted
   * of the Surface's own stored content and the caller's origin
   * (`effectiveOrigin`, taint.ts), never a flat `trusted:user`, and the
   * title it renders is delimiter-neutralized and truncated exactly as
   * `approval-surface.ts` does for card text — the title can carry
   * attacker-influenced text (a Surface instantiated from an imported
   * Template) and, unlike a card preview, has no other size bound here.
   */
  setPinned(
    surfaceId: string,
    pinned: boolean,
    options: { origin: Origin; updatedBy: 'user' | 'agent' | 'job' },
  ): SurfacePinMutation {
    this.assertPinnable(surfaceId)
    const pendingTarget = this.getSurface(surfaceId)
    if (pendingTarget) this.assertSpaceReadyForAgent(pendingTarget.spaceId)
    const result = this.runWrite<CommittedSurfacePinMutation>(() => {
      const current = this.getSurface(surfaceId)
      if (!current) throw new SurfaceNotPinnableError(surfaceId)
      const currentOrder = this.ensureSurfaceOrder(current.spaceId)
      if (current.pinned === pinned) {
        return { surface: current, changed: false, order: currentOrder }
      }
      const stamped = this.stampSurface({ ...current, pinned }, options.updatedBy)
      this.db
        .prepare(
          `update surfaces
           set pinned = ?, version = version + 1, updated_at = ?, updated_by = ?
           where id = ? and archived = 0`,
        )
        .run(pinned ? 1 : 0, stamped.freshness.updatedAt, stamped.freshness.updatedBy, surfaceId)
      const storedContentOrigin = this.surfaceProvenance(surfaceId)?.contentOrigin
      const eventOrigin = effectiveOrigin([storedContentOrigin, options.origin], options.origin)
      const title = truncate(neutralizeDelimiters(stamped.title), PIN_EVENT_TITLE_MAX_CHARS)
      this.stageSpaceEvent(
        stamped.spaceId,
        {
          at: stamped.freshness.updatedAt,
          type: 'surface.pin',
          text: `${pinned ? 'Pinned' : 'Unpinned'} Surface "${title}"`,
          origin: eventOrigin,
          payload: { surfaceId, pinned },
        },
        this.latestSurfaceCursor() + 1,
      )
      const withoutTarget = {
        pinned: currentOrder.pinnedSurfaceIds.filter((id) => id !== surfaceId),
        regular: currentOrder.regularSurfaceIds.filter((id) => id !== surfaceId),
      }
      const cursor = this.latestSurfaceCursor() + 1
      const order = this.writeSurfaceOrder(
        stamped.spaceId,
        pinned ? [surfaceId, ...withoutTarget.pinned] : withoutTarget.pinned,
        pinned ? withoutTarget.regular : [surfaceId, ...withoutTarget.regular],
        cursor,
      )
      const event = this.insertPinnedEvent(stamped, pinned, order)
      return { surface: stamped, changed: true, order, event }
    })
    if (result.changed) this.notifySurfaceEvent({ kind: 'pinned', event: result.event })
    return { surface: result.surface, changed: result.changed, order: result.order }
  }

  setPresentation(
    surfaceId: string,
    presentation: SurfacePresentation,
    options: SurfacePresentationOptions,
  ): SurfacePresentationMutation {
    const validated = SurfacePresentationSchema.parse(presentation)
    if (options.userRequest?.origin !== 'trusted:user' || !options.userRequest.text.trim()) {
      throw new Error('Surface presentation changes require an explicit current user request')
    }
    this.assertWritableByAgent(surfaceId, options.updatedBy)
    const target = this.requireActiveSurface(surfaceId)
    this.assertSpaceReadyForAgent(target.spaceId)
    const result = this.runWrite<SurfacePresentationMutation>(() => {
      const current = this.requireActiveSurface(surfaceId)
      const previous =
        options.idempotencyKey === undefined
          ? undefined
          : this.db
              .prepare(
                'select surface_id, presentation from surface_presentation_idempotency_keys where key = ?',
              )
              .get(options.idempotencyKey)
      if (previous) {
        if (previous['surface_id'] !== surfaceId || previous['presentation'] !== validated) {
          throw new Error('Surface presentation retry does not match the original request')
        }
        return { surface: current, changed: false, duplicate: true }
      }
      if (options.idempotencyKey !== undefined) {
        this.db
          .prepare(
            'insert into surface_presentation_idempotency_keys (key, surface_id, presentation) values (?, ?, ?)',
          )
          .run(options.idempotencyKey, surfaceId, validated)
      }
      if (current.presentation === validated)
        return { surface: current, changed: false, duplicate: false }
      const stamped = this.stampSurface({ ...current, presentation: validated }, options.updatedBy)
      this.db
        .prepare(
          'update surfaces set presentation = ?, version = version + 1, updated_at = ?, updated_by = ? where id = ? and archived = 0',
        )
        .run(validated, stamped.freshness.updatedAt, stamped.freshness.updatedBy, surfaceId)
      const cursor = this.latestSurfaceCursor() + 1
      const event = SurfacePresentationEventSchema.parse({
        cursor,
        at: stamped.freshness.updatedAt,
        spaceId: stamped.spaceId,
        surfaceId,
        presentation: validated,
        freshness: stamped.freshness,
      })
      const contentOrigin = this.surfaceProvenance(surfaceId)?.contentOrigin
      const title = truncate(neutralizeDelimiters(stamped.title), PIN_EVENT_TITLE_MAX_CHARS)
      this.stageSpaceEvent(
        stamped.spaceId,
        {
          at: event.at,
          type: 'surface.presentation',
          text: `Changed Surface "${title}" presentation to ${validated}`,
          origin: effectiveOrigin([contentOrigin, options.origin], options.origin),
          payload: { surfaceId, presentation: validated },
        },
        cursor,
      )
      this.insertEventRow(cursor, event.at, event.spaceId, surfaceId, 'presentation', event)
      return { surface: stamped, changed: true, duplicate: false, event }
    })
    if (result.event) this.notifySurfaceEvent({ kind: 'presentation', event: result.event })
    return result
  }

  moveSurface(spaceId: string, surfaceId: string, direction: SurfaceMoveDirection): SurfaceOrder {
    const result = this.runWrite(() => {
      const row = this.db
        .prepare(
          'select space_id, archived, pinned, title, content_origin from surfaces where id = ?',
        )
        .get(surfaceId)
      if (!row || requiredNumber(row, 'archived') !== 0) {
        throw new SurfaceMoveError('unavailable', 'Surface is not available for ordering')
      }
      if (requiredString(row, 'space_id') !== spaceId) {
        throw new SurfaceMoveError('wrong_space', 'Surface does not belong to the requested Space')
      }

      const currentOrder = this.ensureSurfaceOrder(spaceId)
      const pinned = requiredNumber(row, 'pinned') === 1
      const group = pinned
        ? [...currentOrder.pinnedSurfaceIds]
        : [...currentOrder.regularSurfaceIds]
      const index = group.indexOf(surfaceId)
      const nextIndex = index + (direction === 'up' ? -1 : 1)
      if (index < 0 || nextIndex < 0 || nextIndex >= group.length) {
        throw new SurfaceMoveError(
          'boundary',
          `Surface cannot move ${direction} within its current group`,
        )
      }
      ;[group[index], group[nextIndex]] = [group[nextIndex]!, group[index]!]

      const at = this.nowIso()
      const cursor = this.latestSurfaceCursor() + 1
      const order = this.writeSurfaceOrder(
        spaceId,
        pinned ? group : currentOrder.pinnedSurfaceIds,
        pinned ? currentOrder.regularSurfaceIds : group,
        cursor,
      )
      const title = truncate(
        neutralizeDelimiters(requiredString(row, 'title')),
        PIN_EVENT_TITLE_MAX_CHARS,
      )
      const storedContentOrigin = requiredString(row, 'content_origin')
      this.stageSpaceEvent(
        spaceId,
        {
          at,
          type: 'surface.move',
          text: `Moved Surface "${title}" ${direction}`,
          origin: isValidOrigin(storedContentOrigin)
            ? effectiveOrigin([storedContentOrigin, 'trusted:user'], 'trusted:user')
            : 'trusted:user',
          payload: { surfaceId, direction },
        },
        cursor,
      )
      const event = this.insertMovedEvent({ cursor, at, spaceId, surfaceId, direction, order })
      return { order, event }
    })
    this.notifySurfaceEvent({ kind: 'moved', event: result.event })
    return result.order
  }

  /**
   * Active, non-daemon-owned Surfaces whose tree has not changed since
   * `beforeIso`: the stability query the Template harvest
   * (`issue #22`) uses to decide which Surfaces are
   * candidates for a Template. This method only answers "what is stable" —
   * it does not decide whether to harvest, which stays the caller's policy.
   */
  stableSurfaces(beforeIso: string): Surface[] {
    return this.db
      .prepare(
        `select * from surfaces
         where archived = 0 and daemon_owned = 0 and space_id <> ? and tree_updated_at <= ?
         order by id`,
      )
      .all(SYSTEM_SPACE_ID, beforeIso)
      .map(surfaceFromRow)
  }

  /** The stored provenance for `surfaceId`, or `undefined` if unknown. */
  surfaceProvenance(surfaceId: string): SurfaceProvenance | undefined {
    const row = this.db
      .prepare('select template_id, template_space_id, content_origin from surfaces where id = ?')
      .get(surfaceId)
    if (!row) return undefined
    const templateId = optionalString(row, 'template_id')
    const templateSpaceId = optionalString(row, 'template_space_id')
    return {
      ...(templateId === undefined ? {} : { templateId }),
      ...(templateSpaceId === undefined ? {} : { templateSpaceId }),
      contentOrigin: contentOriginFromRow(row),
    }
  }

  /**
   * Tree proposals `patchTree` recorded, optionally filtered by
   * `surfaceId` and/or `status`. Used by `tree-proposal.ts`'s
   * `TreeProposalSurfaceManager` to render the preview Surface.
   */
  listTreeProposals(options?: { surfaceId?: string; status?: TreeProposalStatus }): TreeProposal[] {
    const clauses: string[] = []
    const params: string[] = []
    if (options?.surfaceId !== undefined) {
      clauses.push('surface_id = ?')
      params.push(options.surfaceId)
    }
    if (options?.status !== undefined) {
      clauses.push('status = ?')
      params.push(options.status)
    }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
    return this.db
      .prepare(`select * from tree_proposals ${where} order by id`)
      .all(...params)
      .map(treeProposalFromRow)
  }

  /** The Tree proposal at `id`, or `undefined` if unknown. */
  getTreeProposal(id: number): TreeProposal | undefined {
    const row = this.db.prepare('select * from tree_proposals where id = ?').get(id)
    return row ? treeProposalFromRow(row) : undefined
  }

  /**
   * Resolves a `pending` Tree proposal exactly once: a guarded
   * `update ... where status = 'pending'`, so a doubled Accept/Reject click
   * can never resolve — let alone apply — the same proposal twice
   * (`issue #22`). Returns `undefined` when `id` is
   * unknown or was already resolved; the caller (`tree-proposal.ts`'s
   * `TreeProposalSurfaceManager`) is responsible for actually applying an
   * `accepted` proposal via `patchTree`'s `bypassPin`.
   */
  resolveTreeProposal(
    id: number,
    status: 'accepted' | 'rejected' | 'stale',
    actor: 'trusted:user',
  ): TreeProposal | undefined {
    if (actor !== 'trusted:user') throw new Error('Tree proposal resolution requires trusted:user')
    const resolvedAt = this.nowIso()
    return this.runWrite(() => {
      const result = this.db
        .prepare(
          `update tree_proposals set status = ?, resolved_at = ?, resolved_by = ?
           where id = ? and status = 'pending'`,
        )
        .run(status, resolvedAt, actor, id)
      if (Number(result.changes) !== 1) return undefined
      return this.getTreeProposal(id)
    })
  }

  /**
   * Puts an `accepted` Tree proposal back to `pending`.
   * `TreeProposalSurfaceManager`'s accept path claims the row
   * `accepted` before calling `patchTree` — the exactly-once gate — but if
   * that call throws (e.g. a state patch removed a key the proposed node
   * binds while `treeVersion` stayed put, so the dry-run re-validation
   * fails at accept time even though the staleness check passed), the
   * proposal must not be stuck `accepted` forever with no way to retry. A
   * guarded `update ... where status = 'accepted'`, mirroring
   * `resolveTreeProposal`'s own exactly-once discipline: only a proposal
   * this caller itself just claimed can be reopened, never one a racing
   * observer already resolved differently. Returns `undefined` when `id` is
   * unknown or not currently `accepted`.
   */
  reopenTreeProposal(id: number): TreeProposal | undefined {
    return this.runWrite(() => {
      const result = this.db
        .prepare(
          `update tree_proposals set status = 'pending', resolved_at = null, resolved_by = null
           where id = ? and status = 'accepted'`,
        )
        .run(id)
      if (Number(result.changes) !== 1) return undefined
      return this.getTreeProposal(id)
    })
  }

  archiveSurface(surfaceId: string, updatedBy: SurfaceWriteActor, origin?: Origin): Surface {
    this.assertWritableByAgent(surfaceId, updatedBy)
    const pendingTarget = this.getSurface(surfaceId)
    if (pendingTarget) this.assertSpaceReadyForAgent(pendingTarget.spaceId)
    const surface = this.requireActiveSurface(surfaceId)
    const archived = this.stampSurface(surface, updatedBy)
    const event = this.runWrite(() => {
      const currentOrder = this.ensureSurfaceOrder(surface.spaceId)
      this.db
        .prepare(
          `update surfaces
           set archived = 1, version = version + 1, updated_at = ?, updated_by = ?
           where id = ?`,
        )
        .run(archived.freshness.updatedAt, archived.freshness.updatedBy, surfaceId)
      this.stageSpaceEvent(
        surface.spaceId,
        {
          at: archived.freshness.updatedAt,
          type: 'surface.archive',
          text: `Archived Surface "${surface.title}"`,
          origin: origin ?? 'trusted:system',
          payload: { surfaceId },
        },
        this.latestSurfaceCursor() + 1,
      )
      const cursor = this.latestSurfaceCursor() + 1
      const order = this.writeSurfaceOrder(
        surface.spaceId,
        currentOrder.pinnedSurfaceIds.filter((id) => id !== surfaceId),
        currentOrder.regularSurfaceIds.filter((id) => id !== surfaceId),
        cursor,
      )
      const archivedEvent = this.insertArchivedEvent(archived, order)
      return archivedEvent
    })
    this.notifySurfaceEvent({ kind: 'archived', event })
    return archived
  }

  patchState(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      updatedBy: SurfaceWriteActor
      origin?: Origin
      relativeTime?: RelativeTimeAuthoring
      eventPayload?: JsonObject
    },
  ): SurfaceMutation {
    assertPatchTarget(operations, 'state')
    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_state',
      eventText: (surface) => `Patched state for Surface "${surface.title}"`,
      updateTreeVersion: false,
      ...(options.eventPayload === undefined ? {} : { eventPayload: options.eventPayload }),
      ...(options.relativeTime === undefined ? {} : { relativeTime: options.relativeTime }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  /**
   * Commits one recurring Automation occurrence through the same validated,
   * recoverable Surface/Event boundary as every other state mutation.
   */
  commitAutomationOutcome(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      automationId: number
      scheduledFor: string
      kind: AutomationOutcomeKind
      summary: string
      idempotencyKey: string
      expectedVersion?: number
      origin?: Origin
      checkedAt?: string
      historyId?: string
      recordInHistory?: boolean
      notificationIntent?: JsonObject
    },
  ): SurfaceMutation {
    assertPatchTarget(operations, 'state')
    const duplicate = this.findAutomationOutcomeIdempotentMutation(options.idempotencyKey)
    if (duplicate) return duplicate

    return this.patchSurface(surfaceId, operations, {
      updatedBy: 'job',
      eventType: 'automation.outcome',
      eventText: () =>
        `Automation ${options.automationId} recorded a ${options.kind} Surface outcome`,
      updateTreeVersion: false,
      automationOutcomeIdempotencyKey: options.idempotencyKey,
      allowAutomationOutcomeState: true,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
      eventPayload: {
        surfaceId,
        automationId: options.automationId,
        scheduledFor: options.scheduledFor,
        kind: options.kind,
        summary: options.summary,
        ...(options.checkedAt === undefined ? {} : { checkedAt: options.checkedAt }),
        ...(options.historyId === undefined ? {} : { historyId: options.historyId }),
        ...(options.recordInHistory === undefined
          ? {}
          : { recordInHistory: options.recordInHistory }),
        ...(options.notificationIntent === undefined
          ? {}
          : { notificationIntent: options.notificationIntent }),
      },
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  /** Dry-runs producer-authored state operations before an outcome is claimed durably. */
  validateAutomationOutcomeOperations(surfaceId: string, operations: PatchOperation[]): void {
    assertPatchTarget(operations, 'state')
    assertAutomationOutcomeStateNotPatched(operations)
    this.assertWritableByAgent(surfaceId, 'job')
    const current = this.requireActiveSurface(surfaceId)
    this.buildPatchedSurface(current, surfaceId, operations, 'job')
  }

  /**
   * Patches a Surface's Atom tree — unless the target is pinned, in which
   * case the patch is dry-applied and re-validated (`buildPatchedSurface`,
   * the same validation `patchSurface` performs on the committed path) and
   * recorded as a `pending` Tree proposal instead of mutating
   * (`issue #22`): the pin is a capability on the
   * Surface, not normally a property of `updatedBy`. The canonical System
   * Space is the deliberate exception: its Pin is only a presentation
   * preference, so a Gateway manager refresh (`updatedBy: 'job'`) continues
   * to update the daemon-owned content. `bypassPin: true` is the documented
   * escape hatch for ordinary Spaces (`tree-proposal.ts`'s
   * `TreeProposalSurfaceManager`, once the human has accepted); it is never
   * derived from `updatedBy` — every daemon-owned Surface manager already
   * writes as `'job'` (docs/adr/0012-emergent-templates.md, "The pin is a
   * capability, not an actor"), so an actor-based bypass would be one
   * refactor away from silently evaporating. Discriminate the result with
   * `'proposed' in result`.
   */
  patchTree(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      expectedTreeVersion: number
      updatedBy: SurfaceWriteActor
      origin?: Origin
      bypassPin?: true
      eventPayload?: JsonObject
      /** Forwarded only to a live Tree-proposal card notification; never persisted. */
      initiatingTurn?: ChatTurnCorrelation
    },
  ): SurfaceMutation | TreeProposalRecorded {
    assertPatchTarget(operations, 'tree')
    const version = this.getSurfaceVersion(surfaceId)
    if (!version) throw new Error(`unknown Surface: ${surfaceId}`)
    if (version.treeVersion !== options.expectedTreeVersion) {
      throw new SurfaceTreeConflictError(
        surfaceId,
        options.expectedTreeVersion,
        version.treeVersion,
      )
    }
    this.assertWritableByAgent(surfaceId, options.updatedBy)

    if (options.bypassPin !== true) {
      const current = this.requireActiveSurface(surfaceId)
      const isGatewaySystemRefresh =
        current.spaceId === SYSTEM_SPACE_ID && options.updatedBy === 'job'
      if (current.pinned && !isGatewaySystemRefresh) {
        return this.recordTreeProposal(current, operations, {
          expectedTreeVersion: options.expectedTreeVersion,
          updatedBy: options.updatedBy,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.initiatingTurn === undefined
            ? {}
            : { initiatingTurn: options.initiatingTurn }),
        })
      }
    }

    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_tree',
      eventText: (surface) => `Patched tree for Surface "${surface.title}"`,
      updateTreeVersion: true,
      ...(options.eventPayload === undefined ? {} : { eventPayload: options.eventPayload }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  /** One complete validated projection update through the existing recoverable commit. */
  patchDaemonSurface(
    surfaceId: string,
    operations: PatchOperation[],
    options: { expectedTreeVersion: number; origin?: Origin },
  ): SurfaceMutation {
    if (!this.isDaemonOwned(surfaceId))
      throw new Error('projection refresh requires a daemon-owned Surface')
    const version = this.requireVersion(surfaceId)
    if (version.treeVersion !== options.expectedTreeVersion)
      throw new SurfaceTreeConflictError(
        surfaceId,
        options.expectedTreeVersion,
        version.treeVersion,
      )
    return this.patchSurface(surfaceId, operations, {
      updatedBy: 'job',
      expectedVersion: version.version,
      eventType: 'surface.refresh',
      eventText: (surface) => `Refreshed Surface "${surface.title}"`,
      updateTreeVersion: operations.some((operation) => operation.target === 'tree'),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  invokeFastAction(surfaceId: string, input: FastActionInvocation): FastActionOutcome {
    const invocation = FastActionInvocationSchema.parse(input)
    const original = this.fastActionLedger.get(invocation.intentId)
    if (original) {
      if (
        original.surfaceId !== surfaceId ||
        original.nodeId !== invocation.nodeId ||
        original.actionName !== invocation.name ||
        original.actionRevision !== invocation.actionRevision
      )
        throw new SurfaceActionError(
          'intent_conflict',
          'intent identity belongs to a different Action',
        )
      if (
        original.outcome === 'committed' &&
        !this.fastActionLedger.isDelivered(original.surfaceCommitId)
      ) {
        try {
          this.assertSpaceReadyForAgent(original.surface.spaceId)
        } catch (error) {
          if (!(error instanceof SurfaceCommitRecoveryPendingError)) throw error
          return {
            outcome: 'recovery_pending',
            surfaceId,
            nodeId: original.nodeId,
            actionName: original.actionName,
            actionRevision: original.actionRevision,
            intentId: original.intentId,
            surfaceCommitId: error.commitId,
            spaceId: error.spaceId,
            duplicate: true,
          }
        }
      }
      this.fastActionLedger.publish()
      return { ...original, duplicate: true }
    }
    const existing = this.getSurface(surfaceId)
    if (!existing) throw new SurfaceActionError('unknown_surface', 'unknown Surface')
    this.assertSpaceReadyForAgent(existing.spaceId)
    let outcome: FastActionOutcome
    try {
      outcome = this.runWrite(() => {
        const current = this.requireActiveSurface(surfaceId)
        const node = findAtom(current.tree, invocation.nodeId)
        const action = node?.actions?.find((candidate) => candidate.name === invocation.name)
        if (!node || action?.path !== 'fast')
          throw new SurfaceActionError(
            'undeclared_action',
            'the declared fast Action no longer exists',
          )
        if (action.revision !== invocation.actionRevision)
          throw new SurfaceActionError(
            'stale_action',
            'the Action changed since this intent was prepared',
          )
        const identity = {
          surfaceId,
          nodeId: node.id,
          actionName: action.name,
          actionRevision: invocation.actionRevision,
          intentId: invocation.intentId,
        }
        const reduced = reduceFastAction(current, node, action, invocation, {
          recordId: randomUUID(),
          now: this.nowIso(),
        })
        for (const preflight of this.fastActionPreflights) {
          try {
            const result = preflight(
              freezeFastActionPreflight({
                actor: 'trusted:user' as const,
                surface: current,
                node,
                action,
                invocation,
                nextSurface: reduced.surface,
                operations: reduced.operations,
              }),
            )
            if (result !== undefined)
              throw new SurfaceActionError(
                'preflight_rejected',
                'preflight must be synchronous and cannot mutate state',
              )
          } catch (error) {
            if (error instanceof SurfaceActionError) throw error
            throw new SurfaceActionError(
              'preflight_rejected',
              error instanceof Error ? error.message : 'Action precondition failed',
            )
          }
        }
        if (reduced.operations.length === 0) {
          const noop = {
            ...identity,
            outcome: 'noop' as const,
            reason: reduced.reason,
            duplicate: false,
          }
          this.fastActionLedger.record(noop)
          return noop
        }
        assertAutomationOutcomeStateNotPatched(reduced.operations)
        const currentVersion = this.requireVersion(surfaceId)
        const patched = this.stampSurface(reduced.surface, 'user')
        const patch = PatchSchema.parse({ surfaceId, operations: reduced.operations })
        const cursor = this.latestSurfaceCursor() + 1
        const origin = this.surfaceProvenance(surfaceId)?.contentOrigin ?? 'trusted:user'
        this.updateSurface(
          patched,
          currentVersion.version + 1,
          currentVersion.treeVersion,
          undefined,
          origin,
        )
        const title = truncate(neutralizeDelimiters(patched.title), PIN_EVENT_TITLE_MAX_CHARS)
        const actionName = truncate(neutralizeDelimiters(action.name), PIN_EVENT_TITLE_MAX_CHARS)
        const commit = this.stageSpaceEvent(
          patched.spaceId,
          {
            at: patched.freshness.updatedAt,
            type: 'fast_path',
            text: `${title}: ${actionName} committed ${reduced.operations.length} mutation steps`,
            origin: effectiveOrigin([origin], 'trusted:user'),
            payload: {
              ...identity,
              targets: Object.keys(action.plan.targets),
              operations: reduced.operations.length,
            },
          },
          cursor,
        )
        const committed = CommittedFastActionOutcomeSchema.parse({
          ...identity,
          outcome: 'committed',
          patch,
          surface: patched,
          surfaceVersion: currentVersion.version + 1,
          treeVersion: currentVersion.treeVersion,
          surfaceCommitId: commit.id,
          eventCursor: cursor,
          surfaceCursor: cursor,
          duplicate: false,
        })
        const { surface: _surface, patch: _patch, ...metadata } = committed
        this.insertPatchEvent(patched, patch, metadata)
        this.fastActionLedger.record(committed)
        return committed
      })
    } catch (error) {
      if (!(error instanceof SurfaceCommitRecoveryPendingError)) throw error
      const saved = this.fastActionLedger.get(invocation.intentId)
      if (saved?.outcome !== 'committed') throw error
      return {
        outcome: 'recovery_pending',
        surfaceId,
        nodeId: saved.nodeId,
        actionName: saved.actionName,
        actionRevision: saved.actionRevision,
        intentId: saved.intentId,
        surfaceCommitId: saved.surfaceCommitId,
        spaceId: saved.surface.spaceId,
        duplicate: false,
      }
    }
    if (outcome.outcome === 'committed')
      this.notifySurfaceEvent({ kind: 'patch', event: this.eventByCursor(outcome.eventCursor) })
    this.fastActionLedger.publish()
    return outcome
  }

  onFastActionPreflight(preflight: (context: FastActionPreflightContext) => void): () => void {
    this.fastActionPreflights.add(preflight)
    return () => {
      this.fastActionPreflights.delete(preflight)
    }
  }
  onFastActionOutcome(
    name: string,
    observer: (outcome: CommittedFastActionOutcome) => void | Promise<void>,
  ): () => void {
    return this.fastActionLedger.observe(name, observer)
  }

  enqueueAgentAction(surface: Surface, invocation: AgentActionInvocation): QueuedAgentTurn {
    const duplicate = this.replayAgentAction(surface.id, invocation)
    if (duplicate) return duplicate
    const atom = findAtom(surface.tree, invocation.nodeId)
    const action = findDeclaredAgentAction(surface.tree, invocation.nodeId, invocation.name)
    if (!atom || !action) {
      throw new Error(
        `action "${invocation.name}" is not declared as agent by node "${invocation.nodeId}"`,
      )
    }

    if (atom.props?.['disabled'] === true) {
      throw new SurfaceActionError('disabled_control', `this ${atom.type} is disabled`)
    }
    if (
      (atom.type === 'Button' || atom.type === 'ListItem') &&
      invocation.payload !== undefined &&
      canonicalJson(invocation.payload) !== canonicalJson(action.payload ?? {})
    ) {
      throw new SurfaceActionError(
        'invalid_payload',
        `${atom.type} payload must exactly match its declared Action payload`,
      )
    }

    const owningInputs = owningActionInputs(atom)
    for (const [key, spec] of Object.entries(owningInputs)) {
      const supplied = invocation.payload
      if (!supplied || !Object.hasOwn(supplied, key) || !actionValueMatches(spec, supplied[key]!)) {
        throw new SurfaceActionError(
          'invalid_payload',
          `Agent interaction requires its typed owning input "${key}"`,
        )
      }
    }
    if (Object.keys(owningInputs).length > 0) {
      for (const [key, supplied] of Object.entries(invocation.payload ?? {})) {
        if (Object.hasOwn(owningInputs, key)) continue
        if (
          !Object.hasOwn(action.payload ?? {}, key) ||
          canonicalJson(supplied) !== canonicalJson(action.payload![key]!)
        ) {
          throw new SurfaceActionError(
            'invalid_payload',
            'Agent interaction payload may contain only typed owning inputs and its declared fixed values',
          )
        }
      }
    }

    const payload = JsonObjectSchema.parse({
      ...(action.payload ?? {}),
      ...(invocation.payload ?? {}),
    })
    const at = this.nowIso()
    // The event's origin is derived from the target Surface's stored
    // `content_origin`, not hardcoded to `trusted:user`: a Surface
    // instantiated from an imported (untrusted) Template must not have its
    // tree's text laundered into the Agent's context as something the user
    // typed (docs/SECURITY.md §3.2). `effectiveOrigin` keeps the untrusted
    // mark when the content carries one, and falls back to `trusted:user`
    // for the ordinary case — a Surface the user really did create.
    const contentOrigin = this.surfaceProvenance(surface.id)?.contentOrigin ?? 'trusted:user'
    const request = agentActionRequest(surface.id, invocation)
    this.assertSpaceReadyForAgent(surface.spaceId)
    const id = this.runWrite(() => {
      const replay = this.findAgentActionRequest(surface.id, invocation)
      if (replay) return agentTurnRowId(replay.id)!
      const result = this.db
        .prepare(
          `insert into agent_turns
             (at, space_id, surface_id, atom_id, action_name, payload_json, surface_json, atom_json,
              content_origin, status, idempotency_key, request_json)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          at,
          surface.spaceId,
          surface.id,
          atom.id,
          invocation.name,
          JSON.stringify(payload),
          JSON.stringify(surface),
          JSON.stringify(atom),
          contentOrigin,
          invocation.idempotencyKey ?? null,
          request,
        )
      this.stageSpaceEvent(surface.spaceId, {
        at,
        type: 'agent_path',
        text: `${surface.title}: ${invocation.name} requested from Atom "${atom.id}"`,
        origin: effectiveOrigin([contentOrigin], 'trusted:user'),
        payload: {
          agentTurnId: `agent-turn-${Number(result.lastInsertRowid)}`,
          ...(invocation.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: invocation.idempotencyKey }),
          surfaceId: surface.id,
          atomId: atom.id,
          actionName: invocation.name,
          payload,
        },
      })
      return Number(result.lastInsertRowid)
    })

    return this.agentTurn(`agent-turn-${id}`)!
  }

  /** Stable request replays resolve before the current Surface or declaration is inspected. */
  replayAgentAction(
    surfaceId: string,
    invocation: AgentActionInvocation,
  ): QueuedAgentTurn | undefined {
    const replay = this.findAgentActionRequest(surfaceId, invocation)
    if (replay) this.assertSpaceReadyForAgent(replay.spaceId)
    return replay
  }

  private findAgentActionRequest(
    surfaceId: string,
    invocation: AgentActionInvocation,
  ): QueuedAgentTurn | undefined {
    if (invocation.idempotencyKey === undefined) return undefined
    const row = this.db
      .prepare('select * from agent_turns where idempotency_key = ?')
      .get(invocation.idempotencyKey)
    if (!row) return undefined
    if (requiredString(row, 'request_json') !== agentActionRequest(surfaceId, invocation)) {
      throw new SurfaceActionError(
        'idempotency_conflict',
        'this Agent Action request identity is already assigned to a different request',
      )
    }
    return agentTurnFromRow(row)
  }

  agentTurns(): QueuedAgentTurn[] {
    return this.db.prepare('select * from agent_turns order by id').all().map(agentTurnFromRow)
  }

  agentTurn(id: string): QueuedAgentTurn | undefined {
    const rowId = agentTurnRowId(id)
    if (rowId === undefined) return undefined
    const row = this.db.prepare('select * from agent_turns where id = ?').get(rowId)
    return row === undefined ? undefined : agentTurnFromRow(row)
  }

  queuedAgentTurns(): QueuedAgentTurn[] {
    return this.db
      .prepare("select * from agent_turns where status = 'queued' order by id")
      .all()
      .map(agentTurnFromRow)
  }

  /** A request cannot enter the Agent loop until its matching Space Event is delivered. */
  claimAgentTurn(id: string): QueuedAgentTurn | undefined {
    const current = this.agentTurn(id)
    if (current?.status !== 'queued') return undefined
    this.assertSpaceReadyForAgent(current.spaceId)
    const changed = this.db
      .prepare("update agent_turns set status = 'running' where id = ? and status = 'queued'")
      .run(agentTurnRowId(id)!)
    return changed.changes === 0 ? undefined : this.agentTurn(id)
  }

  finishAgentTurn(
    id: string,
    result: { message: ChatMessage; surfaceCursor: number } | { error: string },
  ): QueuedAgentTurn | undefined {
    return withImmediateTransaction(this.db, () => {
      const current = this.agentTurn(id)
      if (!current || current.status === 'completed' || current.status === 'failed') return current
      if ('message' in result && current.status !== 'running') {
        throw new Error('an Agent Action must be running before completion')
      }
      if ('message' in result && result.surfaceCursor !== this.latestSurfaceCursor()) {
        throw new Error(
          'Agent Action completion must identify the current authoritative Surface cursor',
        )
      }
      const summary = AgentActionTurnSchema.parse({
        ...agentActionTurnSummary(current),
        status: 'message' in result ? 'completed' : 'failed',
        ...result,
      })
      this.db
        .prepare('update agent_turns set status = ?, result_json = ? where id = ?')
        .run(summary.status, JSON.stringify(result), agentTurnRowId(id)!)
      return this.agentTurn(id)
    })
  }

  /** A running turn may have caused external effects; boot recovery never executes it again. */
  interruptAgentTurns(): QueuedAgentTurn[] {
    return withImmediateTransaction(this.db, () => {
      const running = this.db
        .prepare("select id from agent_turns where status = 'running' order by id")
        .all()
      this.db
        .prepare(
          "update agent_turns set status = 'failed', result_json = ? where status = 'running'",
        )
        .run(
          JSON.stringify({
            error:
              'Agent action execution was interrupted; inspect canonical outcome before retrying',
          }),
        )
      return running.map((row) => this.agentTurn(`agent-turn-${requiredNumber(row, 'id')}`)!)
    })
  }

  surfaceTools(): ToolDef[] {
    return [
      defineTool({
        name: 'create_surface',
        description:
          'Create a protocol-valid Surface inside a Space. For progressive composition, include ' +
          "typed Pending leaves in the complete initial layout; the new Surface's tree version " +
          'starts at 1. For today/this-week/this-month projections, declare relativeTime with a ' +
          'separate durable source state key and every projected state key. ' +
          'Choose standard presentation by default, or full when the initial content needs the whole Space row.',
        schema: CreateSurfaceToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const surface = this.createSurface(input, 'agent', {
            origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
            ...(context.initiatingTurn === undefined
              ? {}
              : { initiatingTurn: context.initiatingTurn }),
          })
          return { content: `created Surface ${surface.id}`, details: { surface } }
        },
      }),
      defineTool({
        name: 'set_surface_presentation',
        description:
          'Set standard or full Surface presentation only when the current user explicitly asks ' +
          'to change it. Quote that exact current request in userRequest. Never call this for ' +
          'ordinary content updates, Template reuse, Automations, or proactive work. Presentation ' +
          'is independent of the Atom tree, state, Pin, and order; never supply styling or dimensions.',
        schema: SetSurfacePresentationToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const request = context.currentUserRequest
          if (
            context.trigger?.kind !== 'chat' ||
            context.initiatingTurn === undefined ||
            request?.origin !== 'trusted:user' ||
            request.text.trim() !== input.userRequest.trim()
          ) {
            throw new Error('Surface presentation changes require an explicit current user request')
          }
          const mutation = this.setPresentation(input.surfaceId, input.presentation, {
            updatedBy: 'agent',
            origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
            userRequest: request,
            idempotencyKey: `surface-presentation:${context.initiatingTurn.turnId}:${input.surfaceId}`,
          })
          return {
            content: `Surface ${mutation.surface.id} presentation is ${mutation.surface.presentation}${mutation.changed ? ' (committed)' : ' (unchanged)'}`,
            details: { ...mutation, ...this.getSurfaceVersion(input.surfaceId) },
          }
        },
      }),
      defineTool({
        name: 'patch_state',
        description:
          'Patch typed Surface state with protocol validation. A relative-time source or ' +
          'projection patch must update all declared projection state keys together; use ' +
          'relativeTime only to retrofit a legacy Surface contract.',
        schema: PatchStateToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const mutation = this.patchState(input.surfaceId, input.operations, {
            updatedBy: 'agent',
            origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
            ...(input.relativeTime === undefined ? {} : { relativeTime: input.relativeTime }),
          })
          return { content: `patched state for Surface ${input.surfaceId}`, details: mutation }
        },
      }),
      defineTool({
        name: 'patch_tree',
        description:
          'Patch a Surface Atom tree when the expected tree version still matches. Replace ' +
          'Pending leaves in place as regions resolve; each committed patch increments the tree ' +
          'version by one.',
        schema: PatchTreeToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const result = this.patchTree(input.surfaceId, input.operations, {
            expectedTreeVersion: input.expectedTreeVersion,
            updatedBy: 'agent',
            origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
            ...(context.initiatingTurn === undefined
              ? {}
              : { initiatingTurn: context.initiatingTurn }),
          })
          // A pinned Surface is not an error: the Agent must be told plainly
          // that the tree change is a proposal awaiting the user, not retry
          // or report a failure (issue #22).
          if ('proposed' in result) {
            return {
              content: `tree change proposed for Surface ${input.surfaceId}, awaiting the user`,
              details: { proposalId: result.proposalId },
            }
          }
          return { content: `patched tree for Surface ${input.surfaceId}`, details: result }
        },
      }),
      defineTool({
        name: 'archive_surface',
        description: 'Archive a Surface without deleting its Space memory.',
        schema: ArchiveSurfaceToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const surface = this.archiveSurface(
            input.surfaceId,
            'agent',
            effectiveToolWriteOrigin(context.taint.origins(), context.origin),
          )
          return { content: `archived Surface ${surface.id}`, details: { surface } }
        },
      }),
    ]
  }

  private patchSurface(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      updatedBy: SurfaceWriteActor
      eventType: string
      eventText: (surface: Surface) => string
      updateTreeVersion: boolean
      idempotencyKey?: string
      automationOutcomeIdempotencyKey?: string
      eventPayload?: JsonObject
      origin?: Origin
      relativeTime?: RelativeTimeAuthoring
      allowAutomationOutcomeState?: true
      expectedVersion?: number
    },
  ): SurfaceMutation {
    if (options.allowAutomationOutcomeState !== true) {
      assertAutomationOutcomeStateNotPatched(operations)
    }
    this.assertWritableByAgent(surfaceId, options.updatedBy)
    const mutation = this.runWrite(() => {
      const current = this.requireActiveSurface(surfaceId)
      const currentVersion = this.requireVersion(surfaceId)
      if (
        options.expectedVersion !== undefined &&
        currentVersion.version !== options.expectedVersion
      ) {
        throw new SurfaceVersionConflictError(
          surfaceId,
          options.expectedVersion,
          currentVersion.version,
        )
      }
      const { patch, patched } = this.buildPatchedSurface(
        current,
        surfaceId,
        operations,
        options.updatedBy,
        options.relativeTime,
      )
      if (options.allowAutomationOutcomeState === true) {
        const statuses = AutomationOutcomeStatusesSchema.safeParse(
          patched.state[AUTOMATION_OUTCOMES_STATE_KEY],
        )
        if (!statuses.success) throw new Error('invalid Automation outcome state')
      }
      const nextVersion = currentVersion.version + 1
      const nextTreeVersion = options.updateTreeVersion
        ? currentVersion.treeVersion + 1
        : currentVersion.treeVersion

      const storedContentOrigin = this.surfaceProvenance(surfaceId)?.contentOrigin ?? 'trusted:user'

      const writeOrigin: Origin = options.origin ?? 'trusted:system'

      // `content_origin` accumulates monotonically on every patch. A
      // tree-only special case would miss that an untrusted state patch can
      // carry attacker text into the Surface state a later `agent_path` turn
      // hands to the Agent, since `enqueueAgentAction` reads exactly this
      // column to decide that turn's origin, docs/SECURITY.md §3.2).
      // `effectiveOrigin` keeps the untrusted mark once either the stored
      // content or this write carries one, and never launders back to trusted.
      const nextContentOrigin = effectiveOrigin(
        [storedContentOrigin, writeOrigin],
        storedContentOrigin,
      )

      // The Event log entry's own origin. Every ordinary patch (state or
      // tree) logs its own write origin, as before. A `fast_path` entry is
      // the one exception: it is never hardcoded `trusted:user` — the tap
      // itself is genuinely the user's, but `eventText`
      // interpolates the Surface's own title and state, which may carry an
      // untrusted Surface's content, so the logged origin folds in the
      // Surface's stored `content_origin` instead.
      const eventOrigin =
        options.eventType === 'fast_path'
          ? effectiveOrigin([storedContentOrigin], 'trusted:user')
          : writeOrigin

      // `tree_updated_at` is the stability clock the Template harvest reads
      // (`stableSurfaces`, docs/adr/0012-emergent-templates.md): it moves only
      // on a tree patch, never on a state patch, so `patchState` alone never
      // resets it.
      this.updateSurface(
        patched,
        nextVersion,
        nextTreeVersion,
        options.updateTreeVersion ? patched.freshness.updatedAt : undefined,
        nextContentOrigin,
      )
      const event = this.insertPatchEvent(patched, patch)
      if (options.idempotencyKey) this.rememberIdempotencyKey(options.idempotencyKey, event.cursor)
      if (options.automationOutcomeIdempotencyKey) {
        this.rememberAutomationOutcomeIdempotencyKey(
          options.automationOutcomeIdempotencyKey,
          event.cursor,
        )
      }
      this.stageSpaceEvent(
        patched.spaceId,
        {
          at: patched.freshness.updatedAt,
          type: options.eventType,
          text: options.eventText(patched),
          origin: eventOrigin,
          payload: options.eventPayload ?? { surfaceId, operations: operations.length },
        },
        event.cursor,
      )
      return { surface: patched, event, duplicate: false }
    })
    this.notifySurfaceEvent({ kind: 'patch', event: mutation.event })
    return mutation
  }

  /**
   * Applies `operations` to `current` and re-validates the result against
   * `SurfaceSchema` (bindings, fast actions, ...) via `stampSurface`,
   * without persisting anything. Shared by `patchSurface` (the committed
   * write path, above) and `recordTreeProposal` (the pinned-tree proposal
   * path, below), so an invalid patch is refused identically on both: a
   * proposal is never held for a patch the ordinary path would also have
   * rejected (`issue #22`).
   */
  private buildPatchedSurface(
    current: Surface,
    surfaceId: string,
    operations: PatchOperation[],
    updatedBy: SurfaceWriteActor,
    authoredRelativeTime?: RelativeTimeAuthoring,
  ): { patch: z.infer<typeof PatchSchema>; patched: Surface } {
    const updatedAt = this.nowIso()
    let patch = PatchSchema.parse({
      surfaceId,
      operations: stampPendingPatchOperations(operations, updatedAt),
    })
    const applied = applySurfacePatch(current, patch)
    const tree = stampFastActionRevisions(applied.tree, current.tree)
    if (canonicalJson(tree) !== canonicalJson(applied.tree)) {
      patch = PatchSchema.parse({
        ...patch,
        operations: patch.operations.map((operation) =>
          operation.target === 'tree' && (operation.op === 'add' || operation.op === 'replace')
            ? { ...operation, value: findAtom(tree, operation.value.id) ?? operation.value }
            : operation,
        ),
      })
      const projected = applySurfacePatch(current, patch)
      if (canonicalJson(projected.tree) !== canonicalJson(tree))
        patch = PatchSchema.parse({
          ...patch,
          operations: [
            ...patch.operations,
            { target: 'tree', op: 'replace', path: '', value: tree },
          ],
        })
    }
    const validity = validityAfterStatePatch({
      current: current.validity,
      authored: authoredRelativeTime,
      operations,
      timeZone: this.timeZone,
      now: new Date(updatedAt),
    })
    const patched = this.stampSurface(
      { ...applied, tree, ...(validity === undefined ? {} : { validity }) },
      updatedBy,
      updatedAt,
    )
    return { patch, patched }
  }

  /**
   * Records a `pending` Tree proposal instead of mutating: called by
   * `patchTree` only when the target Surface is pinned and the caller has
   * not passed `bypassPin`. Dry-applies and re-validates the patch first via
   * `buildPatchedSurface` — an invalid proposed patch throws here, at
   * proposal time, before anything is recorded, rather than being held for
   * the human to discover only once accepted (`issue #22`).
   *
   * The recorded `origin` (both the row's own column and the
   * `surface.tree_proposal` Event log entry) folds in the *target's* stored
   * `content_origin` via `effectiveOrigin`, not only the patching caller's
   * own origin. A Surface built from an imported Template is
   * attacker-influenceable even when the patching turn itself is
   * trusted, and the event text below interpolates that Surface's title. The
   * title is delimiter-neutralized and truncated exactly as the pin event's
   * title is (`PIN_EVENT_TITLE_MAX_CHARS`).
   */
  private recordTreeProposal(
    surface: Surface,
    operations: PatchOperation[],
    options: {
      expectedTreeVersion: number
      updatedBy: SurfaceWriteActor
      origin?: Origin
      initiatingTurn?: ChatTurnCorrelation
    },
  ): TreeProposalRecorded {
    this.buildPatchedSurface(surface, surface.id, operations, options.updatedBy)

    const storedContentOrigin = this.surfaceProvenance(surface.id)?.contentOrigin
    const origin = effectiveOrigin(
      [storedContentOrigin, options.origin],
      options.origin ?? 'trusted:system',
    )
    const title = truncate(neutralizeDelimiters(surface.title), PIN_EVENT_TITLE_MAX_CHARS)
    const proposalId = this.runWrite(() => {
      const createdAt = this.nowIso()
      const result = this.db
        .prepare(
          `insert into tree_proposals
             (surface_id, space_id, operations_json, expected_tree_version, origin, status, created_at)
           values (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          surface.id,
          surface.spaceId,
          JSON.stringify(operations),
          options.expectedTreeVersion,
          origin,
          createdAt,
        )
      const id = Number(result.lastInsertRowid)
      this.stageSpaceEvent(surface.spaceId, {
        at: createdAt,
        type: 'surface.tree_proposal',
        text: `Proposed a tree change for Surface "${title}"`,
        origin,
        payload: { surfaceId: surface.id, proposalId: id, operations: operations.length },
      })
      return id
    })

    // Notified after the transaction above has committed — never from
    // inside it — so `TreeProposalSurfaceManager` only ever observes a
    // proposal that a concurrent reader could already see.
    const proposal = this.getTreeProposal(proposalId)
    if (proposal) this.notifyTreeProposal(proposal, options.initiatingTurn)

    return { proposed: true, proposalId, surfaceId: surface.id }
  }

  private findIdempotentMutation(idempotencyKey: string): SurfaceMutation | undefined {
    const row = this.db
      .prepare('select event_cursor from idempotency_keys where key = ?')
      .get(idempotencyKey)
    if (!row) return undefined
    const event = this.eventByCursor(requiredNumber(row, 'event_cursor'))
    const surface = this.getSurface(event.patch.surfaceId)
    if (!surface) throw new Error(`unknown Surface: ${event.patch.surfaceId}`)
    this.assertSpaceReadyForAgent(surface.spaceId)
    return { surface, event, duplicate: true }
  }

  private findAutomationOutcomeIdempotentMutation(
    idempotencyKey: string,
  ): SurfaceMutation | undefined {
    const row = this.db
      .prepare('select event_cursor from automation_outcome_idempotency_keys where key = ?')
      .get(idempotencyKey)
    if (!row) return undefined
    const event = this.eventByCursor(requiredNumber(row, 'event_cursor'))
    const surface = this.getSurface(event.patch.surfaceId)
    if (!surface) throw new Error(`unknown Surface: ${event.patch.surfaceId}`)
    this.assertSpaceReadyForAgent(surface.spaceId)
    return { surface, event, duplicate: true }
  }

  private eventByCursor(cursor: number): SurfacePatchEvent {
    const row = this.db
      .prepare('select event_json from surface_events where cursor = ?')
      .get(cursor)
    if (!row) throw new Error(`unknown Surface event cursor: ${cursor}`)
    return SurfacePatchEventSchema.parse(JSON.parse(requiredString(row, 'event_json')))
  }

  private insertPatchEvent(
    surface: Surface,
    patch: z.infer<typeof PatchSchema>,
    actionOutcome?: CommittedFastActionMetadata,
  ): SurfacePatchEvent {
    const cursor = this.latestSurfaceCursor() + 1
    const event = SurfacePatchEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      patch,
      ...(actionOutcome === undefined ? {} : { actionOutcome }),
      freshness: surface.freshness,
      ...(surface.validity === undefined ? {} : { validity: surface.validity }),
    })
    this.insertEventRow(cursor, event.at, event.spaceId, event.patch.surfaceId, 'patch', event)
    return event
  }

  private insertCreatedEvent(surface: Surface, order: SurfaceOrder): SurfaceCreatedEvent {
    const cursor = order.cursor
    const event = SurfaceCreatedEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      surface,
      order,
    })
    this.insertEventRow(cursor, event.at, event.spaceId, surface.id, 'created', event)
    return event
  }

  private insertArchivedEvent(surface: Surface, order: SurfaceOrder): SurfaceArchivedEvent {
    const cursor = order.cursor
    const event = SurfaceArchivedEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      surfaceId: surface.id,
      order,
    })
    this.insertEventRow(cursor, event.at, event.spaceId, surface.id, 'archived', event)
    return event
  }

  private insertPinnedEvent(
    surface: Surface,
    pinned: boolean,
    order: SurfaceOrder,
  ): SurfacePinnedEvent {
    const cursor = order.cursor
    const event = SurfacePinnedEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      surfaceId: surface.id,
      pinned,
      // The bumped freshness: without it, a client
      // applying this event in place has no way to move its own `updatedAt`/
      // `updatedBy` off whatever it last observed, and would render a pin as
      // current while everything else about the Surface still looks stale.
      freshness: surface.freshness,
      order,
    })
    this.insertEventRow(cursor, event.at, event.spaceId, surface.id, 'pinned', event)
    return event
  }

  private insertMovedEvent(input: SurfaceMovedEvent): SurfaceMovedEvent {
    const event = SurfaceMovedEventSchema.parse(input)
    this.insertEventRow(event.cursor, event.at, event.spaceId, event.surfaceId, 'moved', event)
    return event
  }

  private insertEventRow(
    cursor: number,
    at: string,
    spaceId: string,
    surfaceId: string,
    kind: 'patch' | 'created' | 'archived' | 'pinned' | 'moved' | 'presentation',
    event: unknown,
  ): void {
    this.db
      .prepare(
        `insert into surface_events (cursor, at, space_id, surface_id, kind, event_json)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(cursor, at, spaceId, surfaceId, kind, JSON.stringify(event))
  }

  private notifySurfaceEvent(event: SurfaceEngineEvent): void {
    for (const observer of this.surfaceEventObservers) {
      try {
        observer(event)
      } catch (error) {
        console.error('Surface event observer failed', error)
      }
    }
  }

  /**
   * A throwing observer must never escape `patchTree`: this fires after
   * `recordTreeProposal`'s own transaction has
   * committed, so by the time an observer runs the proposal is already
   * durable — a `TreeProposalSurfaceManager.createCard` failure must not
   * make the `patch_tree` tool report a failure for a proposal that in fact
   * exists, which would invite the Agent to retry and record a duplicate.
   * Mirrors `SpacesEngine.notifyMemoryWrite`'s same per-observer `try`/
   * `catch`, for the same reason.
   */
  private notifyTreeProposal(proposal: TreeProposal, initiatingTurn?: ChatTurnCorrelation): void {
    for (const observer of this.treeProposalObservers) {
      try {
        observer(proposal, initiatingTurn)
      } catch (error) {
        console.error('tree proposal observer failed', error)
      }
    }
  }

  private rememberIdempotencyKey(key: string, eventCursor: number): void {
    this.db
      .prepare('insert into idempotency_keys (key, event_cursor) values (?, ?)')
      .run(key, eventCursor)
  }

  private rememberAutomationOutcomeIdempotencyKey(key: string, eventCursor: number): void {
    this.db
      .prepare('insert into automation_outcome_idempotency_keys (key, event_cursor) values (?, ?)')
      .run(key, eventCursor)
  }

  private surfaceForWrite(
    input: Surface | CreateSurfaceInput,
    updatedBy: SurfaceWriteActor,
    daemonOwned: boolean,
  ): Surface {
    const updatedAt = this.nowIso()
    const relativeTime =
      'relativeTime' in input
        ? (input.relativeTime as RelativeTimeAuthoring | undefined)
        : undefined
    const validity =
      relativeTime === undefined
        ? 'validity' in input
          ? input.validity
          : undefined
        : buildRelativeTimeValidity(relativeTime, this.timeZone, new Date(updatedAt))
    return SurfaceSchema.parse({
      ...input,
      tree: stampFastActionRevisions(stampPendingAtoms(input.tree, updatedAt)),
      freshness: {
        updatedAt,
        updatedBy,
      },
      ...(validity === undefined ? {} : { validity }),
      // A Surface is never born pinned — only `setPinned`, after creation,
      // can pin it. Daemon ownership normally makes it non-pinnable, except
      // inside the canonical System Space where pinning is presentation.
      pinned: false,
      pinnable: isSurfacePinnable(daemonOwned, input.spaceId),
    })
  }

  private stampSurface(
    surface: Surface,
    updatedBy: SurfaceWriteActor,
    updatedAt = this.nowIso(),
  ): Surface {
    return SurfaceSchema.parse({
      ...surface,
      freshness: {
        updatedAt,
        updatedBy,
      },
    })
  }

  private requireActiveSurface(id: string): Surface {
    const surface = this.getSurface(id)
    if (!surface) throw new Error(`unknown Surface: ${id}`)
    return surface
  }

  /** Refuses Agent writes to daemon-owned or canonical System Surfaces. */
  private assertWritableByAgent(surfaceId: string, updatedBy: SurfaceWriteActor): void {
    if (updatedBy !== 'agent') return
    const row = this.db
      .prepare('select daemon_owned, space_id from surfaces where id = ?')
      .get(surfaceId)
    if (row === undefined) return
    if (requiredNumber(row, 'daemon_owned') === 1) throw new SurfaceOwnershipError(surfaceId)
    if (requiredString(row, 'space_id') === SYSTEM_SPACE_ID) {
      throw new SurfaceOwnershipError(surfaceId, 'system')
    }
  }

  private assertSpaceWritableByAgent(
    spaceId: string,
    surfaceId: string,
    updatedBy: SurfaceWriteActor,
  ): void {
    if (updatedBy === 'agent' && spaceId === SYSTEM_SPACE_ID) {
      throw new SurfaceOwnershipError(surfaceId, 'system')
    }
  }

  /**
   * Public lookup: callers that must not treat an
   * impostor Surface as daemon-owned — e.g. `ApprovalSurfaceManager.start()`
   * verifying a Surface it is about to adopt at a deterministic id — need
   * this alongside `assertWritableByAgent`'s internal check. Returns `false`
   * for an unknown surfaceId (nothing to adopt either way).
   */
  isDaemonOwned(surfaceId: string): boolean {
    const row = this.db.prepare('select daemon_owned from surfaces where id = ?').get(surfaceId)
    return row !== undefined && requiredNumber(row, 'daemon_owned') === 1
  }

  /**
   * Adopts a deterministic projection created by an older release. Archived
   * rows are restored, non-System pins are cleared, and authorable content is
   * replaced by the caller's canonical projection in one replayable event.
   */
  adoptCanonicalDaemonSurface(input: Surface, origin: Origin): Surface {
    const row = this.db.prepare('select * from surfaces where id = ?').get(input.id)
    if (!row) {
      return this.createSurface(input, 'job', { daemonOwned: true, origin })
    }
    const existing = surfaceFromRow(row)
    if (existing.spaceId !== input.spaceId) {
      throw new Error(`canonical Surface identity belongs to another Space: ${input.id}`)
    }
    const archived = requiredNumber(row, 'archived') === 1
    if (!archived && requiredNumber(row, 'daemon_owned') === 1) return existing

    const outcomeStatuses = AutomationOutcomeStatusesSchema.safeParse(
      existing.state[AUTOMATION_OUTCOMES_STATE_KEY],
    )
    const pinned = input.spaceId === SYSTEM_SPACE_ID && existing.pinned
    const at = this.nowIso()
    const adopted = SurfaceSchema.parse({
      ...input,
      tree: stampFastActionRevisions(input.tree, existing.tree),
      state: {
        ...input.state,
        ...(outcomeStatuses.success
          ? { [AUTOMATION_OUTCOMES_STATE_KEY]: outcomeStatuses.data }
          : {}),
      },
      pinned,
      pinnable: isSurfacePinnable(true, input.spaceId),
      freshness: { updatedAt: at, updatedBy: 'job' },
    })
    const event = this.runWrite(() => {
      const currentOrder = this.readSurfaceOrder(input.spaceId)
      const version = requiredNumber(row, 'version') + 1
      const treeVersion = requiredNumber(row, 'tree_version') + 1
      this.db
        .prepare(
          `update surfaces
           set title = ?, tree_json = ?, state_json = ?, version = ?, tree_version = ?,
               updated_at = ?, updated_by = 'job', archived = 0, daemon_owned = 1, pinned = ?,
               tree_updated_at = ?, content_origin = ?, validity_json = ?
           where id = ?`,
        )
        .run(
          adopted.title,
          JSON.stringify(adopted.tree),
          JSON.stringify(adopted.state),
          version,
          treeVersion,
          at,
          pinned ? 1 : 0,
          at,
          origin,
          adopted.validity === undefined ? null : JSON.stringify(adopted.validity),
          adopted.id,
        )
      const withoutCanonical = {
        pinned: currentOrder.pinnedSurfaceIds.filter((id) => id !== adopted.id),
        regular: currentOrder.regularSurfaceIds.filter((id) => id !== adopted.id),
      }
      const wasRegular = currentOrder.regularSurfaceIds.includes(adopted.id)
      const wasPinned = currentOrder.pinnedSurfaceIds.includes(adopted.id)
      const pinnedSurfaceIds = pinned
        ? wasPinned
          ? currentOrder.pinnedSurfaceIds
          : [adopted.id, ...withoutCanonical.pinned]
        : withoutCanonical.pinned
      const regularSurfaceIds = pinned
        ? withoutCanonical.regular
        : wasRegular
          ? currentOrder.regularSurfaceIds
          : [adopted.id, ...withoutCanonical.regular]
      const order = this.writeSurfaceOrder(
        adopted.spaceId,
        pinnedSurfaceIds,
        regularSurfaceIds,
        this.latestSurfaceCursor() + 1,
      )
      this.stageSpaceEvent(
        adopted.spaceId,
        {
          at,
          type: 'surface.adopt',
          text: `Adopted canonical daemon Surface "${adopted.title}"`,
          origin,
          payload: {
            surfaceId: adopted.id,
            restored: archived,
            unpinned: existing.pinned && !pinned,
          },
        },
        this.latestSurfaceCursor() + 1,
      )
      return this.insertCreatedEvent(adopted, order)
    })
    this.notifySurfaceEvent({ kind: 'created', event })
    return adopted
  }

  /**
   * Refuses daemon-owned Surfaces outside the canonical System Space before
   * any transaction opens. The unknown-Surface case is checked inside the
   * write transaction (`setPinned`), where the row is fetched anyway.
   */
  private assertPinnable(surfaceId: string): void {
    const row = this.db
      .prepare('select daemon_owned, space_id from surfaces where id = ?')
      .get(surfaceId)
    if (
      row !== undefined &&
      !isSurfacePinnable(requiredNumber(row, 'daemon_owned') === 1, requiredString(row, 'space_id'))
    ) {
      throw new SurfaceNotPinnableError(surfaceId)
    }
  }

  private requireVersion(id: string): SurfaceVersion {
    const version = this.getSurfaceVersion(id)
    if (!version) throw new Error(`unknown Surface: ${id}`)
    return version
  }

  private requireKnownSpace(spaceId: string): void {
    if (!this.hasSpace(spaceId)) throw new Error(`unknown Space: ${spaceId}`)
  }

  private insertSurface(
    surface: Surface,
    options: {
      version: number
      treeVersion: number
      archived: boolean
      daemonOwned?: boolean
      treeUpdatedAt: string
      templateId?: string
      templateSpaceId?: string
      contentOrigin?: Origin
    },
  ): void {
    const daemonOwned = options.daemonOwned ?? false
    const contentOrigin = options.contentOrigin ?? 'trusted:user'
    const { version, treeVersion, archived } = options
    this.db
      .prepare(
        `insert into surfaces
           (id, space_id, title, tree_json, state_json, version, tree_version,
            updated_at, updated_by, archived, daemon_owned, pinned, tree_updated_at,
            template_id, template_space_id, content_origin, validity_json, presentation)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        surface.id,
        surface.spaceId,
        surface.title,
        JSON.stringify(surface.tree),
        JSON.stringify(surface.state),
        version,
        treeVersion,
        surface.freshness.updatedAt,
        surface.freshness.updatedBy,
        archived ? 1 : 0,
        daemonOwned ? 1 : 0,
        // A Surface is never born pinned: `pinned` is always inserted as 0
        // here, independent of whatever `surface.pinned` (already forced to
        // `false` by `surfaceForWrite`) happens to carry.
        0,
        options.treeUpdatedAt,
        options.templateId ?? null,
        options.templateSpaceId ?? null,
        contentOrigin,
        surface.validity === undefined ? null : JSON.stringify(surface.validity),
        surface.presentation,
      )
  }

  /**
   * `treeUpdatedAt` is `undefined` for a state-only patch: that column then
   * keeps its stored value in SQL (`coalesce`), rather than being read back
   * first. `contentOrigin` is supplied by `patchSurface` on every patch,
   * including state-only patches, so untrusted content can move through the
   * trust lattice. `coalesce` keeps the helper safe for callers that omit it.
   * The fast path runs this on every tap, so it stays one statement.
   */
  private updateSurface(
    surface: Surface,
    version: number,
    treeVersion: number,
    treeUpdatedAt?: string,
    contentOrigin?: Origin,
  ): void {
    this.db
      .prepare(
        `update surfaces
         set title = ?, tree_json = ?, state_json = ?, version = ?, tree_version = ?,
             updated_at = ?, updated_by = ?, tree_updated_at = coalesce(?, tree_updated_at),
             content_origin = coalesce(?, content_origin), validity_json = ?
         where id = ? and archived = 0`,
      )
      .run(
        surface.title,
        JSON.stringify(surface.tree),
        JSON.stringify(surface.state),
        version,
        treeVersion,
        surface.freshness.updatedAt,
        surface.freshness.updatedBy,
        treeUpdatedAt ?? null,
        contentOrigin ?? null,
        surface.validity === undefined ? null : JSON.stringify(surface.validity),
        surface.id,
      )
  }

  private surfaceCount(): number {
    const row = this.db.prepare('select count(*) as count from surfaces').get()
    return row ? requiredNumber(row, 'count') : 0
  }

  private initializeSurfaceOrders(): void {
    const spaceIds = this.db
      .prepare('select distinct space_id from surfaces')
      .all()
      .map((row) => requiredString(row, 'space_id'))
    if (spaceIds.length === 0) return
    this.runWrite(() => {
      for (const spaceId of spaceIds) this.ensureSurfaceOrder(spaceId)
    })
  }

  private ensureSurfaceOrder(spaceId: string): SurfaceOrder {
    const state = this.db
      .prepare('select cursor from surface_order_state where space_id = ?')
      .get(spaceId)
    if (state) return this.readSurfaceOrder(spaceId)

    const surfaces = this.db
      .prepare('select id, pinned from surfaces where space_id = ? and archived = 0')
      .all(spaceId)
      .map((row) => ({
        id: requiredString(row, 'id'),
        pinned: requiredNumber(row, 'pinned') === 1,
      }))
    const pinnedRanks = new Map<string, number>()
    const regularRanks = new Map<string, number>()
    for (const row of this.db
      .prepare(
        `select cursor, surface_id, kind, event_json from surface_events
         where space_id = ? and kind in ('created', 'pinned')
         order by cursor desc`,
      )
      .all(spaceId)) {
      const cursor = requiredNumber(row, 'cursor')
      const surfaceId = requiredString(row, 'surface_id')
      const kind = requiredString(row, 'kind')
      if (kind === 'created' && !regularRanks.has(surfaceId)) {
        regularRanks.set(surfaceId, cursor)
        continue
      }
      if (kind !== 'pinned') continue
      const json = JSON.parse(requiredString(row, 'event_json')) as { pinned?: unknown }
      if (json.pinned === true && !pinnedRanks.has(surfaceId)) pinnedRanks.set(surfaceId, cursor)
      if (json.pinned === false && !regularRanks.has(surfaceId)) regularRanks.set(surfaceId, cursor)
    }

    const pinnedSurfaceIds = surfaces
      .filter((surface) => surface.pinned)
      .map((surface) => surface.id)
      .sort((left, right) => compareBackfillRank(left, right, pinnedRanks))
    const regularSurfaceIds = surfaces
      .filter((surface) => !surface.pinned)
      .map((surface) => surface.id)
      .sort((left, right) => compareBackfillRank(left, right, regularRanks))
    return this.writeSurfaceOrder(
      spaceId,
      pinnedSurfaceIds,
      regularSurfaceIds,
      this.latestSurfaceCursor(),
    )
  }

  private readSurfaceOrder(spaceId: string): SurfaceOrder {
    const state = this.db
      .prepare('select cursor from surface_order_state where space_id = ?')
      .get(spaceId)
    const cursor = state ? requiredNumber(state, 'cursor') : this.latestSurfaceCursor()
    const rows = this.db
      .prepare(
        `select surface_id, group_name from surface_order_items
         where space_id = ? order by group_name, position`,
      )
      .all(spaceId)
    return SurfaceOrderSchema.parse({
      cursor,
      spaceId,
      pinnedSurfaceIds: rows
        .filter((row) => requiredString(row, 'group_name') === 'pinned')
        .map((row) => requiredString(row, 'surface_id')),
      regularSurfaceIds: rows
        .filter((row) => requiredString(row, 'group_name') === 'regular')
        .map((row) => requiredString(row, 'surface_id')),
    })
  }

  private writeSurfaceOrder(
    spaceId: string,
    pinnedSurfaceIds: string[],
    regularSurfaceIds: string[],
    cursor: number,
  ): SurfaceOrder {
    const order = SurfaceOrderSchema.parse({
      cursor,
      spaceId,
      pinnedSurfaceIds,
      regularSurfaceIds,
    })
    this.assertCompleteSurfaceOrder(order)
    this.db.prepare('delete from surface_order_items where space_id = ?').run(spaceId)
    const insert = this.db.prepare(
      `insert into surface_order_items (surface_id, space_id, group_name, position)
       values (?, ?, ?, ?)`,
    )
    order.pinnedSurfaceIds.forEach((surfaceId, position) => {
      insert.run(surfaceId, spaceId, 'pinned', position)
    })
    order.regularSurfaceIds.forEach((surfaceId, position) => {
      insert.run(surfaceId, spaceId, 'regular', position)
    })
    this.db
      .prepare(
        `insert into surface_order_state (space_id, cursor) values (?, ?)
         on conflict(space_id) do update set cursor = excluded.cursor`,
      )
      .run(spaceId, cursor)
    return order
  }

  private assertCompleteSurfaceOrder(order: SurfaceOrder): void {
    const active = this.db
      .prepare('select id, pinned from surfaces where space_id = ? and archived = 0')
      .all(order.spaceId)
    const expected = new Map(
      active.map((row) => [requiredString(row, 'id'), requiredNumber(row, 'pinned') === 1]),
    )
    const ordered = new Map<string, boolean>()
    order.pinnedSurfaceIds.forEach((id) => ordered.set(id, true))
    order.regularSurfaceIds.forEach((id) => ordered.set(id, false))
    if (expected.size !== ordered.size) {
      throw new Error(`incomplete authoritative Surface order for Space ${order.spaceId}`)
    }
    for (const [surfaceId, pinned] of expected) {
      if (ordered.get(surfaceId) !== pinned) {
        throw new Error(`invalid authoritative Surface group for ${surfaceId}`)
      }
    }
  }

  private seed(surfaces: Surface[]): void {
    if (surfaces.length === 0) return
    this.runWrite(() => {
      for (const surface of surfaces) {
        const parsed = SurfaceSchema.parse({
          ...surface,
          tree: stampFastActionRevisions(surface.tree),
        })
        this.requireKnownSpace(parsed.spaceId)
        this.insertSurface(parsed, {
          version: 1,
          treeVersion: 1,
          archived: false,
          treeUpdatedAt: parsed.freshness.updatedAt,
        })
      }
    })
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private stageSpaceEvent(
    spaceId: string,
    input: AppendSpaceEventInput,
    surfaceEventCursor?: number,
  ): SurfaceCommitRecord {
    if (!this.stagedSurfaceCommits || !this.surfaceCommitJournal) {
      throw new Error('Surface commit transport is unavailable')
    }
    const commit = this.surfaceCommitJournal.prepare(spaceId, input, surfaceEventCursor)
    this.stagedSurfaceCommits.push(commit)
    return commit
  }

  private runWrite<T>(write: () => T): T {
    if (this.stagedSurfaceCommits) throw new Error('nested Surface commit transaction')
    const staged: SurfaceCommitRecord[] = []
    this.stagedSurfaceCommits = staged
    let result: T
    try {
      result = withImmediateTransaction(this.db, write)
    } finally {
      this.stagedSurfaceCommits = undefined
    }
    for (const spaceId of new Set(staged.map((record) => record.spaceId))) {
      this.surfaceCommitJournal!.reconcileSpace(spaceId)
    }
    return result
  }
}

function assertPatchTarget(operations: PatchOperation[], target: 'state' | 'tree'): void {
  const wrongTarget = operations.find((operation) => operation.target !== target)
  if (wrongTarget) {
    throw new Error(`${target} patch cannot include ${wrongTarget.target} operation`)
  }
}

function agentTurnRowId(id: string): number | undefined {
  const match = /^agent-turn-([1-9]\d*)$/.exec(id)
  if (!match) return undefined
  const rowId = Number(match[1])
  return Number.isSafeInteger(rowId) ? rowId : undefined
}

function agentActionRequest(surfaceId: string, invocation: AgentActionInvocation): string {
  return canonicalJson({
    surfaceId,
    nodeId: invocation.nodeId,
    name: invocation.name,
    ...(invocation.payload === undefined ? {} : { payload: invocation.payload }),
  })
}

function assertAutomationOutcomeStateNotPatched(operations: PatchOperation[]): void {
  const reservedPath = `/${AUTOMATION_OUTCOMES_STATE_KEY}`
  if (
    operations.some(
      (operation) =>
        operation.target === 'state' &&
        (operation.path === reservedPath || operation.path.startsWith(`${reservedPath}/`)),
    )
  ) {
    throw new Error('Automation outcome state is owned by the Gateway')
  }
}

function stampPendingPatchOperations(
  operations: PatchOperation[],
  startedAt: string,
): PatchOperation[] {
  return operations.map((operation) =>
    operation.target === 'tree' && (operation.op === 'add' || operation.op === 'replace')
      ? { ...operation, value: stampPendingAtoms(operation.value, startedAt) }
      : operation,
  )
}

function stampPendingAtoms(node: AtomNode, startedAt: string): AtomNode {
  if (node.type === 'Pending') {
    return { ...node, props: { ...node.props, startedAt } }
  }
  if (node.children === undefined) return node
  return { ...node, children: node.children.map((child) => stampPendingAtoms(child, startedAt)) }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function contentOriginFromRow(row: Record<string, unknown>): Origin {
  const storedOrigin = requiredString(row, 'content_origin')
  return isValidOrigin(storedOrigin) ? storedOrigin : 'trusted:user'
}

function relativeTimeSummary(
  surface: Surface,
  now: Date,
): { relativeTime: SurfaceRelativeTimeStatus } | Record<string, never> {
  const relativeTime = surfaceRelativeTimeStatus(surface, now)
  return relativeTime === undefined ? {} : { relativeTime }
}

function compareBackfillRank(
  left: string,
  right: string,
  ranks: ReadonlyMap<string, number>,
): number {
  const leftRank = ranks.get(left)
  const rightRank = ranks.get(right)
  if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
    return rightRank - leftRank
  }
  if (leftRank !== undefined && rightRank === undefined) return -1
  if (leftRank === undefined && rightRank !== undefined) return 1
  return left < right ? -1 : left > right ? 1 : 0
}
