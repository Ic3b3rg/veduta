import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AtomNodeSchema,
  JsonObjectSchema,
  PatchOperationSchema,
  PatchSchema,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfaceMovedEventSchema,
  SurfacePatchEventSchema,
  SurfacePinnedEventSchema,
  SurfaceOrderSchema,
  SurfaceSchema,
  applySurfacePatch,
  findAtom,
  findDeclaredAgentAction,
  surfaceRelativeTimeStatus,
  type ActionInvocation,
  type AtomNode,
  type ChatTurnCorrelation,
  type Freshness,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Surface,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfaceMovedEvent,
  type SurfaceMoveDirection,
  type SurfacePatchEvent,
  type SurfacePinnedEvent,
  type SurfaceOrder,
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
  effectiveToolWriteOrigin,
  effectiveOrigin,
  isValidOrigin,
  neutralizeDelimiters,
  type Origin,
} from './taint.ts'

export { surfaceEngineEventFromRow }

type SurfaceWriteActor = Extract<Freshness['updatedBy'], 'agent' | 'user' | 'job'>

/**
 * Cap on the Surface title rendered into `setPinned`'s `surface.pin` Event
 * log text. A title can carry attacker-influenced Template content, and this
 * Event text has no other size bound.
 */
const PIN_EVENT_TITLE_MAX_CHARS = 200

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

type CommittedSurfacePinMutation =
  | { surface: Surface; changed: false; order: SurfaceOrder }
  | { surface: Surface; changed: true; order: SurfaceOrder; event: SurfacePinnedEvent }

/**
 * `patchTree`'s result when the target Surface is pinned and the caller did
 * not pass `bypassPin`: nothing was mutated, a `pending` row was recorded
 * instead (`issues/022-emergent-templates.md`). Discriminate a `patchTree`
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

export interface QueuedAgentTurn {
  id: string
  at: string
  spaceId: string
  surfaceId: string
  atomId: string
  actionName: string
  payload: JsonObject
  surface: Surface
  atom: AtomNode
}

export interface SurfaceEngineOptions {
  rootDir: string
  now: () => Date
  timeZone?: string
  seed?: Surface[]
  hasSpace: (spaceId: string) => boolean
  appendSpaceEvent: (spaceId: string, input: AppendSpaceEventInput) => unknown
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

/**
 * Raised by `patchState`/`patchTree`/`archiveSurface` when `updatedBy:
 * 'agent'` targets a daemon-owned Surface (approval cards, the trust admin
 * Surfaces — ADR-0007's structural-defense contract): a tainted-but-L0 turn
 * must never be able to rewrite a pending approval card's `field.*` content
 * or pre-set its `decision.*` state after the human has read it. Enforced
 * here in the engine — the one write path for Surface state and tree
 * changes — so no tool-level wrapper can bypass it. `updatedBy: 'user'`
 * (fast-path clicks) and `updatedBy: 'job'` (the owning manager's own
 * writes) are never subject to this check.
 */
