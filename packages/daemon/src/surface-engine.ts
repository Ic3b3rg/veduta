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
  SurfacePatchEventSchema,
  SurfaceSchema,
  applySurfacePatch,
  findAtom,
  findDeclaredAgentAction,
  type ActionInvocation,
  type AtomNode,
  type Freshness,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Surface,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfacePatchEvent,
} from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { AppendSpaceEventInput } from './spaces-engine.ts'
import { requiredNumber, requiredString, withImmediateTransaction } from './sqlite-rows.ts'
import { toolWriteOrigin, type Origin } from './taint.ts'

type SurfaceWriteActor = Extract<Freshness['updatedBy'], 'agent' | 'user' | 'job'>

export interface SurfaceMutation {
  surface: Surface
  event: SurfacePatchEvent
  duplicate: boolean
}

export interface SurfaceVersion {
  version: number
  treeVersion: number
}

/**
 * One committed Surface-lifecycle event, as replayed or observed: `kind`
 * selects which protocol schema validated `event`, so callers get a typed
 * union instead of re-discriminating on shape.
 */
export type SurfaceEngineEvent =
  | { kind: 'patch'; event: SurfacePatchEvent }
  | { kind: 'created'; event: SurfaceCreatedEvent }
  | { kind: 'archived'; event: SurfaceArchivedEvent }

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

const CreateSurfaceToolInputSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  tree: AtomNodeSchema,
  state: JsonObjectSchema,
})

const PatchStateToolInputSchema = z.object({
  surfaceId: z.string().min(1),
  operations: z.array(PatchOperationSchema).min(1),
})

const PatchTreeToolInputSchema = PatchStateToolInputSchema.extend({
  expectedTreeVersion: z.number().int().nonnegative(),
})

const ArchiveSurfaceToolInputSchema = z.object({
  surfaceId: z.string().min(1),
})

type CreateSurfaceInput = z.infer<typeof CreateSurfaceToolInputSchema>

export interface CreateSurfaceOptions {
  origin?: Origin
  /**
   * Marks the created Surface as owned by the daemon itself (approval
   * cards, trust admin Surfaces), not by the Agent: `patchState`/
   * `patchTree`/`archiveSurface` then refuse `updatedBy: 'agent'` writes
   * against it (see `SurfaceOwnershipError`). Defaults to `false` — an
   * ordinary Agent-created Surface (the `create_surface` tool) stays fully
   * writable by the Agent, as before.
   */
  daemonOwned?: boolean
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
  private readonly hasSpace: (spaceId: string) => boolean
  private readonly appendSpaceEvent: (spaceId: string, input: AppendSpaceEventInput) => unknown
  private readonly surfaceEventObservers = new Set<(event: SurfaceEngineEvent) => void>()

  constructor(options: SurfaceEngineOptions) {
    mkdirSync(options.rootDir, { recursive: true })
    this.db = new DatabaseSync(join(options.rootDir, 'surfaces.sqlite'))
    this.now = options.now
    this.hasSpace = options.hasSpace
    this.appendSpaceEvent = options.appendSpaceEvent
    this.initializeSchema()
    if (this.surfaceCount() === 0) this.seed(options.seed ?? [])
  }

