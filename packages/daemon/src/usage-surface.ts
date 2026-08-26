import { SurfaceSchema, type JsonValue, type PatchOperation, type Surface } from '@veduta/protocol'
import type { TierUsage, UsageSnapshot } from './model-routing.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

const MAX_WORKER_ROWS = 10
const SOURCE_RETRY_MS = 60_000
const CURRENT_STATUS = 'Current'
const STALE_STATUS = 'Stale — usage source unavailable; showing last valid values'
export const MODEL_USAGE_SURFACE_ID = 'srf-usage'

/**
 * The "Model usage" Surface (issue #10, BYOK transparency): what the
 * user's keys spent today per tier and per Worker. Its Atom composition is
 * fixed; living values are state bindings so a user Pin never blocks the
 * daemon-owned refresh lifecycle.
 */
export function usageSurface(usage: UsageSnapshot, lastSuccessfulAt: string): Surface {
  return SurfaceSchema.parse({
    id: MODEL_USAGE_SURFACE_ID,
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
          props: { text: 'Your keys, your spend — daily totals use UTC.' },
        },
        {
          id: 'usage-totals',
          type: 'Row',
          children: [
            { id: 'stat-date', type: 'Stat', binding: 'date', props: { label: 'Usage day' } },
            {
              id: 'stat-reasoning',
              type: 'Stat',
              binding: 'reasoning',
              props: { label: 'Reasoning' },
            },
            {
              id: 'stat-triage',
              type: 'Stat',
              binding: 'triage',
              props: { label: 'Triage' },
            },
          ],
        },
        {
          id: 'usage-health',
          type: 'Row',
          children: [
            {
              id: 'stat-status',
              type: 'Stat',
              binding: 'status',
              props: { label: 'Status' },
            },
            {
              id: 'stat-last-success',
              type: 'Stat',
              binding: 'lastSuccessfulAt',
              props: { label: 'Last successful refresh' },
            },
            {
              id: 'stat-proactivity',
              type: 'Stat',
              binding: 'proactivity',
              props: { label: 'Proactivity' },
            },
          ],
        },
        { id: 'workers-label', type: 'Label', props: { text: 'Workers' } },
        {
          id: 'workers',
          type: 'Table',
          binding: 'workers',
          props: { columns: ['worker', 'spend'] },
        },
      ],
    },
    state: usageState(usage, CURRENT_STATUS, lastSuccessfulAt),
    freshness: { updatedAt: lastSuccessfulAt, updatedBy: 'system' },
  })
}

export interface UsageSource {
  usage(): UsageSnapshot
  onUsageChange(listener: () => void): () => void
}

export interface UsageSurfaceManagerOptions {
  store: Store
  source: UsageSource
  now?: () => Date
}

export class UsageSurfaceManager {
  private readonly store: Store
  private readonly source: UsageSource
  private readonly now: () => Date
  private disposeChange: (() => void) | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private lastSuccessfulAt: string | undefined

