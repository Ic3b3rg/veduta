import type {
  AutomationOutcomeNotification,
  AutomationOutcomeNotificationLifecycleMessage,
} from '@veduta/protocol'
import type * as Api from './api.ts'

/** The runtime's focused-Space Automation notification projection. */
export class LiveNotificationProjection {
  notifications: AutomationOutcomeNotification[] = []
  pendingIds: string[] = []
  private spaceId: string | undefined
  private focusKey = ''
  private revision = -1
  private readonly notificationRevisions = new Map<string, number>()
  private generation = 0
  private connectionEpoch = 0
  private syncing = false
  private buffer: AutomationOutcomeNotificationLifecycleMessage[] = []

  constructor(
    private readonly owner: {
      api: Pick<
        typeof Api,
        | 'fetchAutomationOutcomeNotifications'
        | 'openAutomationOutcomeNotification'
        | 'dismissAutomationOutcomeNotification'
      >
      token: () => string | undefined
      publish: () => void
      failed: (error: unknown) => void
    },
  ) {}

  focus(spaceId: string | undefined, focusKey: string): boolean {
    this.focusKey = focusKey
    if (this.spaceId === spaceId) return false
    this.cancel()
    this.spaceId = spaceId
    this.revision = -1
    this.notificationRevisions.clear()
    this.notifications = []
    this.pendingIds = []
    return true
  }

  cancel(): void {
    this.generation += 1
    this.syncing = false
    this.buffer = []
  }

  beginConnection(): void {
    this.cancel()
    this.connectionEpoch += 1
    this.revision = -1
    this.notificationRevisions.clear()
    this.notifications = []
    this.pendingIds = []
  }

  accept(lifecycle: AutomationOutcomeNotificationLifecycleMessage): void {
    if (lifecycle.notification.spaceId !== this.spaceId) return
    if (this.syncing) {
      this.buffer.push(lifecycle)
      return
    }
    if (lifecycle.revision <= this.revision) return
    this.revision = lifecycle.revision
    this.apply(lifecycle.notification)
    this.owner.publish()
  }

  private apply(notification: AutomationOutcomeNotification): boolean {
    if (notification.revision < (this.notificationRevisions.get(notification.id) ?? -1))
      return false
    this.notificationRevisions.set(notification.id, notification.revision)
    this.revision = Math.max(this.revision, notification.revision)
    const next = this.notifications.filter((candidate) => candidate.id !== notification.id)
    if (notification.state === 'unread') next.push(notification)
    this.notifications = next.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    return true
  }

  async refresh(): Promise<void> {
    const spaceId = this.spaceId
    if (spaceId === undefined) return
    const generation = ++this.generation
    this.syncing = true
    this.buffer = []
    try {
      const snapshot = await this.owner.api.fetchAutomationOutcomeNotifications(
        spaceId,
        this.owner.token(),
      )
      if (generation !== this.generation) return
      if (snapshot.revision >= this.revision) {
        this.revision = snapshot.revision
        for (const notification of this.notifications)
          this.notificationRevisions.set(notification.id, snapshot.revision)
        for (const notification of snapshot.notifications)
          this.notificationRevisions.set(notification.id, notification.revision)
        this.notifications = snapshot.notifications
      }
    } catch (error) {
      if (generation !== this.generation) return
      this.owner.failed(error)
    }
    if (generation !== this.generation) return
    const buffered = this.buffer.sort((a, b) => a.revision - b.revision)
    this.buffer = []
    this.syncing = false
    for (const lifecycle of buffered) this.accept(lifecycle)
    this.owner.publish()
  }

  async act(
    notification: AutomationOutcomeNotification,
    action: 'open' | 'dismiss',
  ): Promise<string | undefined> {
    if (this.pendingIds.includes(notification.id)) return
    const epoch = this.connectionEpoch
    const focusKey = this.focusKey
    this.pendingIds = [...this.pendingIds, notification.id]
    this.owner.publish()
    try {
      const result = await (action === 'open'
        ? this.owner.api.openAutomationOutcomeNotification(
            notification.spaceId,
            notification.id,
            this.owner.token(),
          )
        : this.owner.api.dismissAutomationOutcomeNotification(
            notification.spaceId,
            notification.id,
            this.owner.token(),
          ))
      if (epoch !== this.connectionEpoch || notification.spaceId !== this.spaceId) return
      const accepted = this.apply(result.notification)
      if (
        accepted &&
        action === 'open' &&
        result.notification.state === 'opened' &&
        focusKey === this.focusKey
      )
        return result.notification.href
    } catch (error) {
      if (epoch === this.connectionEpoch) this.owner.failed(error)
    } finally {
      if (epoch === this.connectionEpoch) {
        this.pendingIds = this.pendingIds.filter((id) => id !== notification.id)
        this.owner.publish()
      }
    }
  }
}