  listSurfaces(spaceId?: string): Surface[] {
    const rows =
      spaceId === undefined
        ? this.db.prepare('select * from surfaces where archived = 0 order by title, id').all()
        : this.db
            .prepare(
              'select * from surfaces where archived = 0 and space_id = ? order by title, id',
            )
            .all(spaceId)
    return rows.map(surfaceFromRow)
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
   * Observe every committed Surface-lifecycle event (patch, created,
   * archived) exactly once, after its SQLite write transaction commits.
   * The Gateway subscribes once, centrally, so nothing double-broadcasts.
   */
  onSurfaceEvent(observer: (event: SurfaceEngineEvent) => void): () => void {
    this.surfaceEventObservers.add(observer)
    return () => this.surfaceEventObservers.delete(observer)
  }

  createSurface(
    input: Surface | CreateSurfaceInput,
    updatedBy: SurfaceWriteActor,
    options?: CreateSurfaceOptions,
  ): Surface {
    const surface = this.surfaceForWrite(input, updatedBy)
    this.requireKnownSpace(surface.spaceId)
    const daemonOwned = options?.daemonOwned ?? false
    const event = this.runWrite(() => {
      const existing = this.db.prepare('select id from surfaces where id = ?').get(surface.id)
      if (existing) throw new Error(`Surface already exists: ${surface.id}`)
      this.insertSurface(surface, 1, 1, false, daemonOwned)
      this.appendSpaceEvent(surface.spaceId, {
        at: surface.freshness.updatedAt,
        type: 'surface.create',
        text: `Created Surface "${surface.title}"`,
        origin: options?.origin ?? 'trusted:system',
        payload: { surfaceId: surface.id },
      })
      return this.insertCreatedEvent(surface)
    })
    this.notifySurfaceEvent({ kind: 'created', event })
    return surface
  }

  archiveSurface(surfaceId: string, updatedBy: SurfaceWriteActor, origin?: Origin): Surface {
    this.assertWritableByAgent(surfaceId, updatedBy)
    const surface = this.requireActiveSurface(surfaceId)
    const archived = this.stampSurface(surface, updatedBy)
    const event = this.runWrite(() => {
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
      return this.insertArchivedEvent(archived)
    })
    this.notifySurfaceEvent({ kind: 'archived', event })
    return archived
  }

  patchState(
    surfaceId: string,
    operations: PatchOperation[],
    options: { updatedBy: SurfaceWriteActor; origin?: Origin },
  ): SurfaceMutation {
    assertPatchTarget(operations, 'state')
    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_state',
      eventText: (surface) => `Patched state for Surface "${surface.title}"`,
      updateTreeVersion: false,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    })
  }

  patchTree(
    surfaceId: string,
    operations: PatchOperation[],
    options: { expectedTreeVersion: number; updatedBy: SurfaceWriteActor; origin?: Origin },
  ): SurfaceMutation {
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
        origin: 'trusted:user',
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
        description: 'Create a protocol-valid Surface inside a Space.',
        schema: CreateSurfaceToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const surface = this.createSurface(input, 'agent', {
            origin: toolWriteOrigin(context.origin),
          })
          return { content: `created Surface ${surface.id}`, details: { surface } }
        },
      }),
      defineTool({
        name: 'patch_state',
        description: 'Patch typed Surface state with protocol validation.',
        schema: PatchStateToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const mutation = this.patchState(input.surfaceId, input.operations, {
            updatedBy: 'agent',
            origin: toolWriteOrigin(context.origin),
          })
          return { content: `patched state for Surface ${input.surfaceId}`, details: mutation }
        },
      }),
      defineTool({
        name: 'patch_tree',
        description: 'Patch a Surface Atom tree when the expected tree version still matches.',
        schema: PatchTreeToolInputSchema,
        level: 'L0',
        egressDomains: [],
        handler: (input, context) => {
          const mutation = this.patchTree(input.surfaceId, input.operations, {
            expectedTreeVersion: input.expectedTreeVersion,
            updatedBy: 'agent',
            origin: toolWriteOrigin(context.origin),
          })
          return { content: `patched tree for Surface ${input.surfaceId}`, details: mutation }
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
            toolWriteOrigin(context.origin),
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
    },
  ): SurfaceMutation {
    this.assertWritableByAgent(surfaceId, options.updatedBy)
    const mutation = this.runWrite(() => {
      const current = this.requireActiveSurface(surfaceId)
      const patch = PatchSchema.parse({ surfaceId, operations })
      const patched = this.stampSurface(applySurfacePatch(current, patch), options.updatedBy)
      const currentVersion = this.requireVersion(surfaceId)
      const nextVersion = currentVersion.version + 1
      const nextTreeVersion = options.updateTreeVersion
        ? currentVersion.treeVersion + 1
        : currentVersion.treeVersion

      this.updateSurface(patched, nextVersion, nextTreeVersion)
      const event = this.insertPatchEvent(patched, patch)
      if (options.idempotencyKey) this.rememberIdempotencyKey(options.idempotencyKey, event.cursor)
      this.appendSpaceEvent(patched.spaceId, {
        at: patched.freshness.updatedAt,
        type: options.eventType,
        text: options.eventText(patched),
        origin:
          options.origin ?? (options.eventType === 'fast_path' ? 'trusted:user' : 'trusted:system'),
        payload: options.eventPayload ?? { surfaceId, operations: operations.length },
      })
      return { surface: patched, event, duplicate: false }
    })
    this.notifySurfaceEvent({ kind: 'patch', event: mutation.event })
    return mutation
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
    })
    this.insertEventRow(cursor, event.at, event.spaceId, event.patch.surfaceId, 'patch', event)
    return event
  }

  private insertCreatedEvent(surface: Surface): SurfaceCreatedEvent {
    const cursor = this.latestSurfaceCursor() + 1
    const event = SurfaceCreatedEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      surface,
    })
    this.insertEventRow(cursor, event.at, event.spaceId, surface.id, 'created', event)
    return event
  }

  private insertArchivedEvent(surface: Surface): SurfaceArchivedEvent {
    const cursor = this.latestSurfaceCursor() + 1
    const event = SurfaceArchivedEventSchema.parse({
      cursor,
      at: surface.freshness.updatedAt,
      spaceId: surface.spaceId,
      surfaceId: surface.id,
    })
    this.insertEventRow(cursor, event.at, event.spaceId, surface.id, 'archived', event)
    return event
  }

  private insertEventRow(
    cursor: number,
    at: string,
    spaceId: string,
    surfaceId: string,
    kind: 'patch' | 'created' | 'archived',
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

  private rememberIdempotencyKey(key: string, eventCursor: number): void {
    this.db
      .prepare('insert into idempotency_keys (key, event_cursor) values (?, ?)')
      .run(key, eventCursor)
  }

  private surfaceForWrite(
    input: Surface | CreateSurfaceInput,
    updatedBy: SurfaceWriteActor,
  ): Surface {
    return SurfaceSchema.parse({
      ...input,
      freshness: {
        updatedAt: this.nowIso(),
        updatedBy,
      },
    })
  }

  private stampSurface(surface: Surface, updatedBy: SurfaceWriteActor): Surface {
    return SurfaceSchema.parse({
      ...surface,
      freshness: {
        updatedAt: this.nowIso(),
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
   * Public lookup (issue #14 review fix): callers that must not treat an
   * impostor Surface as daemon-owned — e.g. `ApprovalSurfaceManager.start()`
   * verifying a Surface it is about to adopt at a deterministic id — need
   * this alongside `assertWritableByAgent`'s internal check. Returns `false`
   * for an unknown surfaceId (nothing to adopt either way).
   */
  isDaemonOwned(surfaceId: string): boolean {
    const row = this.db.prepare('select daemon_owned from surfaces where id = ?').get(surfaceId)
    return row !== undefined && requiredNumber(row, 'daemon_owned') === 1
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
    version: number,
    treeVersion: number,
    archived: boolean,
    daemonOwned = false,
  ): void {
    this.db
      .prepare(
        `insert into surfaces
           (id, space_id, title, tree_json, state_json, version, tree_version,
            updated_at, updated_by, archived, daemon_owned)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
  }

  private updateSurface(surface: Surface, version: number, treeVersion: number): void {
    this.db
      .prepare(
        `update surfaces
         set title = ?, tree_json = ?, state_json = ?, version = ?, tree_version = ?,
             updated_at = ?, updated_by = ?
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
        surface.id,
      )
  }

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists surfaces (
        id text primary key,
        space_id text not null,
        title text not null,
        tree_json text not null,
        state_json text not null,
        version integer not null,
        tree_version integer not null,
        updated_at text not null,
        updated_by text not null,
        archived integer not null default 0,
        daemon_owned integer not null default 0
      );
      create index if not exists surfaces_space_active
        on surfaces (space_id, archived, title);

      create table if not exists surface_events (
        cursor integer primary key,
        at text not null,
        space_id text not null,
        surface_id text not null,
        kind text not null default 'patch',
        event_json text not null
      );

      create table if not exists idempotency_keys (
        key text primary key,
        event_cursor integer not null references surface_events(cursor)
      );

      create table if not exists agent_turns (
        id integer primary key autoincrement,
        at text not null,
        space_id text not null,
        surface_id text not null,
        atom_id text not null,
        action_name text not null,
        payload_json text not null,
        surface_json text not null,
        atom_json text not null
      );
    `)
    // Defensive migration: a `surfaces.sqlite` created before `kind` existed
    // must keep working — `create table if not exists` above only applies to
    // a fresh database, so an existing one is migrated here. Every row
    // written before this column existed was a patch event.
    this.ensureColumn('surface_events', 'kind', "text not null default 'patch'")
    // Defensive migration, same reasoning: a `surfaces.sqlite` created
    // before `daemon_owned` existed must keep working. Every Surface written
    // before this column existed predates ownership enforcement, so it
    // defaults to Agent-writable (0) — none of them were approval cards or
    // trust admin Surfaces, which did not exist yet either.
    this.ensureColumn('surfaces', 'daemon_owned', 'integer not null default 0')
  }

  /** Adds `column` to `table` if an existing (pre-migration) database lacks it. */
  private ensureColumn(table: string, column: string, sqlType: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all()
    const exists = columns.some((row) => requiredString(row, 'name') === column)
    if (!exists) this.db.exec(`alter table ${table} add column ${column} ${sqlType}`)
  }

  private surfaceCount(): number {
    const row = this.db.prepare('select count(*) as count from surfaces').get()
    return row ? requiredNumber(row, 'count') : 0
  }

  private seed(surfaces: Surface[]): void {
    if (surfaces.length === 0) return
    this.runWrite(() => {
      for (const surface of surfaces) {
        const parsed = SurfaceSchema.parse(surface)
        this.requireKnownSpace(parsed.spaceId)
        this.insertSurface(parsed, 1, 1, false)
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

function surfaceFromRow(row: Record<string, unknown>): Surface {
  return SurfaceSchema.parse({
    id: requiredString(row, 'id'),
    spaceId: requiredString(row, 'space_id'),
    title: requiredString(row, 'title'),
    tree: JSON.parse(requiredString(row, 'tree_json')),
    state: JSON.parse(requiredString(row, 'state_json')),
    freshness: {
      updatedAt: requiredString(row, 'updated_at'),
      updatedBy: requiredString(row, 'updated_by'),
    },
  })
}

function surfaceEngineEventFromRow(row: Record<string, unknown>): SurfaceEngineEvent {
  const kind = requiredString(row, 'kind')
  const json = JSON.parse(requiredString(row, 'event_json'))
  if (kind === 'created') return { kind: 'created', event: SurfaceCreatedEventSchema.parse(json) }
  if (kind === 'archived') {
    return { kind: 'archived', event: SurfaceArchivedEventSchema.parse(json) }
  }
  if (kind === 'patch') return { kind: 'patch', event: SurfacePatchEventSchema.parse(json) }
  throw new Error(`unknown surface_events kind: ${kind}`)
}

function agentTurnFromRow(row: Record<string, unknown>): QueuedAgentTurn {
  const id = requiredNumber(row, 'id')
  return {
    id: `agent-turn-${id}`,
    at: requiredString(row, 'at'),
    spaceId: requiredString(row, 'space_id'),
    surfaceId: requiredString(row, 'surface_id'),
    atomId: requiredString(row, 'atom_id'),
    actionName: requiredString(row, 'action_name'),
    payload: JsonObjectSchema.parse(JSON.parse(requiredString(row, 'payload_json'))),
    surface: SurfaceSchema.parse(JSON.parse(requiredString(row, 'surface_json'))),
    atom: AtomNodeSchema.parse(JSON.parse(requiredString(row, 'atom_json'))),
  }
}

function statePath(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}
