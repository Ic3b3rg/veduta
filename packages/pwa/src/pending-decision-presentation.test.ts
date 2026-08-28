import type { PendingDecision, Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import { presentPendingDecisions } from './pending-decision-presentation.ts'

describe('presentPendingDecisions', () => {
  it('builds ordered global, exact Space, count, and Review-path projections together', () => {
    const assigned = decision('approval:assigned', 'spc-health', 'srf-health-decision')
    const globalDecision = decision('space-proposal:global')
    const archived = decision('approval:archived', 'spc-archive', 'srf-archive-decision')
    const terminal = {
      ...decision('approval:terminal', 'spc-health', 'srf-health-decision'),
      state: 'terminal' as const,
      outcome: 'rejected' as const,
      resolvedAt: '2026-08-28T10:05:00.000Z',
      resolvedBy: 'trusted:user' as const,
    }
    const health = space('spc-health', 'health', false, [
      surface('srf-health-decision', 'spc-health'),
    ])
    const archive = space('spc-archive', 'archive', true, [
      surface('srf-archive-decision', 'spc-archive'),
    ])

    const presentation = presentPendingDecisions(
      [globalDecision, assigned, archived, terminal],
      [health, archive],
    )

    expect(presentation.globalNotifications.map(({ decision: item }) => item.id)).toEqual([
      globalDecision.id,
      assigned.id,
      archived.id,
    ])
    expect(presentation.globalNotifications.map(({ reviewPath }) => reviewPath)).toEqual([
      undefined,
      '/app/space/health/surface/srf-health-decision',
      undefined,
    ])
    expect(
      presentation.notificationsBySpaceId.get(health.id)?.map(({ decision: item }) => item.id),
    ).toEqual([assigned.id])
    expect(presentation.notificationsBySpaceId.has(archive.id)).toBe(false)
    expect(presentation.countsBySpaceId).toEqual(new Map([[health.id, 1]]))
    expect(presentation.reviewPaths).toEqual(
      new Map([[assigned.id, '/app/space/health/surface/srf-health-decision']]),
    )
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

function space(
  id: string,
  slug: string,
  archived: boolean,
  surfaces: Surface[],
): SpaceWithSurfaces {
  return {
    id,
    slug,
    name: slug,
    archived,
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
