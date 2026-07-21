import { describe, expect, it } from 'vitest'
import {
  detectPushPlatform,
  IOS_FALLBACK_COPY,
  IOS_INSTALL_STEPS,
} from './notification-onboarding.ts'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

describe('detectPushPlatform', () => {
  it('iPhone Safari, not standalone -> ios-needs-install', () => {
    expect(
      detectPushPlatform({
        userAgent: IPHONE_SAFARI,
        standalone: false,
        pushSupported: false,
        maxTouchPoints: 5,
      }),
    ).toBe('ios-needs-install')
  })

  it('iPhone Safari, standalone, with push -> ready', () => {
    expect(
      detectPushPlatform({
        userAgent: IPHONE_SAFARI,
        standalone: true,
        pushSupported: true,
        maxTouchPoints: 5,
      }),
    ).toBe('ready')
  })

  it('iPhone Safari, standalone, without PushManager -> unsupported (older iOS, fallback applies)', () => {
    expect(
      detectPushPlatform({
        userAgent: IPHONE_SAFARI,
        standalone: true,
        pushSupported: false,
        maxTouchPoints: 5,
      }),
    ).toBe('unsupported')
  })

  it('desktop Chrome, with push -> ready', () => {
    expect(
      detectPushPlatform({
        userAgent: DESKTOP_CHROME,
        standalone: false,
        pushSupported: true,
        maxTouchPoints: 0,
      }),
    ).toBe('ready')
  })

  it('desktop Chrome, without push -> unsupported', () => {
    expect(
      detectPushPlatform({
        userAgent: DESKTOP_CHROME,
        standalone: false,
        pushSupported: false,
        maxTouchPoints: 0,
      }),
    ).toBe('unsupported')
  })

  it('iPad masquerading as macOS Safari (Macintosh UA + touch), not standalone -> ios-needs-install', () => {
    expect(
      detectPushPlatform({
        userAgent: DESKTOP_CHROME,
        standalone: false,
        pushSupported: false,
        maxTouchPoints: 5,
      }),
    ).toBe('ios-needs-install')
  })

  it('real Mac (Macintosh UA, no touch), with push -> ready', () => {
    expect(
      detectPushPlatform({
        userAgent: DESKTOP_CHROME,
        standalone: false,
        pushSupported: true,
        maxTouchPoints: 0,
      }),
    ).toBe('ready')
  })
})

describe('onboarding copy', () => {
  it('has a stable, non-empty set of install steps', () => {
    expect(IOS_INSTALL_STEPS.length).toBe(3)
    for (const step of IOS_INSTALL_STEPS) {
      expect(step.length).toBeGreaterThan(0)
    }
  })

  it('has non-empty fallback copy', () => {
    expect(IOS_FALLBACK_COPY.length).toBeGreaterThan(0)
  })
})
