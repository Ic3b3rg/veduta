import {
  SurfaceSchema,
  type AtomNode,
  type JsonValue,
  type PatchOperation,
  type Space,
  type Surface,
} from '@veduta/protocol'
import {
  budgetFor,
  loadNotificationsConfig,
  resolveTimezone,
  saveNotificationsConfig,
  type NotificationsConfig,
} from './notifications-config.ts'
import type { FastMutationNotice, Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

/**
 * The Notification settings Surface (issue #18, plan v2 decision 13):
 * quiet-hours window, timezone and queued-push count, then one Row per
 * user Space with a budget Select, "sent today" and "degraded today"
 * Stats. Same daemon-owned, persisted System-Space Surface idiom as
 * `heartbeat-surface.ts` — pre-created at boot, rebuilt on demand — but
 * unlike the Heartbeat metrics Surface this one also *writes back*: the
 * budget Select is a fast action, handled here via `store.onFastMutation`
 * (the same mechanism `ApprovalSurfaceManager` uses for Approve/Reject
 * clicks), which persists a per-Space override to `notifications.json`.
 */
export const NOTIFICATION_SETTINGS_SURFACE_ID = 'srf-notifications'

const CAPTION_NODE_ID = 'subtitle'
const QUEUED_STAT_NODE_ID = 'stat-queued'
const ROWS_BOX_NODE_ID = 'notif-rows'

/** Offered daily push budgets (plan v2 decision 13). */
const BUDGET_OPTIONS = ['0', '1', '3', '5', '10'] as const

const BUDGET_STATE_KEY_PREFIX = 'notif-budget:'

function budgetStateKey(spaceId: string): string {
  return `${BUDGET_STATE_KEY_PREFIX}${spaceId}`
}

/** Inverse of `budgetStateKey`: recovers the target Space id from a fast-mutation's stateKey. */
function spaceIdFromBudgetStateKey(stateKey: string): string | undefined {
  return stateKey.startsWith(BUDGET_STATE_KEY_PREFIX)
    ? stateKey.slice(BUDGET_STATE_KEY_PREFIX.length)
    : undefined
}

/**
 * The options to render (and to accept back) for a Space's budget Select.
 * If the Space's current override isn't one of the standard choices, it is
 * appended so the control never lies about the Space's actual budget.
 */
function budgetOptionsFor(current: number): string[] {
  const currentText = String(current)
  return (BUDGET_OPTIONS as readonly string[]).includes(currentText)
    ? [...BUDGET_OPTIONS]
    : [...BUDGET_OPTIONS, currentText]
}

function quietHoursCaptionText(config: NotificationsConfig): string {
  if (!config.quietHours) return 'Quiet hours off'
  return `Quiet hours ${config.quietHours.start}–${config.quietHours.end} (${resolveTimezone(config)})`
}

function titleNode(): AtomNode {
  return { id: 'title', type: 'Title', props: { text: 'Notifications' } }
}

function captionNode(config: NotificationsConfig): AtomNode {
  return { id: CAPTION_NODE_ID, type: 'Caption', props: { text: quietHoursCaptionText(config) } }
}

/**
 * Structural slice of `NotificationCenter`'s stats this manager depends on
 * (the `HeartbeatSource` pattern in `heartbeat-surface.ts`): declared
 * locally rather than imported so this module never depends on
 * `notification-center.ts`. A real `NotificationCenter` satisfies this
 * as-is; tests supply a fake.
 */
export interface NotificationStats {
  queuedCount: number
  perSpace: Array<{ spaceId: string; sentToday: number; degradedToday: number }>
}

export interface NotificationStatsSource {
  stats(): NotificationStats
}

function statsFor(
  stats: NotificationStats,
  spaceId: string,
): { sentToday: number; degradedToday: number } {
  const entry = stats.perSpace.find((candidate) => candidate.spaceId === spaceId)
  return entry
    ? { sentToday: entry.sentToday, degradedToday: entry.degradedToday }
    : { sentToday: 0, degradedToday: 0 }
}

function queuedStatNode(stats: NotificationStats): AtomNode {
  return {
    id: QUEUED_STAT_NODE_ID,
    type: 'Stat',
    props: { label: 'Queued', value: String(stats.queuedCount) },
  }
}

function spaceRowNode(
  space: Space,
  config: NotificationsConfig,
  stats: NotificationStats,
): AtomNode {
  const stateKey = budgetStateKey(space.id)
  const current = budgetFor(config, space.id)
  const spaceStats = statsFor(stats, space.id)
  return {
    id: `notif-row-${space.id}`,
    type: 'Row',
    children: [
      { id: `notif-label-${space.id}`, type: 'Label', props: { text: space.name } },
      {
        id: `notif-budget-${space.id}`,
        type: 'Select',
        binding: stateKey,
        props: { label: 'Daily push budget', options: budgetOptionsFor(current) },
        actions: [{ name: 'change', path: 'fast', stateKey, payload: {} }],
      },
      {
        id: `notif-sent-${space.id}`,
        type: 'Stat',
        props: { label: 'Sent today', value: String(spaceStats.sentToday) },
      },
      {
        id: `notif-degraded-${space.id}`,
        type: 'Stat',
        props: { label: 'Degraded today', value: String(spaceStats.degradedToday) },
      },
    ],
  }
}

function spaceRowNodes(
  spaces: Space[],
  config: NotificationsConfig,
  stats: NotificationStats,
): AtomNode[] {
  return spaces
    .filter((space) => space.id !== SYSTEM_SPACE_ID)
    .map((space) => spaceRowNode(space, config, stats))
}

/** The one child whose shape (not just contents) varies across refreshes — the Space row count changes as Spaces are created/removed. Always patched as a single `replace` at its fixed index (see `refreshSurface`), never diffed. */
function rowsBoxNode(
  spaces: Space[],
  config: NotificationsConfig,
  stats: NotificationStats,
): AtomNode {
  return { id: ROWS_BOX_NODE_ID, type: 'Box', children: spaceRowNodes(spaces, config, stats) }
}

/**
 * Fixed four-child shape: Title, Caption (quiet hours), Stat (queued),
 * Box (one Row per user Space). The index of each child never changes
 * across refreshes, which is what lets `refreshSurface` patch each one by
 * a fixed `/children/N` path instead of diffing the tree.
 */
function notificationsChildren(
  spaces: Space[],
  config: NotificationsConfig,
  stats: NotificationStats,
): AtomNode[] {
  return [
    titleNode(),
    captionNode(config),
    queuedStatNode(stats),
    rowsBoxNode(spaces, config, stats),
  ]
}

function notificationsState(
  spaces: Space[],
  config: NotificationsConfig,
): Record<string, JsonValue> {
  const state: Record<string, JsonValue> = {}
  for (const space of spaces) {
    if (space.id === SYSTEM_SPACE_ID) continue
    state[budgetStateKey(space.id)] = String(budgetFor(config, space.id))
  }
  return state
}

export function notificationSettingsSurface(
  spaces: Space[],
  config: NotificationsConfig,
  stats: NotificationStats,
  updatedAt: string,
): Surface {
  return SurfaceSchema.parse({
    id: NOTIFICATION_SETTINGS_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Notifications',
    tree: {
      id: 'root',
      type: 'Box',
      children: notificationsChildren(spaces, config, stats),
    },
    state: notificationsState(spaces, config),
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

function statePointer(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

/**
 * Add/replace ops for every key `nextState` needs, computed against what's
 * already persisted. Never removes a key — callers must apply this
 * *before* the tree patch that may bind a new Space's row to one of these
 * keys (see `refreshSurface`): `SurfaceSchema` (packages/protocol/src/surface.ts)
 * rejects any tree node whose `binding` isn't already a Surface state key,
 * so the key has to exist first.
 */
function upsertStateOps(
  existingState: Record<string, JsonValue>,
  nextState: Record<string, JsonValue>,
): PatchOperation[] {
  const ops: PatchOperation[] = []
  for (const [key, value] of Object.entries(nextState)) {
    if (!Object.prototype.hasOwnProperty.call(existingState, key)) {
      ops.push({ target: 'state', op: 'add', path: statePointer(key), value })
    } else if (JSON.stringify(existingState[key]) !== JSON.stringify(value)) {
      ops.push({ target: 'state', op: 'replace', path: statePointer(key), value })
    }
  }
  return ops
}

/**
 * Remove ops for keys no longer needed (their Space was deleted, or
 * otherwise dropped out of `nextState`). Unlike `upsertStateOps`, this is
 * safe to apply only *after* the tree patch that stops binding to them —
 * unused state keys are legal, but a tree node with a dangling `binding`
 * is not.
 */
function staleStateOps(
  existingState: Record<string, JsonValue>,
  nextState: Record<string, JsonValue>,
): PatchOperation[] {
  const ops: PatchOperation[] = []
  for (const key of Object.keys(existingState)) {
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) {
      ops.push({ target: 'state', op: 'remove', path: statePointer(key) })
    }
  }
  return ops
}

export interface NotificationSettingsSurfaceManagerOptions {
  store: Store
  source: NotificationStatsSource
  rootDir: string
  onConfigChanged?: (config: NotificationsConfig) => void
  now?: () => Date
}

/**
 * Projects notification stats + config onto `srf-notifications`, following
 * the allowlist/heartbeat managers' persisted-Surface pattern: pre-create
 * at boot, rebuild whenever asked. Also the write side: it listens for
 * fast-path budget-Select clicks (`store.onFastMutation`, the same wiring
 * `ApprovalSurfaceManager` uses for Approve/Reject) and turns a valid one
 * into a persisted `notifications.json` override, notifying the caller
 * (`onConfigChanged`, wired to `NotificationCenter.updateConfig` outside
 * this module) before refreshing.
 */
export class NotificationSettingsSurfaceManager {
  private readonly store: Store
  private readonly source: NotificationStatsSource
  private readonly rootDir: string
  private readonly onConfigChanged: ((config: NotificationsConfig) => void) | undefined
  private readonly now: () => Date
  private readonly unsubscribe: () => void

  constructor(options: NotificationSettingsSurfaceManagerOptions) {
    this.store = options.store
    this.source = options.source
    this.rootDir = options.rootDir
    this.onConfigChanged = options.onConfigChanged
    this.now = options.now ?? (() => new Date())
    this.unsubscribe = this.store.onFastMutation((notice) => this.handleFastMutation(notice))
  }

  /**
   * Ensures the Surface reflects the current config + stats: creates it on
   * first boot, and unconditionally rebuilds it if it already exists (e.g.
   * a daemon restart), so a stale on-disk Surface from a previous process
   * never lingers in front of a user. Accepted staleness: if the daemon
   * happens to be down exactly at a day rollover, the "sent/degraded
   * today" counters can lag by one cycle until the next stats change
   * drives `refresh()` — a dedicated midnight timer was reviewed and
   * rejected as scope creep for issue #18.
   */
  start(): void {
    this.refreshSurface()
  }

  /**
   * Rebuilds the Surface from the latest stats + config. Bound as an
   * instance property (not a prototype method) so it can be passed
   * directly as `NotificationCenter`'s `onStats` callback without losing
   * `this` (mirrors `HeartbeatSurfaceManager.refresh`).
   */
  refresh = (): void => {
    this.refreshSurface()
  }

  dispose(): void {
    this.unsubscribe()
  }

  private userSpaces(): Space[] {
    return this.store.listSpaces().filter((space) => space.id !== SYSTEM_SPACE_ID)
  }

  private refreshSurface(): void {
    const config = loadNotificationsConfig(this.rootDir)
    const stats = this.source.stats()
    const spaces = this.userSpaces()
    const updatedAt = this.now().toISOString()
    const existing = this.store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)

    if (!existing) {
      // Daemon-owned: the Notification settings Surface must not be
      // rewritable by the Agent (ADR-0007's structural-defense contract),
      // same as heartbeat/allowlist/audit.
      this.store.createSurface(
        notificationSettingsSurface(spaces, config, stats, updatedAt),
        'job',
        { daemonOwned: true },
      )
      return
    }

    const nextState = notificationsState(spaces, config)

    // Ordering matters: a newly-created Space's row carries a brand-new
    // `notif-budget:<id>` binding, and `SurfaceSchema` (packages/protocol
    // /src/surface.ts) rejects any Surface where a tree node's `binding`
    // doesn't already exist in Surface state. So new/changed keys must be
    // committed to state *before* the tree patch that references them —
    // stale-key removal, by contrast, must wait until *after* the rows Box
    // has stopped binding to them.
    const upsertOps = upsertStateOps(existing.state, nextState)
    if (upsertOps.length > 0) {
      this.store.patchState(NOTIFICATION_SETTINGS_SURFACE_ID, upsertOps, { updatedBy: 'job' })
    }

    const version = this.store.getSurfaceVersion(NOTIFICATION_SETTINGS_SURFACE_ID)
    if (version) {
      this.store.patchTree(
        NOTIFICATION_SETTINGS_SURFACE_ID,
        [
          { target: 'tree', op: 'replace', path: '/children/1', value: captionNode(config) },
          { target: 'tree', op: 'replace', path: '/children/2', value: queuedStatNode(stats) },
          {
            target: 'tree',
            op: 'replace',
            path: '/children/3',
            value: rowsBoxNode(spaces, config, stats),
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
      )
    }

    const removeOps = staleStateOps(existing.state, nextState)
    if (removeOps.length > 0) {
      this.store.patchState(NOTIFICATION_SETTINGS_SURFACE_ID, removeOps, { updatedBy: 'job' })
    }
  }

  private handleFastMutation(notice: FastMutationNotice): void {
    if (notice.surfaceId !== NOTIFICATION_SETTINGS_SURFACE_ID) return
    const spaceId = spaceIdFromBudgetStateKey(notice.stateKey)
    if (spaceId === undefined) return

    // The generic fast-path mechanism (`SurfaceEngine.applyFastAction`) has
    // already written `notice.value` into the Surface's state by the time
    // this observer runs — an invalid value must be reverted, not merely
    // declined, or the Select would show a choice the daemon never
    // accepted. `refreshSurface()` recomputes state from the persisted
    // config, snapping the control back to the truthful value.
    if (typeof notice.value !== 'string') {
      // Never log `notice.value` itself: it comes from the client and may
      // not be a safe/expected shape to print.
      console.warn(
        `notification-settings-surface: ignoring non-string value for stateKey "${notice.stateKey}"`,
      )
      this.refreshSurface()
      return
    }

    const config = loadNotificationsConfig(this.rootDir)
    const offered = budgetOptionsFor(budgetFor(config, spaceId))
    if (!offered.includes(notice.value)) {
      // Log only the stateKey and that the value was rejected — never the
      // value itself (client-controlled input; log hygiene).
      console.warn(
        `notification-settings-surface: ignoring invalid budget value for stateKey "${notice.stateKey}"`,
      )
      this.refreshSurface()
      return
    }

    const budget = Number.parseInt(notice.value, 10)
    const nextConfig: NotificationsConfig = {
      ...config,
      spaceBudgets: { ...config.spaceBudgets, [spaceId]: budget },
    }
    saveNotificationsConfig(this.rootDir, nextConfig)
    this.onConfigChanged?.(nextConfig)
    this.refreshSurface()
  }
}