  constructor(options: UsageSurfaceManagerOptions) {
    this.store = options.store
    this.source = options.source
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.disposeChange) return
    this.disposeChange = this.source.onUsageChange(this.refresh)
    try {
      this.refresh()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  refresh = (): void => {
    const sourceAvailable = this.refreshSurface()
    this.scheduleRefresh(
      sourceAvailable ? millisecondsUntilNextUtcDay(this.now()) : SOURCE_RETRY_MS,
    )
  }

  dispose(): void {
    this.disposeChange?.()
    this.disposeChange = undefined
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private refreshSurface(): boolean {
    const refreshedAt = this.now().toISOString()
    let usage: UsageSnapshot
    try {
      usage = this.source.usage()
    } catch {
      this.markStale(refreshedAt)
      return false
    }
    const next = usageSurface(usage, refreshedAt)
    const existing = this.store.getSurface(MODEL_USAGE_SURFACE_ID)

    if (!existing) {
      this.store.createSurface(next, 'job', { daemonOwned: true })
      this.lastSuccessfulAt = refreshedAt
      return true
    }
    this.requireCanonicalSurface(existing)

    const semanticOps = statePatchOperations(existing.state, next.state, ['lastSuccessfulAt'])
    if (semanticOps.length > 0) {
      const operations = statePatchOperations(existing.state, next.state)
      this.store.patchState(MODEL_USAGE_SURFACE_ID, operations, { updatedBy: 'job' })
    }
    this.lastSuccessfulAt = refreshedAt
    return true
  }

  private markStale(failedAt: string): void {
    const existing = this.store.getSurface(MODEL_USAGE_SURFACE_ID)
    if (!existing) {
      this.store.createSurface(unavailableUsageSurface(failedAt), 'job', { daemonOwned: true })
      return
    }
    this.requireCanonicalSurface(existing)
    const persistedLastSuccess = existing.state['lastSuccessfulAt']
    const staleState: Record<string, JsonValue> = {
      ...existing.state,
      status: STALE_STATUS,
    }
    const lastSuccessfulAt = this.lastSuccessfulAt ?? persistedLastSuccess
    if (typeof lastSuccessfulAt === 'string') staleState['lastSuccessfulAt'] = lastSuccessfulAt
    const operations = statePatchOperations(existing.state, staleState)
    if (operations.length === 0) return
    this.store.patchState(MODEL_USAGE_SURFACE_ID, operations, { updatedBy: 'job' })
  }

  private requireCanonicalSurface(surface: Surface): void {
    if (
      surface.spaceId === SYSTEM_SPACE_ID &&
      this.store.isSurfaceDaemonOwned(MODEL_USAGE_SURFACE_ID)
    ) {
      return
    }
    throw new Error(
      `model usage surface: refusing to adopt Surface "${MODEL_USAGE_SURFACE_ID}"; ` +
        'expected a daemon-owned Surface in the canonical System Space',
    )
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(this.refresh, delayMs)
    this.refreshTimer.unref?.()
  }
}

function unavailableUsageSurface(failedAt: string): Surface {
  const surface = usageSurface(
    {
      date: failedAt.slice(0, 10),
      tiers: {
        triage: { spentUsd: 0, capUsd: 0 },
        reasoning: { spentUsd: 0, capUsd: 0 },
      },
      workers: [],
    },
    failedAt,
  )
  return SurfaceSchema.parse({
    ...surface,
    state: {
      ...surface.state,
      date: 'Unavailable',
      reasoning: 'Unavailable',
      triage: 'Unavailable',
      status: STALE_STATUS,
      lastSuccessfulAt: 'No successful refresh yet',
      proactivity: 'Unknown',
    },
  })
}

function usageState(
  usage: UsageSnapshot,
  status: string,
  lastSuccessfulAt: string,
): Record<string, JsonValue> {
  const pausedTiers = (['reasoning', 'triage'] as const).filter(
    (tier) => usage.tiers[tier].spentUsd > usage.tiers[tier].capUsd,
  )
  const workers = [...usage.workers]
    .sort((left, right) => right.spentUsd - left.spentUsd)
    .slice(0, MAX_WORKER_ROWS)
    .map((worker) => ({ worker: worker.workerId, spend: usd(worker.spentUsd) }))
  return {
    date: usage.date,
    reasoning: tierTotal(usage.tiers.reasoning),
    triage: tierTotal(usage.tiers.triage),
    status,
    lastSuccessfulAt,
    proactivity:
      pausedTiers.length === 0
        ? 'Active'
        : `Paused: daily ${pausedTiers.join(' and ')} cap reached`,
    workers,
  }
}

function statePatchOperations(
  current: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
  ignoredKeys: string[] = [],
): PatchOperation[] {
  const ignored = new Set(ignoredKeys)
  return Object.entries(next).flatMap(([key, value]) => {
    if (ignored.has(key) || jsonEqual(current[key], value)) return []
    return [
      {
        target: 'state' as const,
        op: Object.prototype.hasOwnProperty.call(current, key)
          ? ('replace' as const)
          : ('add' as const),
        path: `/${key}`,
        value,
      },
    ]
  })
}

function tierTotal(tier: TierUsage): string {
  return `${usd(tier.spentUsd)} of ${usd(tier.capUsd)}/day`
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function millisecondsUntilNextUtcDay(now: Date): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, nextDay - now.getTime())
}
