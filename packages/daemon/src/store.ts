import type { JsonValue, Space, Surface } from '@veduta/protocol'
import { seedSpaces } from './seed.ts'

export interface SpaceEvent {
  at: string
  spaceId: string
  text: string
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

  /** Fast path: mutate one state key, stamp freshness, log the event. No LLM. */
  applyFastAction(surfaceId: string, stateKey: string, value: JsonValue): Surface {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) throw new Error(`unknown surface: ${surfaceId}`)
    const updated: Surface = {
      ...surface,
      state: { ...surface.state, [stateKey]: value },
      freshness: { updatedAt: new Date().toISOString(), updatedBy: 'user' },
    }
    this.surfaces.set(surfaceId, updated)
    this.events.push({
      at: updated.freshness.updatedAt,
      spaceId: surface.spaceId,
      text: `${surface.title}: ${stateKey} → ${JSON.stringify(value)}`,
    })
    return updated
  }

  eventLog(spaceId: string): SpaceEvent[] {
    return this.events.filter((e) => e.spaceId === spaceId)
  }
}
