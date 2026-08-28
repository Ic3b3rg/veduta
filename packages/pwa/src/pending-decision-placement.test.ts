import type { PendingDecision, Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import { placePendingDecisions } from './pending-decision-placement.ts'

describe('Pending-decision placement', () => {
  it('attributes each pending decision once only when its Space and Decision Surface agree', () => {
    const health = space('spc-health', 'health', [surface('srf-health-decision', 'spc-health')])
    const work = space('spc-work', 'work', [surface('srf-work-decision', 'spc-work')])
    const assigned = decision('approval:assigned', 'spc-health', 'srf-health-decision')
    const missingSurface = decision('approval:missing', 'spc-health', 'srf-not-yet-rendered')
    const mismatchedSurface = decision('approval:mismatched', 'spc-health', 'srf-work-decision')
    const globalDecision = decision('space-proposal:global')
    const terminal = {
      ...decision('approval:terminal', 'spc-health', 'srf-health-decision'),
      state: 'terminal' as const,
      outcome: 'rejected' as const,
      resolvedAt: '2026-08-28T10:05:00.000Z',
      resolvedBy: 'trusted:user' as const,
    }

    const placement = placePendingDecisions(
      [assigned, missingSurface, mismatchedSurface, globalDecision, terminal],
      [health, work],
    )

    expect(placement.pending.map(({ id }) => id)).toEqual([
      assigned.id,
      missingSurface.id,
      mismatchedSurface.id,
      globalDecision.id,
    ])
    expect(
      placement.assigned.map(({ decision: candidate, space }) => [candidate.id, space.id]),
    ).toEqual([[assigned.id, health.id]])
    expect(placement.unassigned.map(({ id }) => id)).toEqual([
      missingSurface.id,
      mismatchedSurface.id,
      globalDecision.id,
    ])
  })
})

function decision(id: string, spaceId?: string, decisionSurfaceId?: string): PendingDecision {
  return {
    id,
    kind: id.startsWith('space-proposal:') ? 'space-proposal' : 'approval',
    summary: id,
    scope: spaceId === undefined ? { type: 'global' } : { type: 'space', spaceId },
    allowedResolutions: id.startsWith('space-proposal:')
      ? ['accept', 'reject']
      : ['approve', 'reject'],
    state: 'pending',
    ...(decisionSurfaceId === undefined ? {} : { decisionSurfaceId }),
    createdAt: '2026-08-28T10:00:00.000Z',
  }
}

function space(id: string, slug: string, surfaces: Surface[]): SpaceWithSurfaces {
  return {
    id,
    slug,
    name: slug,
    archived: false,
    attention: 0,
    attentionRevision: 0,
    surfaces,
  }
}

function surface(id: string, spaceId: string): Surface {
  return {
    id,
    spaceId,
    title: id,
    tree: { id: `${id}-root`, type: 'Text', props: { text: id } },
    state: {},
    freshness: { updatedAt: '2026-08-28T10:00:00.000Z', updatedBy: 'agent' },
    pinned: false,
    pinnable: true,
  }
}
