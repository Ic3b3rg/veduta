import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from './model-routing.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import {
  MODEL_USAGE_SURFACE_ID,
  type UsageSource,
  UsageSurfaceManager,
  usageSurface,
} from './usage-surface.ts'

const updatedAt = '2026-07-08T10:00:00.000Z'

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    date: '2026-07-08',
    tiers: {
      triage: { spentUsd: 0.25, capUsd: 5 },
      reasoning: { spentUsd: 2, capUsd: 20 },
    },
    workers: [],
    ...overrides,
  }
}

describe('usageSurface', () => {
  it('builds a protocol-valid System Surface with one Stat per tier', () => {
    const surface = SurfaceSchema.parse(usageSurface(snapshot(), updatedAt))
    expect(surface.id).toBe('srf-usage')
    expect(surface.spaceId).toBe('spc-system')
    expect(surface.freshness).toEqual({ updatedAt, updatedBy: 'system' })

    const reasoning = findNode(surface.tree, 'stat-reasoning')
    const triage = findNode(surface.tree, 'stat-triage')
    expect(reasoning?.type).toBe('Stat')
    expect(reasoning).toMatchObject({ binding: 'reasoning', props: { label: 'Reasoning' } })
    expect(triage).toMatchObject({ binding: 'triage', props: { label: 'Triage' } })
    expect(surface.state).toMatchObject({
      reasoning: '$2.00 of $20.00/day',
      triage: '$0.25 of $5.00/day',
      status: 'Current',
      lastSuccessfulAt: updatedAt,
    })
  })

  it('reports whether proactivity is active or paused by a daily cap', () => {
    const within = usageSurface(snapshot(), updatedAt)
    expect(within.state['proactivity']).toBe('Active')

    const past = usageSurface(
      snapshot({
        tiers: {
          triage: { spentUsd: 5.5, capUsd: 5 },
          reasoning: { spentUsd: 2, capUsd: 20 },
        },
      }),
      updatedAt,
    )
    expect(past.state['proactivity']).toBe('Paused: daily triage cap reached')
  })

  it('caps the bound Worker table to the top spenders', () => {
    const workers = Array.from({ length: 12 }, (_, index) => ({
      workerId: `wrk/research #${index + 1}`,
      spentUsd: index + 1,
    }))
    const surface = SurfaceSchema.parse(usageSurface(snapshot({ workers }), updatedAt))
    expect(surface.state['workers']).toHaveLength(10)
    expect(surface.state['workers']).toContainEqual({ worker: 'wrk/research #12', spend: '$12.00' })
    expect(surface.state['workers']).not.toContainEqual({
      worker: 'wrk/research #2',
      spend: '$2.00',
    })
  })
})

