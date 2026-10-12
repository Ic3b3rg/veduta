import { useEffect, useState } from 'react'
import { Button } from '@veduta/catalog/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@veduta/catalog/ui/popover'
import { Bell, X } from 'lucide-react'
import {
  detectPushPlatform,
  IOS_FALLBACK_COPY,
  IOS_INSTALL_STEPS,
} from './notification-onboarding.ts'
import { NOTIF_BELL_DISMISSED_KEY, isStandalone } from './pwa-storage.ts'
import { enablePush, pushSupported, type EnablePushResult } from './push.ts'

// Permission feedback and iOS guidance share the catalog overlay so neither
// participates in the navbar's layout (issue #242).
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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
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
  // that re-check on next launch IS the verification step.
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

  const onEnable = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await enablePush(token ?? null)
      setStatus(result)
      if (result === 'subscribed') {
        setGranted(true)
        setHasSubscription(true)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          className="notif-bell-button recipe-control utility-control"
          aria-label="Enable notifications"
          title="Enable notifications"
          onClick={() => {
            if (!open && !busy && platform === 'ready') void onEnable()
          }}
        >
          <Bell aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="notification-popover"
        aria-label={
          platform === 'ios-needs-install'
            ? 'Install Veduta to enable notifications'
            : 'Notifications'
        }
      >
        <div className="notification-popover-heading">
          <h2>Notifications</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="recipe-control"
            aria-label="Dismiss notification notice"
            title="Dismiss notification notice"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        {platform === 'ios-needs-install' ? (
          <>
            <ol>
              {IOS_INSTALL_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p>{IOS_FALLBACK_COPY}</p>
            <Button
              variant="outline"
              onClick={() => {
                localStorage.setItem(NOTIF_BELL_DISMISSED_KEY, '1')
                setDismissedGuide(true)
              }}
            >
              Dismiss installation guide
            </Button>
          </>
        ) : (
          <>
            <div role="status" aria-live="polite">
              {busy && <p>Enabling notifications…</p>}
              {status === 'denied' && (
                <>
                  <p>Notifications are blocked in the browser settings.</p>
                  <p>Allow notifications for this site in your browser, then try again.</p>
                </>
              )}
              {status === 'dismissed' && (
                <p>Notifications are not enabled. You can try again whenever you are ready.</p>
              )}
              {status === 'error' && <p>Couldn't enable notifications. Try again.</p>}
              {status === 'unsupported' && (
                <p>Push notifications are not available in this browser.</p>
              )}
            </div>
            {!busy && status !== null && status !== 'unsupported' && (
              <Button variant="outline" onClick={() => void onEnable()}>
                Try again
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
