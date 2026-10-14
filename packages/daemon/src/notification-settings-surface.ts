import { SurfaceSchema, type Surface, type PatchOperation } from '@veduta/protocol'
import {
  loadNotificationsConfig,
  resolveTimezone,
  type NotificationsConfig,
} from './notifications-config.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'

export const NOTIFICATION_SETTINGS_SURFACE_ID = 'srf-notifications'

export interface NotificationStatsSource {
  stats(): { queuedCount: number }
}

/** Notification status is daemon-owned living state, without daily interruption limits. */
export function notificationSettingsSurface(
  config: NotificationsConfig,
  stats: { queuedCount: number },
  updatedAt: string,
): Surface {
  return SurfaceSchema.parse({
    id: NOTIFICATION_SETTINGS_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Notifications',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Notifications' } },
        {
          id: 'subtitle',
          type: 'Caption',
          props: {
            text: config.quietHours
              ? `Quiet hours ${config.quietHours.start}–${config.quietHours.end} (${resolveTimezone(config)})`
              : 'Quiet hours off',
          },
        },
        {
          id: 'stat-queued',
          type: 'Stat',
          props: { label: 'Queued', value: String(stats.queuedCount) },
        },
      ],
    },
    state: {},
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

export interface NotificationSettingsSurfaceManagerOptions {
  store: Store
  source: NotificationStatsSource
  rootDir: string
  now?: () => Date
}

export class NotificationSettingsSurfaceManager {
  private readonly now: () => Date

  constructor(private readonly options: NotificationSettingsSurfaceManagerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    this.refresh()
  }

  refresh = (): void => {
    const { store, source, rootDir } = this.options
    const next = notificationSettingsSurface(
      loadNotificationsConfig(rootDir),
      source.stats(),
      this.now().toISOString(),
    )
    const existing = store.getSurface(NOTIFICATION_SETTINGS_SURFACE_ID)
    if (!existing) {
      store.createSurface(next, 'job', { daemonOwned: true })
      return
    }
    const version = store.getSurfaceVersion(NOTIFICATION_SETTINGS_SURFACE_ID)
    if (!version) return
    // Replace the tree before removing retired budget bindings on an existing installation.
    const operations: PatchOperation[] = [
      { target: 'tree', op: 'replace', path: '', value: next.tree },
      ...Object.keys(existing.state).map((key): PatchOperation => ({
        target: 'state',
        op: 'remove',
        path: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      })),
    ]
    store.patchDaemonSurface(NOTIFICATION_SETTINGS_SURFACE_ID, operations, {
      expectedTreeVersion: version.treeVersion,
    })
  }
}
