import {
  RenderableSurfaceSchema,
  RenderableSurfaceSnapshotSchema,
  type RenderableSurface,
  type SurfaceOrder,
  type RenderableSurfaceSnapshot,
} from '@veduta/protocol'
import {
  applySpaceAttention,
  applySurfaceOrderToSpaces,
  applySurfaceStreamEvent,
  mergeSpaceAttention,
  surfaceOrderForStreamEvent,
  type SurfaceStreamEvent,
} from './home-state.ts'
import type { SpaceWithSurfaces } from './api.ts'

/** Freshness authority shared by HTTP confirmations, replay, and live Surface delivery. */
export class LiveSurfaceProjection {
  spaces: SpaceWithSurfaces[] = []
  cursor = 0
  private patchCursors = new Map<string, number>()
  private presentationCursors = new Map<string, number>()
  private pinCursors = new Map<string, number>()
  private orderCursors = new Map<string, number>()
  private rebasing = false

  constructor(snapshot?: RenderableSurfaceSnapshot) {
    if (snapshot) this.replace(snapshot)
  }

  rebase(): void {
    this.cursor = 0
    this.patchCursors.clear()
    this.presentationCursors.clear()
    this.pinCursors.clear()
    this.orderCursors.clear()
    this.rebasing = true
  }

  replace(input: RenderableSurfaceSnapshot): void {
    const snapshot = RenderableSurfaceSnapshotSchema.parse(input)
    if (this.rebasing) {
      this.spaces = []
      this.rebasing = false
    }
    const previous = new Map(
      this.spaces.flatMap((space) =>
        space.surfaces.map((surface) => [surface.id, surface] as const),
      ),
    )
    let spaces = mergeSpaceAttention(snapshot.spaces, this.spaces).map((space) => ({
      ...space,
      surfaces: space.surfaces.map((surface) =>
        this.mergeConfirmed(surface, snapshot.surfaceCursor, previous.get(surface.id)),
      ),
    }))
    for (const space of this.spaces) {
      if ((this.orderCursors.get(space.id) ?? -1) <= snapshot.surfaceCursor) continue
      const byId = new Map(
        spaces
          .find((candidate) => candidate.id === space.id)
          ?.surfaces.map((surface) => [surface.id, surface]),
      )
      spaces = spaces.map((candidate) =>
        candidate.id === space.id
          ? {
              ...candidate,
              surfaces: [
                ...space.surfaces.flatMap((surface) => {
                  const current = byId.get(surface.id)
                  return current ? [current] : []
                }),
                ...candidate.surfaces.filter(
                  (surface) => !space.surfaces.some((previous) => previous.id === surface.id),
                ),
              ],
            }
          : candidate,
      )
    }
    this.spaces = spaces
    this.cursor = Math.max(this.cursor, snapshot.surfaceCursor)
    for (const space of spaces) {
      this.orderCursors.set(
        space.id,
        Math.max(snapshot.surfaceCursor, this.orderCursors.get(space.id) ?? -1),
      )
      for (const surface of space.surfaces) {
        this.patchCursors.set(
          surface.id,
          Math.max(snapshot.surfaceCursor, this.patchCursors.get(surface.id) ?? -1),
        )
        this.presentationCursors.set(
          surface.id,
          Math.max(snapshot.surfaceCursor, this.presentationCursors.get(surface.id) ?? -1),
        )
        this.pinCursors.set(
          surface.id,
          Math.max(snapshot.surfaceCursor, this.pinCursors.get(surface.id) ?? -1),
        )
      }
    }
  }

