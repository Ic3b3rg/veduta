import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { TierUsage, UsageSnapshot } from './model-routing.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

const MAX_WORKER_ROWS = 10

/**
 * The "usage" Surface (issue #10, BYOK transparency): what the user's
 * keys spent today per tier, and per Worker. Declarative Atoms only.
 */
export function usageSurface(usage: UsageSnapshot, updatedAt: string): Surface {
  const pausedTiers = (['reasoning', 'triage'] as const).filter(
    (tier) => usage.tiers[tier].spentUsd > usage.tiers[tier].capUsd,
  )
  return SurfaceSchema.parse({
    id: 'srf-usage',
    spaceId: SYSTEM_SPACE_ID,
    title: 'Model usage',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Model usage' } },
        {
          id: 'subtitle',
          type: 'Caption',
          props: { text: `Your keys, your spend — ${usage.date} (UTC)` },
        },
        ...pausedBadge(pausedTiers),
        {
          id: 'tiers',
          type: 'Row',
          children: [
            statNode('reasoning', 'Reasoning', usage.tiers.reasoning),
            statNode('triage', 'Triage', usage.tiers.triage),
          ],
        },
        ...workerNodes(usage.workers),
      ],
    },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

function pausedBadge(pausedTiers: string[]): AtomNode[] {
  if (pausedTiers.length === 0) return []
  return [
    {
      id: 'proactivity-paused',
      type: 'Badge',
      props: {
        text: `Proactivity paused: daily ${pausedTiers.join(' and ')} cap reached`,
        tone: 'warning',
      },
    },
  ]
}

function statNode(key: string, label: string, tier: TierUsage): AtomNode {
  return {
    id: `stat-${key}`,
    type: 'Stat',
    props: { label, value: usd(tier.spentUsd), unit: `of ${usd(tier.capUsd)}/day` },
  }
}

function workerNodes(workers: UsageSnapshot['workers']): AtomNode[] {
  if (workers.length === 0) return []
  const top = [...workers].sort((left, right) => right.spentUsd - left.spentUsd)
  return [
    { id: 'workers-label', type: 'Label', props: { text: 'Workers' } },
    ...top.slice(0, MAX_WORKER_ROWS).map((worker, index) => ({
      id: `worker-${index + 1}-${slugify(worker.workerId)}`,
      type: 'Text' as const,
      props: { text: `${worker.workerId} — ${usd(worker.spentUsd)}` },
    })),
  ]
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'worker'
  )
}
