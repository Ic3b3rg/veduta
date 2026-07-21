/**
 * Pure platform-detection + copy for the notification onboarding bell
 * (issue 018, decision 16). No DOM API calls at module scope — callers pass
 * in `navigator.userAgent`, `isStandalone()`, and `pushSupported()` so this
 * stays unit-testable without a browser.
 */
export type PushPlatform = 'ready' | 'ios-needs-install' | 'unsupported'

/**
 * iOS detection is userAgent-based. iPadOS 13+ reports itself as macOS
 * Safari (with touch support) rather than "iPad", so a plain userAgent match
 * misses it; `maxTouchPoints > 1` on a "Macintosh" userAgent is the standard
 * signal for that masquerade (a real Mac reports 0). A Mac with an external
 * touchscreen reporting exactly 1 point is not expected in practice, so this
 * is treated as a real Mac, not iPadOS.
 */
const IOS_USER_AGENT_PATTERN = /iPhone|iPad|iPod/
const MACINTOSH_USER_AGENT_PATTERN = /Macintosh/

export function detectPushPlatform(input: {
  userAgent: string
  standalone: boolean
  pushSupported: boolean
  maxTouchPoints: number
}): PushPlatform {
  const isIpadMasqueradingAsMac =
    MACINTOSH_USER_AGENT_PATTERN.test(input.userAgent) && input.maxTouchPoints > 1
  const isIOS = IOS_USER_AGENT_PATTERN.test(input.userAgent) || isIpadMasqueradingAsMac

  // iOS Safari only exposes Web Push to a PWA installed to the Home Screen
  // (16.4+) — until then, no permission prompt exists to offer, so the
  // guided install sheet is the only path forward regardless of
  // `pushSupported` (a not-yet-installed iOS Safari never reports it).
  if (isIOS && !input.standalone) return 'ios-needs-install'

  if (!input.pushSupported) return 'unsupported'

  return 'ready'
}

export const IOS_INSTALL_STEPS: readonly string[] = [
  'Tap the Share button in Safari.',
  'Choose "Add to Home Screen".',
  'Open Veduta from the Home Screen icon.',
]

export const IOS_FALLBACK_COPY =
  "Without installing, updates appear as badges on the Home — nothing is lost, you just won't get push notifications."
