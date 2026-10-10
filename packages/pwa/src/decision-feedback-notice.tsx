import { useEffect, useState } from 'react'
import type { PendingDecisionFeedbackView } from './pending-decision-state.ts'
import { ShellNotice } from './shell-notice.tsx'

const DISPLAY_MS = 8_000
const STORAGE_PREFIX = 'veduta.decision-feedback.'

interface NoticeVisibility {
  dismissed: boolean
  expiresAt: number | null
}

/** Local visibility only; the decision and its durable Chat entry remain daemon-owned. */
export function DecisionFeedbackNotice({
  feedback,
}: {
  feedback: PendingDecisionFeedbackView | undefined
}) {
  if (feedback === undefined) return null
  const noticeKey = JSON.stringify([
    feedback.id,
    feedback.state,
    feedback.resolvedAt,
    feedback.tone,
  ])
  return <LifecycleNotice key={noticeKey} noticeKey={noticeKey} feedback={feedback} />
}

function LifecycleNotice({
  noticeKey,
  feedback,
}: {
  noticeKey: string
  feedback: PendingDecisionFeedbackView
}) {
  const [visibility, setVisibility] = useState(() => readVisibility(noticeKey, feedback))

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_PREFIX + noticeKey, JSON.stringify(visibility))
    } catch {
      // Storage can be unavailable; in-memory dismissal still works for this mount.
    }
  }, [noticeKey, visibility])

  useEffect(() => {
    if (visibility.dismissed || visibility.expiresAt === null) return
    const timer = setTimeout(
      () => setVisibility((previous) => ({ ...previous, dismissed: true })),
      Math.max(0, visibility.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [visibility.dismissed, visibility.expiresAt])

  if (visibility.dismissed) return null

  return (
    <ShellNotice
      className={`pending-decision-feedback recipe-status ${feedback.state}`}
      data-tone={feedback.tone}
      data-decision-feedback-id={feedback.id}
      role="status"
      message={feedback.text}
      dismissLabel="Dismiss decision feedback"
      onDismiss={() => setVisibility((previous) => ({ ...previous, dismissed: true }))}
    />
  )
}

function readVisibility(
  noticeKey: string,
  feedback: PendingDecisionFeedbackView,
): NoticeVisibility {
  const now = Date.now()
  // A future server timestamp is bounded by first display, including after reload.
  let expiresAt =
    feedback.state === 'terminal' &&
    (feedback.tone === 'success' || feedback.tone === 'muted') &&
    feedback.resolvedAt !== undefined
      ? Math.min(now + DISPLAY_MS, Date.parse(feedback.resolvedAt) + DISPLAY_MS)
      : null
  let dismissed = false
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + noticeKey) ?? 'null')
    if (typeof stored === 'object' && stored !== null) {
      dismissed = 'dismissed' in stored && stored.dismissed === true
      if (
        expiresAt !== null &&
        'expiresAt' in stored &&
        typeof stored.expiresAt === 'number' &&
        Number.isFinite(stored.expiresAt)
      ) {
        expiresAt = Math.min(expiresAt, stored.expiresAt)
      }
    }
  } catch {
    // A corrupt or unavailable presentation cache does not affect canonical history.
  }
  return { dismissed: dismissed || (expiresAt !== null && expiresAt <= now), expiresAt }
}
