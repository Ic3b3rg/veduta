import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { HeartbeatMetrics } from './heartbeat.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

/**
 * The Heartbeat metrics Surface (issue #16, T5): today's sweep counts, the
 * "nothing-to-do" ratio (target >80% — the Heartbeat should mostly find
 * nothing to act on) and the average triage+reasoning cost per sweep, so a
 * user can see the daemon's own proactivity loop is actually running.
 * Declarative Atoms only (Title, Caption, Stat, Badge), same idiom as
 * `usage-surface.ts`. Lives in the System Space and is projected through
 * the Store — following the persisted create/patch/broadcast lifecycle of
 * `AllowlistSurfaceManager`/`AuditSurfaceManager`, NOT the synthetic
 * GET-time `appendSystemSurface` path — so it reaches clients through the
 * same central broadcast as any other Space Surface.
 */
export const HEARTBEAT_SURFACE_ID = 'srf-heartbeat'
const STATS_NODE_ID = 'heartbeat-stats'
const BADGE_SLOT_NODE_ID = 'heartbeat-badge-slot'

/** Target: the Heartbeat should find nothing to do >80% of the time. */
const NOTHING_RATIO_WARNING_THRESHOLD = 0.8

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function captionNode(metrics: HeartbeatMetrics): AtomNode {
  return { id: 'subtitle', type: 'Caption', props: { text: `${metrics.date} (UTC)` } }
}

function statsNode(metrics: HeartbeatMetrics): AtomNode {
  return {
    id: STATS_NODE_ID,
    type: 'Row',
    children: [
      {
        id: 'stat-sweeps',
        type: 'Stat',
        props: { label: 'Sweeps', value: String(metrics.sweeps) },
      },
      {
        id: 'stat-nothing-ratio',
        type: 'Stat',
        props: {
          label: 'Nothing-to-do',
          value: metrics.nothingRatio === null ? 'n/a' : percent(metrics.nothingRatio),
        },
      },
      {
        id: 'stat-avg-cost',
        type: 'Stat',
        props: {
          label: 'Avg cost/sweep',
          value: metrics.avgCostUsd === null ? 'unknown' : usd(metrics.avgCostUsd),
        },
      },
    ],
  }
}

/**
 * Below-target warning: only once there is at least one completed
 * (non-capped) sweep to judge — zero sweeps means "n/a", not a warning.
 */
function warningBadge(metrics: HeartbeatMetrics): AtomNode[] {
  if (
    metrics.sweeps === 0 ||
    metrics.nothingRatio === null ||
    metrics.nothingRatio > NOTHING_RATIO_WARNING_THRESHOLD
  ) {
    return []
  }
  return [
    {
      id: 'heartbeat-below-target',
      type: 'Badge',
      props: { text: 'Below 80% — timers or events may be missing', tone: 'warning' },
    },
  ]
}

/** Fixed slot (like the allowlist/audit empty-state Caption) so the Badge's presence never changes the tree's shape at this index. */
function badgeSlotNode(metrics: HeartbeatMetrics): AtomNode {
  return { id: BADGE_SLOT_NODE_ID, type: 'Box', children: warningBadge(metrics) }
}

export function heartbeatSurface(metrics: HeartbeatMetrics, updatedAt: string): Surface {
  return SurfaceSchema.parse({
    id: HEARTBEAT_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Heartbeat',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Heartbeat' } },
        captionNode(metrics),
        statsNode(metrics),
        badgeSlotNode(metrics),
      ],
    },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

/**
 * The slice of `Heartbeat` this manager depends on (structural, not a
 * direct import of the concrete class): a real `Heartbeat` instance
 * satisfies it as-is, and tests can supply a fake without standing up a
 * real Scheduler/ModelRouter.
 */
export interface HeartbeatSource {
  metrics(): HeartbeatMetrics
}

export interface HeartbeatSurfaceManagerOptions {
  store: Store
  heartbeat: HeartbeatSource
  now?: () => Date
}

/**
 * Projects the Heartbeat's own metrics onto `srf-heartbeat`, following the
 * allowlist/audit managers' persisted-Surface pattern: pre-create at boot,
 * rebuild whenever asked. Unlike the trust-layer managers, this one has no
 * change-notification source of its own to subscribe to — the Heartbeat
 * fires `onSwept` after each sweep, and the daemon wires that callback to
 * `refresh` (see server.ts, out of this module's scope), so there is
 * nothing to coalesce here.
 */
export class HeartbeatSurfaceManager {
  private readonly store: Store
  private readonly heartbeat: HeartbeatSource
  private readonly now: () => Date

  constructor(options: HeartbeatSurfaceManagerOptions) {
    this.store = options.store
    this.heartbeat = options.heartbeat
    this.now = options.now ?? (() => new Date())
  }

  /** Pre-create the Surface (if missing) from the Heartbeat's current metrics. */
  start(): void {
    this.ensureSurface()
  }

  /**
   * Rebuilds the Surface from the Heartbeat's latest metrics. Bound as an
   * instance property (not a prototype method) so it can be passed
   * directly as the Heartbeat's `onSwept` callback without losing `this`.
   */
  refresh = (): void => {
    this.refreshSurface()
  }

  dispose(): void {
    // No change-notification source of its own to unsubscribe from — this
    // manager is only ever driven by explicit `start()`/`refresh()` calls
    // (the latter wired to `heartbeat.onSwept` outside this module).
  }

  private ensureSurface(): void {
    if (!this.store.getSurface(HEARTBEAT_SURFACE_ID)) this.refreshSurface()
  }

  private refreshSurface(): void {
    const metrics = this.heartbeat.metrics()
    const updatedAt = this.now().toISOString()
    const existing = this.store.getSurface(HEARTBEAT_SURFACE_ID)

    if (!existing) {
      // Daemon-owned: the Heartbeat metrics Surface must not be rewritable
      // by the Agent (ADR-0007's structural-defense contract), same as the
      // usage/allowlist/audit System-Space Surfaces.
      this.store.createSurface(heartbeatSurface(metrics, updatedAt), 'job', { daemonOwned: true })
      return
    }

    const version = this.store.getSurfaceVersion(HEARTBEAT_SURFACE_ID)
    if (!version) return
    this.store.patchTree(
      HEARTBEAT_SURFACE_ID,
      [
        { target: 'tree', op: 'replace', path: '/children/1', value: captionNode(metrics) },
        { target: 'tree', op: 'replace', path: '/children/2', value: statsNode(metrics) },
        { target: 'tree', op: 'replace', path: '/children/3', value: badgeSlotNode(metrics) },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
    )
  }
}
