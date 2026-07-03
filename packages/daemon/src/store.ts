import {
  PatchSchema,
  SurfaceSnapshotSchema,
  SurfaceSchema,
  type JsonValue,
  type Space,
  type Surface,
  type SurfacePatchEvent,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import type { FactRecord, FactsDocument } from './facts.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine, type SpaceEvent } from './spaces-engine.ts'

export interface SurfaceMutation {
  surface: Surface
  event: SurfacePatchEvent
}

export interface StoreOptions {
  rootDir?: string
  now?: () => Date
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
  private surfaces = new Map<string, Surface>()
  private surfaceEvents: SurfacePatchEvent[] = []
  private surfaceCursor = 0
  private readonly now: () => Date

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.spacesEngine = new SpacesEngine({
      now: this.now,
      seed: seedSpaces(),
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    })
    for (const surface of this.spacesEngine.listPersistedSurfaces()) {
      this.surfaces.set(surface.id, surface)
    }
  }

  listSpaces(): Space[] {
    return this.spacesEngine.listSpaces()
  }

  getSpace(id: string): Space | undefined {
    return this.spacesEngine.getSpace(id)
  }

  listSurfaces(spaceId?: string): Surface[] {
    const all = [...this.surfaces.values()]
    if (spaceId) {
      return [
        ...all.filter((surface) => surface.spaceId === spaceId),
        this.spacesEngine.factsSurface(spaceId),
      ]
    }
    return [...all, ...this.listSpaces().map((space) => this.spacesEngine.factsSurface(space.id))]
  }

  getSurface(id: string): Surface | undefined {
    return (
      this.surfaces.get(id) ??
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
    return this.surfaceCursor
  }

  surfaceEventsAfter(cursor: number): SurfacePatchEvent[] {
    return this.surfaceEvents.filter((event) => event.cursor > cursor)
  }

  /** Fast path: mutate one state key, stamp freshness, log the event. No LLM. */
  applyFastAction(surfaceId: string, stateKey: string, value: JsonValue): SurfaceMutation {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) throw new Error(`unknown surface: ${surfaceId}`)
    const updatedAt = this.now().toISOString()
    const updated = SurfaceSchema.parse({
      ...surface,
      state: { ...surface.state, [stateKey]: value },
      freshness: { updatedAt, updatedBy: 'user' },
    })
    const event: SurfacePatchEvent = {
      cursor: this.surfaceCursor + 1,
      at: updatedAt,
      spaceId: surface.spaceId,
      patch: PatchSchema.parse({
        surfaceId,
        operations: [
          {
            target: 'state',
            op: Object.prototype.hasOwnProperty.call(surface.state, stateKey) ? 'replace' : 'add',
            path: statePath(stateKey),
            value,
          },
        ],
      }),
      freshness: updated.freshness,
    }
    this.surfaceCursor = event.cursor
    this.surfaces.set(surfaceId, updated)
    this.spacesEngine.saveSurface(updated)
    this.surfaceEvents.push(event)
    this.spacesEngine.appendEvent(surface.spaceId, {
      at: updatedAt,
      type: 'fast_path',
      text: `${surface.title}: ${stateKey} -> ${JSON.stringify(value)}`,
      origin: 'trusted:user',
      payload: { surfaceId, stateKey, value },
    })
    return { surface: updated, event }
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

function statePath(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}
