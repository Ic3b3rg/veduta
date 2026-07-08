import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AtomNodeSchema,
  JsonObjectSchema,
  PatchOperationSchema,
  PatchSchema,
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
  type SurfacePatchEvent,
} from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { AppendSpaceEventInput } from './spaces-engine.ts'
import { requiredNumber, requiredString, withImmediateTransaction } from './sqlite-rows.ts'

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

  surfaceEventsAfter(cursor: number): SurfacePatchEvent[] {
    return this.db
      .prepare('select event_json from surface_events where cursor > ? order by cursor')
      .all(cursor)
      .map((row) => SurfacePatchEventSchema.parse(JSON.parse(requiredString(row, 'event_json'))))
  }

  createSurface(input: Surface | CreateSurfaceInput, updatedBy: SurfaceWriteActor): Surface {
    const surface = this.surfaceForWrite(input, updatedBy)
    this.requireKnownSpace(surface.spaceId)
    this.runWrite(() => {
      const existing = this.db.prepare('select id from surfaces where id = ?').get(surface.id)
      if (existing) throw new Error(`Surface already exists: ${surface.id}`)
      this.insertSurface(surface, 1, 1, false)
      this.appendSpaceEvent(surface.spaceId, {
        at: surface.freshness.updatedAt,
        type: 'surface.create',
        text: `Created Surface "${surface.title}"`,
        origin: 'trusted:system',
        payload: { surfaceId: surface.id },
      })
    })
    return surface
  }

  archiveSurface(surfaceId: string, updatedBy: SurfaceWriteActor): Surface {
    const surface = this.requireActiveSurface(surfaceId)
    const archived = this.stampSurface(surface, updatedBy)
    this.runWrite(() => {
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
        origin: 'trusted:system',
        payload: { surfaceId },
      })
    })
    return archived
  }

  patchState(
    surfaceId: string,
    operations: PatchOperation[],
    options: { updatedBy: SurfaceWriteActor },
  ): SurfaceMutation {
    assertPatchTarget(operations, 'state')
    return this.patchSurface(surfaceId, operations, {
      updatedBy: options.updatedBy,
      eventType: 'surface.patch_state',
      eventText: (surface) => `Patched state for Surface "${surface.title}"`,
      updateTreeVersion: false,
    })
  }

  patchTree(
    surfaceId: string,
    operations: PatchOperation[],
    options: { expectedTreeVersion: number; updatedBy: SurfaceWriteActor },
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
        handler: (input) => {
          const surface = this.createSurface(input, 'agent')
          return { content: `created Surface ${surface.id}`, details: { surface } }
        },
      }),
      defineTool({
        name: 'patch_state',
        description: 'Patch typed Surface state with protocol validation.',
        schema: PatchStateToolInputSchema,
        handler: (input) => {
          const mutation = this.patchState(input.surfaceId, input.operations, {
            updatedBy: 'agent',
          })
          return { content: `patched state for Surface ${input.surfaceId}`, details: mutation }
        },
      }),
      defineTool({
        name: 'patch_tree',
        description: 'Patch a Surface Atom tree when the expected tree version still matches.',
        schema: PatchTreeToolInputSchema,
        handler: (input) => {
          const mutation = this.patchTree(input.surfaceId, input.operations, {
            expectedTreeVersion: input.expectedTreeVersion,
            updatedBy: 'agent',
          })
          return { content: `patched tree for Surface ${input.surfaceId}`, details: mutation }
        },
      }),
      defineTool({
        name: 'archive_surface',
        description: 'Archive a Surface without deleting its Space memory.',
        schema: ArchiveSurfaceToolInputSchema,
        handler: (input) => {
          const surface = this.archiveSurface(input.surfaceId, 'agent')
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
    },
  ): SurfaceMutation {
    return this.runWrite(() => {
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
        origin: options.eventType === 'fast_path' ? 'trusted:user' : 'trusted:system',
        payload: options.eventPayload ?? { surfaceId, operations: operations.length },
      })
      return { surface: patched, event, duplicate: false }
    })
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
    this.db
      .prepare(
        `insert into surface_events (cursor, at, space_id, surface_id, event_json)
         values (?, ?, ?, ?, ?)`,
      )
      .run(cursor, event.at, event.spaceId, event.patch.surfaceId, JSON.stringify(event))
    return event
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
  ): void {
    this.db
      .prepare(
        `insert into surfaces
           (id, space_id, title, tree_json, state_json, version, tree_version,
            updated_at, updated_by, archived)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        archived integer not null default 0
      );
      create index if not exists surfaces_space_active
        on surfaces (space_id, archived, title);

      create table if not exists surface_events (
        cursor integer primary key,
        at text not null,
        space_id text not null,
        surface_id text not null,
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
