import {
  applySurfacePatchEvent,
  SurfaceSnapshotSchema,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfacePatchEvent,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'

export interface SurfaceDeepLink {
  spaceSlug: string
  surfaceId: string
}

export function surfaceDeepLink(spaceSlug: string, surfaceId: string): string {
  return `/app/space/${encodeURIComponent(spaceSlug)}/surface/${encodeURIComponent(surfaceId)}`
}

export function parseSurfaceDeepLink(pathname: string): SurfaceDeepLink | undefined {
  const match = /^\/app\/space\/([^/]+)\/surface\/([^/]+)$/.exec(pathname)
  if (!match) return undefined
  return {
    spaceSlug: decodeURIComponent(match[1]!),
    surfaceId: decodeURIComponent(match[2]!),
  }
}

export function mergeSurfaceOrder(surfaceIds: string[], savedOrder: string[]): string[] {
  const known = new Set(surfaceIds)
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const id of savedOrder) {
    if (!known.has(id) || seen.has(id)) continue
    ordered.push(id)
    seen.add(id)
  }

  for (const id of surfaceIds) {
    if (seen.has(id)) continue
    ordered.push(id)
  }

  return ordered
}

export function moveSurfaceId(surfaceIds: string[], surfaceId: string, offset: -1 | 1): string[] {
  const index = surfaceIds.indexOf(surfaceId)
  const nextIndex = index + offset
  if (index < 0 || nextIndex < 0 || nextIndex >= surfaceIds.length) return surfaceIds

  const next = [...surfaceIds]
  const [removed] = next.splice(index, 1)
  next.splice(nextIndex, 0, removed!)
  return next
}

export function saveSnapshot(storage: Storage, key: string, snapshot: SurfaceSnapshot): void {
  storage.setItem(key, JSON.stringify(SurfaceSnapshotSchema.parse(snapshot)))
}

export function cachedSnapshot(storage: Storage, key: string): SurfaceSnapshot | undefined {
  const raw = storage.getItem(key)
  if (!raw) return undefined

  try {
    const parsed = SurfaceSnapshotSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// Surface lifecycle stream (D9): the Gateway may broadcast surface.patch /
// surface.created / surface.archived while a client is still catching up
// (e.g. right after a reconnect). These pure helpers let App apply an event
// against the current snapshot and report whether it found its target,
// without touching React state directly.

export type SurfaceStreamEvent =
  | { type: 'surface.patch'; event: SurfacePatchEvent }
  | { type: 'surface.created'; event: SurfaceCreatedEvent }
  | { type: 'surface.archived'; event: SurfaceArchivedEvent }

export interface SurfaceStreamApplyResult {
  spaces: SpaceWithSurfaces[]
  applied: boolean
}

export function surfaceStreamEventCursor(streamEvent: SurfaceStreamEvent): number {
  return streamEvent.event.cursor
}

export function applySurfacePatchToSpaces(
  spaces: SpaceWithSurfaces[],
  event: SurfacePatchEvent,
): SurfaceStreamApplyResult {
  let applied = false
  const next = spaces.map((space) => ({
    ...space,
    surfaces: space.surfaces.map((surface) => {
      if (surface.id !== event.patch.surfaceId) return surface
      applied = true
      return applySurfacePatchEvent(surface, event)
    }),
  }))
  return { spaces: next, applied }
}

export function applySurfaceCreatedToSpaces(
  spaces: SpaceWithSurfaces[],
  event: SurfaceCreatedEvent,
): SurfaceStreamApplyResult {
  let applied = false
  const next = spaces.map((space) => {
    if (space.id !== event.spaceId) return space
    applied = true
    const exists = space.surfaces.some((surface) => surface.id === event.surface.id)
    return {
      ...space,
      surfaces: exists
        ? space.surfaces.map((surface) =>
            surface.id === event.surface.id ? event.surface : surface,
          )
        : [...space.surfaces, event.surface],
    }
  })
  return { spaces: next, applied }
}

export function applySurfaceArchivedToSpaces(
  spaces: SpaceWithSurfaces[],
  event: SurfaceArchivedEvent,
): SurfaceStreamApplyResult {
  let applied = false
  const next = spaces.map((space) => {
    if (space.id !== event.spaceId) return space
    const filtered = space.surfaces.filter((surface) => surface.id !== event.surfaceId)
    if (filtered.length !== space.surfaces.length) applied = true
    return { ...space, surfaces: filtered }
  })
  return { spaces: next, applied }
}

export function applySurfaceStreamEvent(
  spaces: SpaceWithSurfaces[],
  streamEvent: SurfaceStreamEvent,
): SurfaceStreamApplyResult {
  switch (streamEvent.type) {
    case 'surface.patch':
      return applySurfacePatchToSpaces(spaces, streamEvent.event)
    case 'surface.created':
      return applySurfaceCreatedToSpaces(spaces, streamEvent.event)
    case 'surface.archived':
      return applySurfaceArchivedToSpaces(spaces, streamEvent.event)
  }
}

/**
 * Replays stream events buffered while a snapshot refetch was in flight
 * (D9/R2-M2): events are applied in cursor order and events at or below the
 * fresh snapshot's cursor are skipped (the snapshot already reflects them).
 * Events that still can't find their target are returned as `unresolved` so
 * the caller can fall back to its normal error path.
 */
export function applyBufferedSurfaceStreamEvents(
  spaces: SpaceWithSurfaces[],
  afterCursor: number,
  bufferedEvents: SurfaceStreamEvent[],
): { spaces: SpaceWithSurfaces[]; cursor: number; unresolved: SurfaceStreamEvent[] } {
  const ordered = [...bufferedEvents].sort(
    (a, b) => surfaceStreamEventCursor(a) - surfaceStreamEventCursor(b),
  )
  let current = spaces
  let cursor = afterCursor
  const unresolved: SurfaceStreamEvent[] = []

  for (const streamEvent of ordered) {
    const eventCursor = surfaceStreamEventCursor(streamEvent)
    if (eventCursor <= afterCursor) continue

    const result = applySurfaceStreamEvent(current, streamEvent)
    if (!result.applied) {
      unresolved.push(streamEvent)
      continue
    }
    current = result.spaces
    cursor = Math.max(cursor, eventCursor)
  }

  return { spaces: current, cursor, unresolved }
}
