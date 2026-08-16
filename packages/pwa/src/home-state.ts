import {
  applySurfacePatchEvent,
  SurfaceSnapshotSchema,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfaceMovedEvent,
  type SurfaceOrder,
  type SurfacePatchEvent,
  type SurfacePinnedEvent,
  type SurfaceSnapshot,
  type Surface,
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

const CANONICAL_HOME_CACHE_AUTHORITY = 'gateway-surface-order-v1'

export function saveSnapshot(storage: Storage, key: string, snapshot: SurfaceSnapshot): void {
  storage.setItem(
    key,
    JSON.stringify({
      ...SurfaceSnapshotSchema.parse(snapshot),
      surfaceOrderAuthority: CANONICAL_HOME_CACHE_AUTHORITY,
    }),
  )
}

export function cachedSnapshot(storage: Storage, key: string): SurfaceSnapshot | undefined {
  const raw = storage.getItem(key)
  if (!raw) return undefined

  try {
    const json = JSON.parse(raw) as { surfaceOrderAuthority?: unknown }
    if (json.surfaceOrderAuthority !== CANONICAL_HOME_CACHE_AUTHORITY) return undefined
    const parsed = SurfaceSnapshotSchema.safeParse(json)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

// Surface lifecycle stream: the Gateway may broadcast surface.patch /
// surface.created / surface.archived while a client is still catching up
// (e.g. right after a reconnect). These pure helpers let App apply an event
// against the current snapshot and report whether it found its target,
// without touching React state directly.

export type SurfaceStreamEvent =
  | { type: 'surface.patch'; event: SurfacePatchEvent }
  | { type: 'surface.created'; event: SurfaceCreatedEvent }
  | { type: 'surface.archived'; event: SurfaceArchivedEvent }
  | { type: 'surface.pinned'; event: SurfacePinnedEvent }
  | { type: 'surface.moved'; event: SurfaceMovedEvent }

export interface SurfaceStreamApplyResult {
  spaces: SpaceWithSurfaces[]
  applied: boolean
}

export function surfaceStreamEventCursor(streamEvent: SurfaceStreamEvent): number {
  return streamEvent.event.cursor
}

export function surfaceOrderForStreamEvent(
  streamEvent: SurfaceStreamEvent,
): SurfaceOrder | undefined {
  return streamEvent.type === 'surface.patch' ? undefined : streamEvent.event.order
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
  let foundSpace = false
  const next = spaces.map((space) => {
    if (space.id !== event.spaceId) return space
    foundSpace = true
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
  return foundSpace ? applySurfaceOrderToSpaces(next, event.order) : { spaces, applied: false }
}

export function applySurfaceArchivedToSpaces(
  spaces: SpaceWithSurfaces[],
  event: SurfaceArchivedEvent,
): SurfaceStreamApplyResult {
  let foundSpace = false
  const next = spaces.map((space) => {
    if (space.id !== event.spaceId) return space
    foundSpace = true
    const filtered = space.surfaces.filter((surface) => surface.id !== event.surfaceId)
    return { ...space, surfaces: filtered }
  })
  return foundSpace ? applySurfaceOrderToSpaces(next, event.order) : { spaces, applied: false }
}

/** A `surface.pinned` event flips `pinned` on the matching Surface in place
 * and applies the event's own `freshness` (a pin is a change to the
 * Surface, and the daemon already stamps one), leaving `tree`/`state`
 * untouched. An unknown `surfaceId` is ignored -- `applied` stays false,
 * same as the other apply-to-spaces helpers, rather than fabricating a
 * phantom Surface. */
export function applySurfacePinnedToSpaces(
  spaces: SpaceWithSurfaces[],
  event: SurfacePinnedEvent,
): SurfaceStreamApplyResult {
  let foundSurface = false
  const next = spaces.map((space) => {
    if (space.id !== event.spaceId) return space
    return {
      ...space,
      surfaces: space.surfaces.map((surface) => {
        if (surface.id !== event.surfaceId) return surface
        foundSurface = true
        return { ...surface, pinned: event.pinned, freshness: event.freshness }
      }),
    }
  })
  return foundSurface ? applySurfaceOrderToSpaces(next, event.order) : { spaces, applied: false }
}

/**
 * Applies only the Gateway-authored ids. Read-time projected Surfaces (for
 * example FACTS or usage) are not rows in the durable order table, so they
 * retain their snapshot order after the authoritative durable groups.
 */
export function applySurfaceOrderToSpaces(
  spaces: SpaceWithSurfaces[],
  order: SurfaceOrder,
): SurfaceStreamApplyResult {
  let applied = false
  const next = spaces.map((space) => {
    if (space.id !== order.spaceId) return space
    const byId = new Map(space.surfaces.map((surface) => [surface.id, surface]))
    const ordered: Surface[] = []

    for (const surfaceId of order.pinnedSurfaceIds) {
      const surface = byId.get(surfaceId)
      if (!surface || !surface.pinned) return space
      ordered.push(surface)
    }
    for (const surfaceId of order.regularSurfaceIds) {
      const surface = byId.get(surfaceId)
      if (!surface || surface.pinned) return space
      ordered.push(surface)
    }

    const authoritativeIds = new Set([...order.pinnedSurfaceIds, ...order.regularSurfaceIds])
    applied = true
    return {
      ...space,
      surfaces: [
        ...ordered,
        ...space.surfaces.filter((surface) => !authoritativeIds.has(surface.id)),
      ],
    }
  })
  return { spaces: applied ? next : spaces, applied }
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
    case 'surface.pinned':
      return applySurfacePinnedToSpaces(spaces, streamEvent.event)
    case 'surface.moved':
      return applySurfaceOrderToSpaces(spaces, streamEvent.event.order)
  }
}

// The daemon's `space.attention` frame and the `/api/spaces` snapshot can
// race. Both merge points below use the newest revision, so a stale refetch
// cannot restore an older attention count.

export interface SpaceAttentionFrame {
  spaceId: string
  count: number
  revision: number
}

export function applySpaceAttention(
  spaces: SpaceWithSurfaces[],
  frame: SpaceAttentionFrame,
): SpaceWithSurfaces[] {
  return spaces.map((space) => {
    if (space.id !== frame.spaceId) return space
    if (frame.revision <= space.attentionRevision) return space
    return { ...space, attention: frame.count, attentionRevision: frame.revision }
  })
}

/**
 * Reconciles a freshly-fetched snapshot against the attention state already
 * held in memory: per Space, whichever side has the higher
 * `attentionRevision` wins. Used after `/api/spaces` refetches so a WS
 * `space.attention` frame that arrived while the refetch was in flight isn't
 * clobbered by the (now stale) snapshot response.
 */
export function mergeSpaceAttention(
  freshSpaces: SpaceWithSurfaces[],
  previousSpaces: SpaceWithSurfaces[],
): SpaceWithSurfaces[] {
  const previousById = new Map(previousSpaces.map((space) => [space.id, space]))
  return freshSpaces.map((space) => {
    const previous = previousById.get(space.id)
    if (!previous || previous.attentionRevision <= space.attentionRevision) return space
    return {
      ...space,
      attention: previous.attention,
      attentionRevision: previous.attentionRevision,
    }
  })
}

/**
 * Replays stream events buffered while a snapshot refetch was in flight
 * (R2-M2): events are applied in cursor order and events at or below the
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
