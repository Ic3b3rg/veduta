import type { AutomationOutcomeNotification } from '@veduta/protocol'
import { useId } from 'react'

export function SpaceAutomationOutcomeNotifications({
  notifications,
  pendingIds,
  onOpen,
  onDismiss,
}: {
  notifications: readonly AutomationOutcomeNotification[]
  pendingIds: ReadonlySet<string>
  onOpen: (notification: AutomationOutcomeNotification) => Promise<void> | void
  onDismiss: (notification: AutomationOutcomeNotification) => Promise<void> | void
}) {
  const headingId = useId()
  if (notifications.length === 0) return null

  return (
    <section className="automation-outcome-notifications" aria-labelledby={headingId}>
      <div className="automation-outcome-notifications-heading">
        <h2 id={headingId}>Automation updates</h2>
        <span>{notifications.length}</span>
      </div>
      <div className="automation-outcome-notification-list">
        {notifications.map((notification) => {
          const pending = pendingIds.has(notification.id)
          return (
            <article
              key={notification.id}
              className={`automation-outcome-notification ${notification.kind}`}
            >
              <div className="automation-outcome-notification-copy">
                <div className="automation-outcome-notification-meta">
                  <span>{kindLabel(notification.kind)}</span>
                  <time dateTime={notification.updatedAt}>
                    {updatedLabel(notification.updatedAt)}
                  </time>
                </div>
                <h3>{notification.title}</h3>
                <p>{notification.summary}</p>
                {notification.occurrenceCount > 1 && (
                  <span className="automation-outcome-notification-count">
                    {notification.occurrenceCount} occurrences
                  </span>
                )}
              </div>
              <div className="automation-outcome-notification-actions">
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Open Surface for ${notification.title}`}
                  onClick={() => void onOpen(notification)}
                >
                  Open Surface
                </button>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Dismiss ${notification.title}`}
                  onClick={() => void onDismiss(notification)}
                >
                  Dismiss
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function kindLabel(kind: AutomationOutcomeNotification['kind']): string {
  if (kind === 'failed') return 'Needs attention'
  if (kind === 'recovered') return 'Recovered'
  return 'Updated'
}

function updatedLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}