export class SurfaceOwnershipError extends Error {
  constructor(readonly surfaceId: string) {
    super(`Surface ${surfaceId} is daemon-owned and cannot be written by the Agent`)
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
  private readonly appendSpaceEvent: (spaceId: string, input: AppendSpaceEventInput) => unknown
  private readonly surfaceEventObservers = new Set<(event: SurfaceEngineEvent) => void>()
  private readonly treeProposalObservers = new Set<(proposal: TreeProposal) => void>()

  constructor(options: SurfaceEngineOptions) {
    mkdirSync(options.rootDir, { recursive: true })
    this.db = new DatabaseSync(join(options.rootDir, 'surfaces.sqlite'))
    this.now = options.now
    this.timeZone = options.timeZone ?? 'UTC'
    this.hasSpace = options.hasSpace
    this.appendSpaceEvent = options.appendSpaceEvent
    initializeSurfaceSchema(this.db)
    if (this.surfaceCount() === 0) this.seed(options.seed ?? [])
    this.initializeSurfaceOrders()
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
      .prepare('select kind, event_json from surface_events where cursor > ? order by cursor')
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
   * `issues/022-emergent-templates.md`). This is how
   * `TreeProposalSurfaceManager` learns a proposal was recorded and builds
   * its preview Surface — the same shape as `onSurfaceEvent`, kept separate
   * because a Tree proposal is not itself a `SurfaceEngineEvent`.
   */
  onTreeProposal(observer: (proposal: TreeProposal) => void): () => void {
    this.treeProposalObservers.add(observer)
    return () => this.treeProposalObservers.delete(observer)
  }

  close(): void {
    this.db.close()
  }

  createSurface(
    input: Surface | CreateSurfaceInput,
    updatedBy: SurfaceWriteActor,
    options?: CreateSurfaceOptions,
  ): Surface {
    const daemonOwned = options?.daemonOwned ?? false
    const surface = this.surfaceForWrite(input, updatedBy, daemonOwned)
    this.requireKnownSpace(surface.spaceId)
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
      this.appendSpaceEvent(surface.spaceId, {
        at: surface.freshness.updatedAt,
        type: 'surface.create',
        text: `Created Surface "${surface.title}"`,
        origin: options?.origin ?? 'trusted:system',
        payload: { surfaceId: surface.id },
      })
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
   * Locks or unlocks a Surface's tree (`issues/022-emergent-templates.md`),
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
      this.appendSpaceEvent(stamped.spaceId, {
        at: stamped.freshness.updatedAt,
        type: 'surface.pin',
        text: `${pinned ? 'Pinned' : 'Unpinned'} Surface "${title}"`,
        origin: eventOrigin,
        payload: { surfaceId, pinned },
      })
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
      this.appendSpaceEvent(spaceId, {
        at,
        type: 'surface.move',
        text: `Moved Surface "${title}" ${direction}`,
        origin: isValidOrigin(storedContentOrigin)
          ? effectiveOrigin([storedContentOrigin, 'trusted:user'], 'trusted:user')
          : 'trusted:user',
        payload: { surfaceId, direction },
      })
      const event = this.insertMovedEvent({ cursor, at, spaceId, surfaceId, direction, order })
      return { order, event }
    })
    this.notifySurfaceEvent({ kind: 'moved', event: result.event })
    return result.order
  }

  /**
   * Active, non-daemon-owned Surfaces whose tree has not changed since
   * `beforeIso`: the stability query the Template harvest
   * (`issues/022-emergent-templates.md`) uses to decide which Surfaces are
   * candidates for a Template. This method only answers "what is stable" —
   * it does not decide whether to harvest, which stays the caller's policy.
   */
  stableSurfaces(beforeIso: string): Surface[] {
    return this.db
      .prepare(
        `select * from surfaces
         where archived = 0 and daemon_owned = 0 and tree_updated_at <= ?
         order by id`,
      )
      .all(beforeIso)
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
   * (`issues/022-emergent-templates.md`). Returns `undefined` when `id` is
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
      this.appendSpaceEvent(surface.spaceId, {
        at: archived.freshness.updatedAt,
        type: 'surface.archive',
        text: `Archived Surface "${surface.title}"`,
        origin: origin ?? 'trusted:system',
        payload: { surfaceId },
      })
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
    },
  ): SurfaceMutation {
    assertPatchTarget(operations, 'state')
    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_state',
      eventText: (surface) => `Patched state for Surface "${surface.title}"`,
      updateTreeVersion: false,
      ...(options.relativeTime === undefined ? {} : { relativeTime: options.relativeTime }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  /**
   * Patches a Surface's Atom tree — unless the target is pinned, in which
   * case the patch is dry-applied and re-validated (`buildPatchedSurface`,
   * the same validation `patchSurface` performs on the committed path) and
   * recorded as a `pending` Tree proposal instead of mutating
   * (`issues/022-emergent-templates.md`): the pin is a capability on the
   * Surface, not a property of `updatedBy`, so it applies identically to
   * `'agent'`, `'user'`, and `'job'` writes. `bypassPin: true` is the one
   * documented escape hatch (`tree-proposal.ts`'s
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

    if (options.bypassPin !== true) {
      const current = this.requireActiveSurface(surfaceId)
      if (current.pinned) {
        return this.recordTreeProposal(current, operations, {
          expectedTreeVersion: options.expectedTreeVersion,
          updatedBy: options.updatedBy,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        })
      }
    }

    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_tree',
      eventText: (surface) => `Patched tree for Surface "${surface.title}"`,
      updateTreeVersion: true,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  applyFastAction(
    surfaceId: string,
    stateKey: string,
    value: JsonValue,
    idempotencyKey?: string,
  ): SurfaceMutation {
    const duplicate = idempotencyKey ? this.findIdempotentMutation(idempotencyKey) : undefined
    if (duplicate) return duplicate

    const surface = this.requireActiveSurface(surfaceId)
    const operation = {
      target: 'state' as const,
      op: Object.prototype.hasOwnProperty.call(surface.state, stateKey)
        ? ('replace' as const)
        : ('add' as const),
      path: statePath(stateKey),
      value,
    }
    const mutation = this.patchSurface(surfaceId, [operation], {
      updatedBy: 'user',
      eventType: 'fast_path',
      eventText: (patched) => `${patched.title}: ${stateKey} -> ${JSON.stringify(value)}`,
      updateTreeVersion: false,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      eventPayload: { surfaceId, stateKey, value },
    })
    return mutation
  }

  enqueueAgentAction(surface: Surface, invocation: ActionInvocation): QueuedAgentTurn {
    const atom = findAtom(surface.tree, invocation.nodeId)
    const action = findDeclaredAgentAction(surface.tree, invocation.nodeId, invocation.name)
    if (!atom || !action) {
      throw new Error(
        `action "${invocation.name}" is not declared as agent by node "${invocation.nodeId}"`,
      )
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
    const contentOrigin = this.surfaceProvenance(surface.id)?.contentOrigin
    const id = this.runWrite(() => {
      const result = this.db
        .prepare(
          `insert into agent_turns
             (at, space_id, surface_id, atom_id, action_name, payload_json, surface_json, atom_json)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        )
      this.appendSpaceEvent(surface.spaceId, {
        at,
        type: 'agent_path',
        text: `${surface.title}: ${invocation.name} requested from Atom "${atom.id}"`,
        origin: effectiveOrigin([contentOrigin], 'trusted:user'),
        payload: { surfaceId: surface.id, atomId: atom.id, actionName: invocation.name, payload },
      })
      return Number(result.lastInsertRowid)
    })

    return {
      id: `agent-turn-${id}`,
      at,
      spaceId: surface.spaceId,
      surfaceId: surface.id,
      atomId: atom.id,
      actionName: invocation.name,
      payload,
      surface,
      atom,
    }
  }

  agentTurns(): QueuedAgentTurn[] {
    return this.db.prepare('select * from agent_turns order by id').all().map(agentTurnFromRow)
  }

  surfaceTools(): ToolDef[] {
    return [
      defineTool({
        name: 'create_surface',
        description:
          'Create a protocol-valid Surface inside a Space. For progressive composition, include ' +
          "typed Pending leaves in the complete initial layout; the new Surface's tree version " +
          'starts at 1. For today/this-week/this-month projections, declare relativeTime with a ' +
          'separate durable source state key and every projected state key.',
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
          })
          // A pinned Surface is not an error: the Agent must be told plainly
          // that the tree change is a proposal awaiting the user, not retry
          // or report a failure (issues/022-emergent-templates.md).
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
      eventPayload?: JsonObject
      origin?: Origin
      relativeTime?: RelativeTimeAuthoring
    },
  ): SurfaceMutation {
    this.assertWritableByAgent(surfaceId, options.updatedBy)
    const mutation = this.runWrite(() => {
      const current = this.requireActiveSurface(surfaceId)
      const { patch, patched } = this.buildPatchedSurface(
        current,
        surfaceId,
        operations,
        options.updatedBy,
        options.relativeTime,
      )
      const currentVersion = this.requireVersion(surfaceId)
      const nextVersion = currentVersion.version + 1
      const nextTreeVersion = options.updateTreeVersion
        ? currentVersion.treeVersion + 1
        : currentVersion.treeVersion

      const storedContentOrigin = this.surfaceProvenance(surfaceId)?.contentOrigin ?? 'trusted:user'

      // This write's own origin. A `fast_path` tap is always genuinely the
      // user's own action — no attacker-influenced turn authored *this*
      // write, `applyFastAction` never takes an `origin` option at all — so
      // it is never anything but `trusted:user` here, regardless of what the
      // Surface's own stored content carries (see `eventOrigin` below for
      // where that distinction actually matters).
      const writeOrigin: Origin =
        options.eventType === 'fast_path' ? 'trusted:user' : (options.origin ?? 'trusted:system')

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
      this.appendSpaceEvent(patched.spaceId, {
        at: patched.freshness.updatedAt,
        type: options.eventType,
        text: options.eventText(patched),
        origin: eventOrigin,
        payload: options.eventPayload ?? { surfaceId, operations: operations.length },
      })
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
   * rejected (`issues/022-emergent-templates.md`).
   */
  private buildPatchedSurface(
    current: Surface,
    surfaceId: string,
    operations: PatchOperation[],
    updatedBy: SurfaceWriteActor,
    authoredRelativeTime?: RelativeTimeAuthoring,
  ): { patch: z.infer<typeof PatchSchema>; patched: Surface } {
    const updatedAt = this.nowIso()
    const patch = PatchSchema.parse({
      surfaceId,
      operations: stampPendingPatchOperations(operations, updatedAt),
    })
    const applied = applySurfacePatch(current, patch)
    const validity = validityAfterStatePatch({
      current: current.validity,
      authored: authoredRelativeTime,
      operations,
      timeZone: this.timeZone,
      now: new Date(updatedAt),
    })
    const patched = this.stampSurface(
      { ...applied, ...(validity === undefined ? {} : { validity }) },
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
   * the human to discover only once accepted (`issues/022-emergent-templates.md`).
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
    options: { expectedTreeVersion: number; updatedBy: SurfaceWriteActor; origin?: Origin },
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
      this.appendSpaceEvent(surface.spaceId, {
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
    if (proposal) this.notifyTreeProposal(proposal)

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
  ): SurfacePatchEvent {
    const cursor = this.latestSurfaceCursor() + 1
    const event = SurfacePatchEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      patch,
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
    kind: 'patch' | 'created' | 'archived' | 'pinned' | 'moved',
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
    for (const observer of this.surfaceEventObservers) observer(event)
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
  private notifyTreeProposal(proposal: TreeProposal): void {
    for (const observer of this.treeProposalObservers) {
      try {
        observer(proposal)
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
      tree: stampPendingAtoms(input.tree, updatedAt),
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

  /**
   * The write-protection check backing `SurfaceOwnershipError`: only
   * `updatedBy: 'agent'` is ever refused, and only against a Surface
   * stamped `daemonOwned` at creation. Checked before any transaction
   * opens, so a refused write has no side effects at all.
   */
  private assertWritableByAgent(surfaceId: string, updatedBy: SurfaceWriteActor): void {
    if (updatedBy !== 'agent') return
    if (this.isDaemonOwned(surfaceId)) throw new SurfaceOwnershipError(surfaceId)
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
            template_id, template_space_id, content_origin, validity_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const parsed = SurfaceSchema.parse(surface)
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

  private runWrite<T>(write: () => T): T {
    return withImmediateTransaction(this.db, write)
  }
}

function assertPatchTarget(operations: PatchOperation[], target: 'state' | 'tree'): void {
  const wrongTarget = operations.find((operation) => operation.target !== target)
  if (wrongTarget) {
    throw new Error(`${target} patch cannot include ${wrongTarget.target} operation`)
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

function statePath(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
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