  apply(event: SurfaceStreamEvent): boolean {
    const cursor = event.event.cursor
    const order = surfaceOrderForStreamEvent(event)
    const surfaceId =
      event.type === 'surface.patch'
        ? event.event.patch.surfaceId
        : event.type === 'surface.presentation'
          ? event.event.surfaceId
          : undefined
    const duplicate =
      surfaceId !== undefined
        ? cursor <=
          ((event.type === 'surface.presentation'
            ? this.presentationCursors
            : this.patchCursors
          ).get(surfaceId) ?? -1)
        : order !== undefined && cursor <= (this.orderCursors.get(order.spaceId) ?? -1)
    if (duplicate) {
      this.cursor = Math.max(this.cursor, cursor)
      return true
    }
    if (
      event.type === 'surface.pinned' &&
      cursor < (this.pinCursors.get(event.event.surfaceId) ?? -1)
    )
      return false
    const result = applySurfaceStreamEvent(this.spaces, event)
    if (!result.applied) return false
    const freshnessId =
      surfaceId ?? (event.type === 'surface.pinned' ? event.event.surfaceId : undefined)
    const previous =
      freshnessId &&
      this.spaces.flatMap((space) => space.surfaces).find((surface) => surface.id === freshnessId)
    this.spaces = result.spaces.map((space) => ({
      ...space,
      surfaces: space.surfaces.map((surface) =>
        previous &&
        surface.id === freshnessId &&
        Math.max(
          this.patchCursors.get(freshnessId) ?? -1,
          this.presentationCursors.get(freshnessId) ?? -1,
          this.pinCursors.get(freshnessId) ?? -1,
        ) > cursor
          ? { ...surface, freshness: previous.freshness }
          : surface,
      ),
    }))
    this.cursor = Math.max(this.cursor, cursor)
    if (surfaceId !== undefined)
      (event.type === 'surface.presentation' ? this.presentationCursors : this.patchCursors).set(
        surfaceId,
        cursor,
      )
    if (order !== undefined) this.orderCursors.set(order.spaceId, cursor)
    if (event.type === 'surface.pinned') this.pinCursors.set(event.event.surfaceId, cursor)
    if (event.type === 'surface.created') this.patchCursors.set(event.event.surface.id, cursor)
    return true
  }

  confirmSurface(input: RenderableSurface, cursor?: number): boolean {
    const surface = RenderableSurfaceSchema.parse(input)
    if (
      cursor !== undefined &&
      cursor <= (this.patchCursors.get(surface.id) ?? -1) &&
      cursor <= (this.presentationCursors.get(surface.id) ?? -1) &&
      cursor <= (this.pinCursors.get(surface.id) ?? -1)
    )
      return false
    let found = false
    this.spaces = this.spaces.map((space) => ({
      ...space,
      surfaces: space.surfaces.map((current) => {
        if (current.id !== surface.id) return current
        found = true
        return cursor === undefined ? surface : this.mergeConfirmed(surface, cursor, current)
      }),
    }))
    if (found && cursor !== undefined) {
      this.patchCursors.set(surface.id, Math.max(cursor, this.patchCursors.get(surface.id) ?? -1))
      this.presentationCursors.set(
        surface.id,
        Math.max(cursor, this.presentationCursors.get(surface.id) ?? -1),
      )
      this.pinCursors.set(surface.id, Math.max(cursor, this.pinCursors.get(surface.id) ?? -1))
    }
    return found
  }

  confirmOrder(order: SurfaceOrder, surface?: RenderableSurface): boolean {
    if (order.cursor < (this.orderCursors.get(order.spaceId) ?? -1)) return true
    if (surface) this.confirmSurface(surface, order.cursor)
    const result = applySurfaceOrderToSpaces(this.spaces, order)
    if (!result.applied) return false
    this.spaces = result.spaces
    this.orderCursors.set(order.spaceId, order.cursor)
    return true
  }

  attention(frame: { spaceId: string; count: number; revision: number }): void {
    this.spaces = applySpaceAttention(this.spaces, frame)
  }

  private mergeConfirmed(
    surface: RenderableSurface,
    cursor: number,
    previous?: RenderableSurface,
  ): RenderableSurface {
    if (!previous) return surface
    const contentIsNewer = (this.patchCursors.get(surface.id) ?? -1) > cursor
    const presentationIsNewer = (this.presentationCursors.get(surface.id) ?? -1) > cursor
    const pinIsNewer = (this.pinCursors.get(surface.id) ?? -1) > cursor
    return {
      ...surface,
      ...(contentIsNewer ? { tree: previous.tree, state: previous.state } : {}),
      ...(presentationIsNewer ? { presentation: previous.presentation } : {}),
      ...(pinIsNewer ? { pinned: previous.pinned } : {}),
      ...(contentIsNewer || presentationIsNewer || pinIsNewer
        ? { freshness: previous.freshness }
        : {}),
    }
  }
}
