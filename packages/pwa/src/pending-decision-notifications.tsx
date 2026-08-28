import type { PendingDecision, PendingDecisionResolution } from '@veduta/protocol'
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PendingDecisionNotification } from './pending-decision-presentation.ts'

export type { PendingDecisionNotification } from './pending-decision-presentation.ts'

interface PendingDecisionPresentationProps {
  notifications: readonly PendingDecisionNotification[]
  resolvingDecisionIds: ReadonlySet<string>
  onResolve: (decisionId: string, resolution: PendingDecisionResolution) => Promise<void> | void
  onDismiss: (decisionId: string) => void
}

export function PendingDecisionStrip({
  notifications,
  resolvingDecisionIds,
  onResolve,
  onDismiss,
}: PendingDecisionPresentationProps) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  if (notifications.length === 0) return null

  const label = pendingDecisionCountLabel(notifications.length)
  return (
    <section className="pending-decision-strip" aria-label="Pending decisions">
      <button
        type="button"
        className="pending-decision-strip-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{label}</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <PendingDecisionList
          id={contentId}
          notifications={notifications}
          resolvingDecisionIds={resolvingDecisionIds}
          onResolve={onResolve}
          onDismiss={onDismiss}
        />
      )}
    </section>
  )
}

export function SpacePendingDecisionNotifications({
  notifications,
  resolvingDecisionIds,
  onResolve,
  onDismiss,
}: PendingDecisionPresentationProps) {
  const headingId = useId()
  if (notifications.length === 0) return null

  return (
    <section className="space-pending-decisions" aria-labelledby={headingId}>
      <div className="space-pending-decisions-heading">
        <h2 id={headingId}>Pending decisions</h2>
        <span>{notifications.length}</span>
      </div>
      <PendingDecisionList
        notifications={notifications}
        resolvingDecisionIds={resolvingDecisionIds}
        onResolve={onResolve}
        onDismiss={onDismiss}
      />
    </section>
  )
}

export function PendingDecisionControls({
  decision,
  reviewPath,
  resolving,
  onResolve,
  onDismiss,
}: {
  decision: PendingDecision
  reviewPath?: string
  resolving: boolean
  onResolve: (decisionId: string, resolution: PendingDecisionResolution) => Promise<void> | void
  onDismiss: (decisionId: string) => void
}) {
  return (
    <div className="pending-decision-actions">
      {decision.allowedResolutions.map((resolution) => (
        <button
          key={resolution}
          type="button"
          disabled={resolving}
          aria-label={`${resolutionLabel(resolution)} ${decision.summary}`}
          onClick={() => void onResolve(decision.id, resolution)}
        >
          {resolutionLabel(resolution)}
        </button>
      ))}
      {reviewPath === undefined ? (
        <span className="pending-decision-review-unavailable">
          Review is available when its Decision Surface arrives.
        </span>
      ) : (
        <Link to={reviewPath} aria-label={`Review ${decision.summary}`}>
          Review
        </Link>
      )}
      <button
        type="button"
        aria-label={`Dismiss ${decision.summary}`}
        onClick={() => onDismiss(decision.id)}
      >
        Dismiss
      </button>
    </div>
  )
}

function PendingDecisionNotificationCard({
  notification,
  resolving,
  onResolve,
  onDismiss,
}: {
  notification: PendingDecisionNotification
  resolving: boolean
  onResolve: PendingDecisionPresentationProps['onResolve']
  onDismiss: PendingDecisionPresentationProps['onDismiss']
}) {
  return (
    <article className="pending-decision-notification" aria-label={notification.decision.summary}>
      <p>{notification.decision.summary}</p>
      <PendingDecisionControls
        decision={notification.decision}
        {...(notification.reviewPath === undefined ? {} : { reviewPath: notification.reviewPath })}
        resolving={resolving}
        onResolve={onResolve}
        onDismiss={onDismiss}
      />
    </article>
  )
}

function PendingDecisionList({
  id,
  notifications,
  resolvingDecisionIds,
  onResolve,
  onDismiss,
}: PendingDecisionPresentationProps & { id?: string }) {
  return (
    <div {...(id === undefined ? {} : { id })} className="pending-decision-list">
      {notifications.map((notification) => (
        <PendingDecisionNotificationCard
          key={notification.decision.id}
          notification={notification}
          resolving={resolvingDecisionIds.has(notification.decision.id)}
          onResolve={onResolve}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  )
}

function pendingDecisionCountLabel(count: number): string {
  return count === 1 ? '1 decision awaits review' : `${count} decisions await review`
}

function resolutionLabel(resolution: PendingDecisionResolution): string {
  return `${resolution.charAt(0).toUpperCase()}${resolution.slice(1).replaceAll('-', ' ')}`
}
