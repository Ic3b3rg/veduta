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
import { seedSpaces } from './seed.ts'

export interface SpaceEvent {
  at: string
  spaceId: string
  text: string
}

export interface SurfaceMutation {
  surface: Surface
  event: SurfacePatchEvent
}

/**
 * In-memory store for the dev scaffold. The real Spaces engine
 * (files + SQLite) arrives with issues #6 and #7 — the shape of this
 * interface is what matters here, not the persistence.
 *
 * Fast-path contract (ADR-0003): every deterministic mutation appends
 * an event to the Space's Event log so the Agent finds it before
 * reasoning about the Space.
 */
export class Store {
  private spaces = new Map<string, Space>()
  private surfaces = new Map<string, Surface>()
  private events: SpaceEvent[] = []
  private surfaceEvents: SurfacePatchEvent[] = []
  private surfaceCursor = 0

  constructor() {
    const { spaces, surfaces } = seedSpaces()
    for (const space of spaces) this.spaces.set(space.id, space)
    for (const surface of surfaces) this.surfaces.set(surface.id, surface)
  }

  listSpaces(): Space[] {
    return [...this.spaces.values()].filter((s) => !s.archived)
  }

  getSpace(id: string): Space | undefined {
    return this.spaces.get(id)
  }

  listSurfaces(spaceId?: string): Surface[] {
    const all = [...this.surfaces.values()]
    return spaceId ? all.filter((s) => s.spaceId === spaceId) : all
  }

  getSurface(id: string): Surface | undefined {
    return this.surfaces.get(id)
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
    const updated = SurfaceSchema.parse({
      ...surface,
      state: { ...surface.state, [stateKey]: value },
      freshness: { updatedAt: new Date().toISOString(), updatedBy: 'user' },
    })
    const event: SurfacePatchEvent = {
      cursor: this.surfaceCursor + 1,
      at: updated.freshness.updatedAt,
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
    this.surfaceEvents.push(event)
    this.events.push({
      at: updated.freshness.updatedAt,
      spaceId: surface.spaceId,
      text: `${surface.title}: ${stateKey} → ${JSON.stringify(value)}`,
    })
    return { surface: updated, event }
  }

  eventLog(spaceId: string): SpaceEvent[] {
    return this.events.filter((e) => e.spaceId === spaceId)
  }
}

function statePath(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}
