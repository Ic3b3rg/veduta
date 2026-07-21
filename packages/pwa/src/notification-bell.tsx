import { useEffect, useState } from 'react'
import {
  detectPushPlatform,
  IOS_FALLBACK_COPY,
  IOS_INSTALL_STEPS,
} from './notification-onboarding.ts'
import { NOTIF_BELL_DISMISSED_KEY, isStandalone } from './pwa-storage.ts'
import { enablePush, pushSupported, type EnablePushResult } from './push.ts'

// Header affordance for issue 018 decision 16: an "Enable notifications"
// bell that either subscribes directly (desktop/Android, or iOS already
// installed to the Home Screen) or, on iOS Safari not yet installed,
// opens a small guided sheet pointing at Add to Home Screen.
export function NotificationBell({ token }: { token: string | undefined }) {
  const [granted, setGranted] = useState(
    () => 'Notification' in window && Notification.permission === 'granted',
  )
  // Permission granted is not the same as "has a live subscription": the
  // daemon's push store can be reset, or a prior subscribe attempt can have
  // failed after the permission prompt, leaving a browser that will never
  // prompt again yet also never receives a push. Assume subscribed until
  // the mount effect below confirms otherwise, so the common case (granted
  // and subscribed) hides the bell without a flash of the enable flow.
  const [hasSubscription, setHasSubscription] = useState(true)
  const [dismissedGuide, setDismissedGuide] = useState(
    () => localStorage.getItem(NOTIF_BELL_DISMISSED_KEY) === '1',
  )
  const [showGuide, setShowGuide] = useState(false)
  const [status, setStatus] = useState<EnablePushResult | null>(null)

  useEffect(() => {
    if (!granted) return
    if (!('serviceWorker' in navigator)) return
    let cancelled = false

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) setHasSubscription(subscription != null)
      })
      .catch(() => {
        if (!cancelled) setHasSubscription(false)
      })

    return () => {
      cancelled = true
    }
  }, [granted])

  // Re-evaluated on every render (cheap, synchronous, no DOM calls beyond
  // reading a few properties): a Home Screen relaunch after the guided
  // install is a fresh page load, so this naturally re-runs on mount and
  // flips from 'ios-needs-install' to 'ready' once the PWA is standalone —
  // that re-check on next launch IS the verification step for decision 16.
  const platform = detectPushPlatform({
    userAgent: navigator.userAgent,
    standalone: isStandalone(),
    pushSupported: pushSupported(),
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  })

  if ((granted && hasSubscription) || platform === 'unsupported') return null
  // The dismiss button only ever appears on the iOS install-guide sheet, so
  // it only ever suppresses that sheet — once the platform genuinely becomes
  // 'ready' (installed + push-capable), the enable flow is a new offer, not
  // a repeat of the install nudge the user dismissed.
  if (platform === 'ios-needs-install' && dismissedGuide) return null

  if (platform === 'ios-needs-install') {
    const dismiss = () => {
      localStorage.setItem(NOTIF_BELL_DISMISSED_KEY, '1')
      setDismissedGuide(true)
    }

    return (
      <div className="notif-bell">
        <button
          type="button"
          className="notif-bell-button"
          onClick={() => setShowGuide((prev) => !prev)}
        >
          Enable notifications
        </button>
        {showGuide && (
          <div
            className="notif-guide"
            role="dialog"
            aria-label="Install Veduta to enable notifications"
          >
            <ol>
              {IOS_INSTALL_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="notif-guide-fallback">{IOS_FALLBACK_COPY}</p>
            <button type="button" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    )
  }

  const onEnable = async () => {
    const result = await enablePush(token ?? null)
    setStatus(result)
    if (result === 'subscribed') {
      setGranted(true)
      setHasSubscription(true)
    }
  }

  return (
    <div className="notif-bell">
      <button type="button" className="notif-bell-button" onClick={() => void onEnable()}>
        Enable notifications
      </button>
      {status === 'denied' && (
        <p className="notif-bell-note">Notifications are blocked in the browser settings.</p>
      )}
      {status === 'error' && <p className="notif-bell-note">Couldn't enable — try again.</p>}
    </div>
  )
}