describe('UsageSurfaceManager', () => {
  it('materializes one persisted daemon-owned Model usage Surface at boot', () => {
    const now = () => new Date(updatedAt)
    const harness = createUsageManagerHarness({ now })
    const { manager, rootDir, store } = harness

    manager.start()

    expect(SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID))).toMatchObject({
      id: MODEL_USAGE_SURFACE_ID,
      spaceId: SYSTEM_SPACE_ID,
    })
    expect(store.isSurfaceDaemonOwned(MODEL_USAGE_SURFACE_ID)).toBe(true)
    expect(
      store
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === MODEL_USAGE_SURFACE_ID),
    ).toHaveLength(1)
    harness.close()

    const reopened = new Store({ rootDir, now })
    ensureSystemSpace(reopened.spacesEngine)
    expect(
      reopened
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === MODEL_USAGE_SURFACE_ID),
    ).toHaveLength(1)
    reopened.close()
  })

  it('refreshes persisted state through the normal Event and live-update lifecycle', () => {
    const now = () => new Date(updatedAt)
    const source = new MutableUsageSource(snapshot())
    const harness = createUsageManagerHarness({ now, source })
    const { manager, store } = harness
    manager.start()
    store.setPinned(MODEL_USAGE_SURFACE_ID, true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    const beforeEvents = store.eventLog(SYSTEM_SPACE_ID)
    const liveEvents: ReturnType<Store['surfaceEventsAfter']> = []
    const unsubscribe = store.onSurfaceEvent((event) => liveEvents.push(event))

    source.set(
      snapshot({
        tiers: {
          triage: { spentUsd: 0.25, capUsd: 5 },
          reasoning: { spentUsd: 3, capUsd: 20 },
        },
      }),
    )
    source.notify()

    const refreshed = SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID))
    expect(refreshed).toMatchObject({
      pinned: true,
      state: {
        reasoning: '$3.00 of $20.00/day',
        triage: '$0.25 of $5.00/day',
      },
    })
    expect(store.eventLog(SYSTEM_SPACE_ID).slice(beforeEvents.length)).toEqual([
      expect.objectContaining({
        type: 'surface.patch_state',
        origin: 'trusted:system',
        payload: { surfaceId: MODEL_USAGE_SURFACE_ID, operations: 1 },
      }),
    ])
    expect(liveEvents).toEqual([
      expect.objectContaining({
        kind: 'patch',
        event: expect.objectContaining({ spaceId: SYSTEM_SPACE_ID }),
      }),
    ])

    unsubscribe()
    harness.close()
  })

  it('keeps the last valid values visible through a source failure and repairs in place', () => {
    let clock = new Date(updatedAt)
    const now = () => clock
    const source = new MutableUsageSource(snapshot())
    const harness = createUsageManagerHarness({ now, source })
    const { manager, store } = harness
    manager.start()
    const beforeEvents = store.eventLog(SYSTEM_SPACE_ID).length

    clock = new Date('2026-07-08T10:05:00.000Z')
    source.set(new Error('provider credential must never be rendered'))
    expect(() => source.notify()).not.toThrow()

    const stale = SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID))
    expect(stale).toMatchObject({
      id: MODEL_USAGE_SURFACE_ID,
      state: {
        reasoning: '$2.00 of $20.00/day',
        status: 'Stale — usage source unavailable; showing last valid values',
        lastSuccessfulAt: updatedAt,
      },
    })
    expect(JSON.stringify(stale)).not.toContain('provider credential')

    clock = new Date('2026-07-08T10:10:00.000Z')
    source.set(
      snapshot({
        tiers: {
          triage: { spentUsd: 0.25, capUsd: 5 },
          reasoning: { spentUsd: 3, capUsd: 20 },
        },
      }),
    )
    source.notify()

    expect(SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID))).toMatchObject({
      id: MODEL_USAGE_SURFACE_ID,
      state: {
        reasoning: '$3.00 of $20.00/day',
        status: 'Current',
        lastSuccessfulAt: '2026-07-08T10:10:00.000Z',
      },
    })
    expect(store.eventLog(SYSTEM_SPACE_ID).slice(beforeEvents)).toEqual([
      expect.objectContaining({ type: 'surface.patch_state' }),
      expect.objectContaining({ type: 'surface.patch_state' }),
    ])

    harness.close()
  })

  it('refreshes the persisted Surface when the UTC usage day rolls over', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-08T23:59:59.900Z'))
      const now = () => new Date()
      const harness = createUsageManagerHarness({
        source: {
          usage: () => {
            const date = now().toISOString().slice(0, 10)
            return snapshot({
              date,
              tiers:
                date === '2026-07-08'
                  ? {
                      triage: { spentUsd: 0.25, capUsd: 5 },
                      reasoning: { spentUsd: 2, capUsd: 20 },
                    }
                  : {
                      triage: { spentUsd: 0, capUsd: 5 },
                      reasoning: { spentUsd: 0, capUsd: 20 },
                    },
            })
          },
          onUsageChange: () => () => {},
        },
        now,
      })
      const { manager, store } = harness
      manager.start()
      const beforeCursor = store.latestSurfaceCursor()

      await vi.advanceTimersByTimeAsync(200)

      expect(SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID)).state).toMatchObject({
        date: '2026-07-09',
        reasoning: '$0.00 of $20.00/day',
        triage: '$0.00 of $5.00/day',
      })
      expect(store.latestSurfaceCursor()).toBe(beforeCursor + 1)

      harness.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit duplicate semantic updates for equivalent refreshes', () => {
    let clock = new Date(updatedAt)
    const now = () => clock
    const source = new MutableUsageSource(snapshot())
    const harness = createUsageManagerHarness({ now, source })
    const { manager, store } = harness
    manager.start()
    const beforeCursor = store.latestSurfaceCursor()
    const beforeEvents = store.eventLog(SYSTEM_SPACE_ID)
    const lastSuccessfulAt = store.getSurface(MODEL_USAGE_SURFACE_ID)?.state['lastSuccessfulAt']

    clock = new Date('2026-07-08T11:00:00.000Z')
    source.notify()
    source.notify()
    manager.start()

    expect(store.latestSurfaceCursor()).toBe(beforeCursor)
    expect(store.eventLog(SYSTEM_SPACE_ID)).toEqual(beforeEvents)
    expect(store.getSurface(MODEL_USAGE_SURFACE_ID)?.state['lastSuccessfulAt']).toBe(
      lastSuccessfulAt,
    )
    expect(
      store
        .listSurfaces(SYSTEM_SPACE_ID)
        .filter((surface) => surface.id === MODEL_USAGE_SURFACE_ID),
    ).toHaveLength(1)

    clock = new Date('2026-07-08T12:00:00.000Z')
    source.set(new Error('temporary usage source failure'))
    source.notify()

    expect(store.getSurface(MODEL_USAGE_SURFACE_ID)?.state).toMatchObject({
      status: 'Stale — usage source unavailable; showing last valid values',
      lastSuccessfulAt: '2026-07-08T11:00:00.000Z',
    })

    harness.close()
  })

  it('refuses to adopt a daemon-owned identity collision outside the System Space', () => {
    expectUsageSurfaceIdentityCollisionRejected({ spaceId: 'spc-health', daemonOwned: true })
  })

  it('refuses to adopt a non-daemon-owned identity collision in the System Space', () => {
    expectUsageSurfaceIdentityCollisionRejected({ spaceId: SYSTEM_SPACE_ID, daemonOwned: false })
  })

  it('materializes an unavailable first-boot Surface and retries the source without a request', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(updatedAt))
      const now = () => new Date()
      const source = new MutableUsageSource(new Error('temporary usage source failure'))
      const harness = createUsageManagerHarness({ now, source })
      const { manager, store } = harness

      manager.start()

      expect(SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID)).state).toMatchObject({
        reasoning: 'Unavailable',
        status: 'Stale — usage source unavailable; showing last valid values',
        lastSuccessfulAt: 'No successful refresh yet',
      })

      source.set(snapshot())
      await vi.advanceTimersByTimeAsync(60_000)

      expect(SurfaceSchema.parse(store.getSurface(MODEL_USAGE_SURFACE_ID)).state).toMatchObject({
        reasoning: '$2.00 of $20.00/day',
        status: 'Current',
        lastSuccessfulAt: '2026-07-08T10:01:00.000Z',
      })
      expect(
        store
          .listSurfaces(SYSTEM_SPACE_ID)
          .filter((surface) => surface.id === MODEL_USAGE_SURFACE_ID),
      ).toHaveLength(1)

      harness.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  return collectNodes(tree).find((node) => node.id === id)
}

