import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { ReflectionRunReport } from './reflection.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

/**
 * The per-Space "Nightly Reflection" Surface (issues/021-advanced-memory.md):
 * a browsable, always-visible report of the last nightly run — its window,
 * the summaries and insights it distilled, and how many facts it
 * consolidated or demoted. Atoms only (ARCHITECTURE.md §7 forbids
 * agent-generated markup in Surfaces; the catalog is closed), following
 * `heartbeat-surface.ts`'s daemon-owned, persisted-Surface idiom: pre-create
 * at boot, rebuild on every completed run. Unlike the Heartbeat's single
 * System-Space Surface, there is one of these per active, non-System Space,
 * mirroring `automations-surface.ts`'s per-Space id convention instead.
 */
export function reflectionSurfaceId(spaceSlug: string): string {
  return `srf-${spaceSlug}-reflection`
}

const CAPTION_NODE_ID = 'reflection-caption'
const STATS_NODE_ID = 'reflection-stats'
const CONTENT_NODE_ID = 'reflection-content'

function captionNode(report: ReflectionRunReport | undefined): AtomNode {
  const text =
    report === undefined
      ? 'No Reflection has run yet.'
      : `${report.windowFrom} → ${report.windowTo}`
  return { id: CAPTION_NODE_ID, type: 'Caption', props: { text } }
}

function stat(id: string, label: string, value: string): AtomNode {
  return { id, type: 'Stat', props: { label, value } }
}

function statsNode(report: ReflectionRunReport | undefined, low: number): AtomNode {
  return {
    id: STATS_NODE_ID,
    type: 'Row',
    children: [
      stat('stat-consolidated', 'Consolidated', report ? String(report.consolidated) : 'n/a'),
      stat('stat-demoted', 'Demoted', report ? String(report.demoted) : 'n/a'),
      stat(
        'stat-active-size',
        'Active vs budget',
        report ? `${report.activeSize}/${low}` : `n/a/${low}`,
      ),
    ],
  }
}

/**
 * The dynamic body: before the first run, a clear empty state; after a run
 * with an empty window, a distinct "nothing to distill" notice (still not
 * the pre-first-run empty state — a run did happen); otherwise one `Text`
 * per summary, then one `Text` per insight.
 */
function contentNode(report: ReflectionRunReport | undefined): AtomNode {
  if (!report) {
    return {
      id: CONTENT_NODE_ID,
      type: 'Box',
      children: [
        { id: 'reflection-empty', type: 'Caption', props: { text: 'No Reflection has run yet.' } },
      ],
    }
  }

  if (report.summaries.length === 0 && report.insights.length === 0) {
    return {
      id: CONTENT_NODE_ID,
      type: 'Box',
      children: [
        {
          id: 'reflection-nothing',
          type: 'Caption',
          props: { text: 'Nothing to distill from last night.' },
        },
      ],
    }
  }

  const children: AtomNode[] = [
    ...report.summaries.map((summary, index): AtomNode => ({
      id: `reflection-summary-${index + 1}`,
      type: 'Text',
      props: { text: summary },
    })),
    ...report.insights.map((insight, index): AtomNode => ({
      id: `reflection-insight-${index + 1}`,
      type: 'Text',
      props: { text: insight },
    })),
  ]
  return { id: CONTENT_NODE_ID, type: 'Box', children }
}

export function reflectionSurface(
  space: { id: string; slug: string },
  report: ReflectionRunReport | undefined,
  low: number,
  updatedAt: string,
): Surface {
  return SurfaceSchema.parse({
    id: reflectionSurfaceId(space.slug),
    spaceId: space.id,
    title: 'Nightly Reflection',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Nightly Reflection' } },
        captionNode(report),
        statsNode(report, low),
        contentNode(report),
      ],
    },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

/**
 * The slice of `Reflection` this manager depends on (structural, not a
 * direct import of the concrete class, same idiom as
 * `heartbeat-surface.ts`'s `HeartbeatSource`): a real `Reflection` instance
 * satisfies it as-is, and tests can supply a fake without standing up a
 * real Scheduler/MemoryIndex.
 */
export interface ReflectionSource {
  lastReport(spaceId: string): ReflectionRunReport | undefined
}

export interface ReflectionSurfaceManagerOptions {
  store: Store
  reflection: ReflectionSource
  /** The `low` budget watermark (`memory-config.ts`'s `MemoryConfig.budget.low`) shown against `activeSize`. */
  low: number
  now?: () => Date
}

/**
 * Projects the Reflection's own last-run report onto one Surface per
 * active, non-System Space, following the Heartbeat/allowlist/audit
 * managers' persisted-Surface pattern: pre-create at boot, rebuild on
 * request. Unlike `HeartbeatSurfaceManager` (one Surface, one Space), this
 * manager iterates every Space the way `Scheduler.ensureSurfaces` does for
 * the Automations Surface — the Reflection itself has no single "current"
 * Space to key off of.
 */
export class ReflectionSurfaceManager {
  private readonly store: Store
  private readonly reflection: ReflectionSource
  private readonly low: number
  private readonly now: () => Date

  constructor(options: ReflectionSurfaceManagerOptions) {
    this.store = options.store
    this.reflection = options.reflection
    this.low = options.low
    this.now = options.now ?? (() => new Date())
  }

  /** Pre-create every active, non-System Space's Reflection Surface (if missing). */
  start(): void {
    for (const space of this.store.listSpaces()) {
      if (space.id === SYSTEM_SPACE_ID) continue
      this.ensureSurface(space.id, space.slug)
    }
  }

  /**
   * Rebuilds one Space's Surface from the Reflection's latest report for
   * it. Bound as an instance property (not a prototype method), same as
   * `HeartbeatSurfaceManager.refresh`, so it can be wired directly as a
   * per-Space completion callback without losing `this`.
   */
  refresh = (spaceId: string): void => {
    const space = this.store.getSpace(spaceId)
    if (!space) return
    this.refreshSurface(space.id, space.slug)
  }

  dispose(): void {
    // No change-notification source of its own to unsubscribe from — this
    // manager is only ever driven by explicit `start()`/`refresh(spaceId)`
    // calls, the latter wired outside this module to the Reflection's own
    // per-Space completion, same as `HeartbeatSurfaceManager.dispose`.
  }

  private ensureSurface(spaceId: string, slug: string): void {
    if (!this.store.getSurface(reflectionSurfaceId(slug))) this.refreshSurface(spaceId, slug)
  }

  private refreshSurface(spaceId: string, slug: string): void {
    const report = this.reflection.lastReport(spaceId)
    const updatedAt = this.now().toISOString()
    const surfaceId = reflectionSurfaceId(slug)
    const existing = this.store.getSurface(surfaceId)

    if (!existing) {
      // Daemon-owned: the Reflection Surface must not be rewritable by the
      // Agent (ADR-0007's structural-defense contract), same as the
      // Heartbeat/allowlist/audit System-Space Surfaces.
      this.store.createSurface(
        reflectionSurface({ id: spaceId, slug }, report, this.low, updatedAt),
        'job',
        {
          daemonOwned: true,
        },
      )
      return
    }

    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return
    this.store.patchTree(
      surfaceId,
      [
        { target: 'tree', op: 'replace', path: '/children/1', value: captionNode(report) },
        { target: 'tree', op: 'replace', path: '/children/2', value: statsNode(report, this.low) },
        { target: 'tree', op: 'replace', path: '/children/3', value: contentNode(report) },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
    )
  }
}
