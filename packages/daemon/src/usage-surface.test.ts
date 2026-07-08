import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { UsageSnapshot } from './model-routing.ts'
import { usageSurface } from './usage-surface.ts'

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
    expect(reasoning?.props).toMatchObject({ label: 'Reasoning', value: '$2.00' })
    expect(triage?.props).toMatchObject({ label: 'Triage', value: '$0.25' })
  })

  it('shows the proactivity-paused badge only past a daily cap', () => {
    const within = usageSurface(snapshot(), updatedAt)
    expect(findNode(within.tree, 'proactivity-paused')).toBeUndefined()

    const past = usageSurface(
      snapshot({
        tiers: {
          triage: { spentUsd: 5.5, capUsd: 5 },
          reasoning: { spentUsd: 2, capUsd: 20 },
        },
      }),
      updatedAt,
    )
    const badge = findNode(past.tree, 'proactivity-paused')
    expect(badge?.type).toBe('Badge')
  })

  it('caps Worker rows to the top spenders with sanitized node ids', () => {
    const workers = Array.from({ length: 12 }, (_, index) => ({
      workerId: `wrk/research #${index + 1}`,
      spentUsd: index + 1,
    }))
    const surface = SurfaceSchema.parse(usageSurface(snapshot({ workers }), updatedAt))
    const rows = collectNodes(surface.tree).filter((node) => node.id.startsWith('worker-'))
    expect(rows).toHaveLength(10)
    for (const row of rows) expect(row.id).toMatch(/^worker-[a-z0-9-]+$/)
    expect(JSON.stringify(surface.tree)).toContain('wrk/research #12')
    expect(JSON.stringify(surface.tree)).not.toContain('wrk/research #2 —')
  })
})

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  return collectNodes(tree).find((node) => node.id === id)
}

function collectNodes(node: AtomNode): AtomNode[] {
  return [node, ...(node.children ?? []).flatMap(collectNodes)]
}
