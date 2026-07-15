import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import type { HeartbeatMetrics } from './heartbeat.ts'
import {
  HEARTBEAT_SURFACE_ID,
  HeartbeatSurfaceManager,
  heartbeatSurface,
  type HeartbeatSource,
} from './heartbeat-surface.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'

const updatedAt = '2026-07-14T06:00:00.000Z'

function metrics(overrides: Partial<HeartbeatMetrics> = {}): HeartbeatMetrics {
  return fromPartial<HeartbeatMetrics>({
    date: '2026-07-14',
    sweeps: 0,
    nothing: 0,
    acted: 0,
    nothingRatio: null,
    avgCostUsd: null,
    ...overrides,
  })
}

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  return collectNodes(tree).find((node) => node.id === id)
}

function collectNodes(node: AtomNode): AtomNode[] {
  return [node, ...(node.children ?? []).flatMap(collectNodes)]
}

/** Minimal fake standing in for `Heartbeat` (structural `HeartbeatSource`). */
class FakeHeartbeat implements HeartbeatSource {
  current: HeartbeatMetrics

  constructor(initial: HeartbeatMetrics) {
    this.current = initial
  }

  metrics(): HeartbeatMetrics {
    return this.current
  }
}

describe('heartbeatSurface', () => {
  it('builds a protocol-valid System Surface', () => {
    const surface = SurfaceSchema.parse(heartbeatSurface(metrics(), updatedAt))
    expect(surface.id).toBe(HEARTBEAT_SURFACE_ID)
    expect(surface.spaceId).toBe('spc-system')
    expect(surface.title).toBe('Heartbeat')
    expect(surface.freshness).toEqual({ updatedAt, updatedBy: 'system' })
  })

  it('renders "n/a" and "unknown" and no warning Badge at zero sweeps', () => {
    const surface = heartbeatSurface(metrics(), updatedAt)

    expect(findNode(surface.tree, 'stat-sweeps')?.props).toMatchObject({ value: '0' })
    expect(findNode(surface.tree, 'stat-nothing-ratio')?.props).toMatchObject({ value: 'n/a' })
    expect(findNode(surface.tree, 'stat-avg-cost')?.props).toMatchObject({ value: 'unknown' })
    expect(findNode(surface.tree, 'heartbeat-below-target')).toBeUndefined()
  })

  it('renders the sweep count, percentage and cost once there is data', () => {
    const surface = heartbeatSurface(
      metrics({ sweeps: 10, nothing: 9, acted: 1, nothingRatio: 0.9, avgCostUsd: 0.0234 }),
      updatedAt,
    )

    expect(findNode(surface.tree, 'stat-sweeps')?.props).toMatchObject({ value: '10' })
    expect(findNode(surface.tree, 'stat-nothing-ratio')?.props).toMatchObject({ value: '90%' })
    expect(findNode(surface.tree, 'stat-avg-cost')?.props).toMatchObject({ value: '$0.02' })
  })

  it('shows the warning Badge when nothingRatio <= 0.8 and sweeps > 0', () => {
    const surface = heartbeatSurface(
      metrics({ sweeps: 5, nothing: 4, acted: 1, nothingRatio: 0.8 }),
      updatedAt,
    )
    const badge = findNode(surface.tree, 'heartbeat-below-target')
    expect(badge?.type).toBe('Badge')
    expect(badge?.props).toMatchObject({
      text: 'Below 80% — timers or events may be missing',
      tone: 'warning',
    })
  })

  it('hides the warning Badge when nothingRatio > 0.8', () => {
    const surface = heartbeatSurface(
      metrics({ sweeps: 5, nothing: 5, acted: 0, nothingRatio: 1 }),
      updatedAt,
    )
    expect(findNode(surface.tree, 'heartbeat-below-target')).toBeUndefined()
  })

  it('hides the warning Badge at zero sweeps even if nothingRatio were somehow set', () => {
    const surface = heartbeatSurface(metrics({ sweeps: 0, nothingRatio: 0.1 }), updatedAt)
    expect(findNode(surface.tree, 'heartbeat-below-target')).toBeUndefined()
  })
})

describe('HeartbeatSurfaceManager', () => {
  it('pre-creates the Surface at boot from the current metrics', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const heartbeat = new FakeHeartbeat(
      metrics({ sweeps: 3, nothing: 3, acted: 0, nothingRatio: 1 }),
    )

    new HeartbeatSurfaceManager({ store, heartbeat }).start()

    const surface = store.getSurface(HEARTBEAT_SURFACE_ID)
    expect(surface).toBeDefined()
    expect(findNode(surface!.tree, 'stat-sweeps')?.props).toMatchObject({ value: '3' })
  })

  it('refresh() rebuilds the Surface from the latest metrics', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const heartbeat = new FakeHeartbeat(metrics())
    const manager = new HeartbeatSurfaceManager({ store, heartbeat })
    manager.start()

    heartbeat.current = metrics({ sweeps: 8, nothing: 5, acted: 3, nothingRatio: 5 / 8 })
    manager.refresh()

    const surface = store.getSurface(HEARTBEAT_SURFACE_ID)
    expect(findNode(surface!.tree, 'stat-sweeps')?.props).toMatchObject({ value: '8' })
    expect(findNode(surface!.tree, 'stat-nothing-ratio')?.props).toMatchObject({ value: '63%' })
    expect(findNode(surface!.tree, 'heartbeat-below-target')?.type).toBe('Badge')
  })

  it('refresh() is suitable to pass directly as onSwept without losing `this`', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const heartbeat = new FakeHeartbeat(metrics())
    const manager = new HeartbeatSurfaceManager({ store, heartbeat })
    manager.start()

    const onSwept: () => void = manager.refresh
    heartbeat.current = metrics({ sweeps: 1, nothing: 1, acted: 0, nothingRatio: 1 })
    onSwept()

    const surface = store.getSurface(HEARTBEAT_SURFACE_ID)
    expect(findNode(surface!.tree, 'stat-sweeps')?.props).toMatchObject({ value: '1' })
  })
})