function collectNodes(node: AtomNode): AtomNode[] {
  return [node, ...(node.children ?? []).flatMap(collectNodes)]
}

class MutableUsageSource implements UsageSource {
  private current: UsageSnapshot | Error
  private listener = () => {}

  constructor(current: UsageSnapshot | Error) {
    this.current = current
  }

  usage(): UsageSnapshot {
    if (this.current instanceof Error) throw this.current
    return this.current
  }

  onUsageChange(listener: () => void): () => void {
    this.listener = listener
    return () => {
      this.listener = () => {}
    }
  }

  set(current: UsageSnapshot | Error): void {
    this.current = current
  }

  notify(): void {
    this.listener()
  }
}

function createUsageManagerHarness(options: { now?: () => Date; source?: UsageSource } = {}): {
  rootDir: string
  store: Store
  manager: UsageSurfaceManager
  close(): void
} {
  const now = options.now ?? (() => new Date(updatedAt))
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-usage-surface-'))
  const store = new Store({ rootDir, now })
  ensureSystemSpace(store.spacesEngine)
  const manager = new UsageSurfaceManager({
    store,
    source: options.source ?? new MutableUsageSource(snapshot()),
    now,
  })
  return {
    rootDir,
    store,
    manager,
    close() {
      manager.dispose()
      store.close()
    },
  }
}

function expectUsageSurfaceIdentityCollisionRejected(options: {
  spaceId: string
  daemonOwned: boolean
}): void {
  const now = () => new Date(updatedAt)
  let subscriptionActive = false
  const harness = createUsageManagerHarness({
    now,
    source: {
      usage: () => snapshot(),
      onUsageChange: () => {
        subscriptionActive = true
        return () => {
          subscriptionActive = false
        }
      },
    },
  })
  const { manager, store } = harness
  const impostor = SurfaceSchema.parse({
    ...usageSurface(snapshot(), updatedAt),
    spaceId: options.spaceId,
  })
  if (options.daemonOwned) {
    store.createSurface(impostor, 'job', { daemonOwned: true })
  } else {
    store.createSurface(impostor, 'job')
  }
  const beforeStart = store.getSurface(MODEL_USAGE_SURFACE_ID)

  try {
    expect(() => manager.start()).toThrow(/refusing to adopt Surface "srf-usage"/)
    expect(subscriptionActive).toBe(false)
    expect(store.getSurface(MODEL_USAGE_SURFACE_ID)).toEqual(beforeStart)
  } finally {
    harness.close()
  }
}
