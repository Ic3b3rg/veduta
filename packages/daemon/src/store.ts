import {
  SurfaceSnapshotSchema,
  findDeclaredAction,
  type JsonValue,
  type PatchOperation,
  type Space,
  type Surface,
  type SurfaceSnapshot,
  type ActionInvocation,
} from '@veduta/protocol'
import type { ToolDef } from './agent-runner.ts'
import type { FactRecord, FactsDocument } from './facts.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine, type SpaceEvent } from './spaces-engine.ts'
import {
  SurfaceEngine,
  type QueuedAgentTurn,
  type SurfaceMutation,
  type SurfaceVersion,
} from './surface-engine.ts'

export interface StoreOptions {
  rootDir?: string
  now?: () => Date
}

export type SurfaceActionResult =
  { path: 'fast'; mutation: SurfaceMutation } | { path: 'agent'; turn: QueuedAgentTurn }

export type SurfaceActionErrorCode = 'unknown_surface' | 'undeclared_action' | 'missing_value'

export class SurfaceActionError extends Error {
  constructor(
    readonly code: SurfaceActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SurfaceActionError'
  }
}

/**
 * Store facade for the Gateway: Surfaces stay behind protocol validation,
 * while Space memory is file-backed by SpacesEngine (issue #6).
 *
 * Fast-path contract (ADR-0003): every deterministic mutation appends
 * an event to the Space's Event log so the Agent finds it before
 * reasoning about the Space.
 */
export class Store {
  readonly spacesEngine: SpacesEngine
  private readonly surfaceEngine: SurfaceEngine
  private readonly now: () => Date
  private readonly llmCalls = 0

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    const seed = seedSpaces()
    this.spacesEngine = new SpacesEngine({
      now: this.now,
      seed: { spaces: seed.spaces, surfaces: [] },
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    })
    const persistedSurfaces = this.spacesEngine.listPersistedSurfaces()
    this.surfaceEngine = new SurfaceEngine({
      rootDir: this.spacesEngine.rootDir,
      now: this.now,
      seed: persistedSurfaces.length > 0 ? persistedSurfaces : seed.surfaces,
      hasSpace: (spaceId) => Boolean(this.spacesEngine.getSpace(spaceId)),
      appendSpaceEvent: (spaceId, input) => this.spacesEngine.appendEvent(spaceId, input),
    })
  }

  listSpaces(): Space[] {
    return this.spacesEngine.listSpaces()
  }

  getSpace(id: string): Space | undefined {
    return this.spacesEngine.getSpace(id)
  }

  listSurfaces(spaceId?: string): Surface[] {
    if (spaceId) {
      return [...this.surfaceEngine.listSurfaces(spaceId), this.spacesEngine.factsSurface(spaceId)]
    }
    return [
      ...this.surfaceEngine.listSurfaces(),
      ...this.listSpaces().map((space) => this.spacesEngine.factsSurface(space.id)),
    ]
  }

  getSurface(id: string): Surface | undefined {
    return (
      this.surfaceEngine.getSurface(id) ??
      this.listSpaces()
        .map((space) => this.spacesEngine.factsSurface(space.id))
        .find((surface) => surface.id === id)
    )
  }

  snapshot(): SurfaceSnapshot {
    return SurfaceSnapshotSchema.parse({
      surfaceCursor: this.latestSurfaceCursor(),
      spaces: this.listSpaces().map((space) => ({
        ...space,
        surfaces: this.listSurfaces(space.id),
      })),
    })
  }

  latestSurfaceCursor(): number {
    return this.surfaceEngine.latestSurfaceCursor()
  }

  surfaceEventsAfter(cursor: number) {
    return this.surfaceEngine.surfaceEventsAfter(cursor)
  }

  /** Fast path: mutate one state key, stamp freshness, log the event. No LLM. */
  applyFastAction(
    surfaceId: string,
    stateKey: string,
    value: JsonValue,
    idempotencyKey?: string,
  ): SurfaceMutation {
    return this.surfaceEngine.applyFastAction(surfaceId, stateKey, value, idempotencyKey)
  }

  invokeSurfaceAction(surfaceId: string, invocation: ActionInvocation): SurfaceActionResult {
    const surface = this.getSurface(surfaceId)
    if (!surface) throw new SurfaceActionError('unknown_surface', `unknown Surface: ${surfaceId}`)
    const action = findDeclaredAction(surface.tree, invocation.nodeId, invocation.name)
    if (!action) {
      throw new SurfaceActionError(
        'undeclared_action',
        `action "${invocation.name}" is not declared by node "${invocation.nodeId}"`,
      )
    }

    if (action.path === 'agent') {
      return { path: 'agent', turn: this.surfaceEngine.enqueueAgentAction(surface, invocation) }
    }

    if (action.stateKey === undefined) {
      throw new SurfaceActionError(
        'undeclared_action',
        `fast action "${invocation.name}" does not declare a state key`,
      )
    }

    const value = invocation.payload?.['value']
    if (value === undefined) {
      throw new SurfaceActionError(
        'missing_value',
        `fast action "${invocation.name}" did not provide a value`,
      )
    }

    return {
      path: 'fast',
      mutation: this.applyFastAction(surfaceId, action.stateKey, value, invocation.idempotencyKey),
    }
  }

  createSurface(surface: Surface, updatedBy: 'agent' | 'user' | 'job'): Surface {
    return this.surfaceEngine.createSurface(surface, updatedBy)
  }

  patchState(
    surfaceId: string,
    operations: PatchOperation[],
    options: { updatedBy: 'agent' | 'user' | 'job' },
  ): SurfaceMutation {
    return this.surfaceEngine.patchState(surfaceId, operations, options)
  }

  patchTree(
    surfaceId: string,
    operations: PatchOperation[],
    options: { expectedTreeVersion: number; updatedBy: 'agent' | 'user' | 'job' },
  ): SurfaceMutation {
    return this.surfaceEngine.patchTree(surfaceId, operations, options)
  }

  archiveSurface(surfaceId: string, updatedBy: 'agent' | 'user' | 'job'): Surface {
    return this.surfaceEngine.archiveSurface(surfaceId, updatedBy)
  }

  getSurfaceVersion(surfaceId: string): SurfaceVersion | undefined {
    return this.surfaceEngine.getSurfaceVersion(surfaceId)
  }

  surfaceTools(): ToolDef[] {
    return this.surfaceEngine.surfaceTools()
  }

  agentTurns(): QueuedAgentTurn[] {
    return this.surfaceEngine.agentTurns()
  }

  llmCallCount(): number {
    return this.llmCalls
  }

  eventLog(spaceId: string): SpaceEvent[] {
    return this.spacesEngine.readRecent(spaceId, Number.MAX_SAFE_INTEGER)
  }

  writeFact(spaceId: string, fact: string) {
    return this.spacesEngine.writeFact(spaceId, fact)
  }

  readFacts(spaceId: string): FactsDocument {
    return this.spacesEngine.readFacts(spaceId)
  }

  searchFacts(spaceId: string, query: string): FactRecord[] {
    return this.spacesEngine.searchFacts(spaceId, query)
  }

  archiveSpace(spaceId: string): Space {
    return this.spacesEngine.archiveSpace(spaceId)
  }

  restoreSpace(spaceId: string): Space {
    return this.spacesEngine.restoreSpace(spaceId)
  }

  assembleSpaceContext(spaceId: string): string {
    return this.spacesEngine.assembleContext(spaceId)
  }
}
