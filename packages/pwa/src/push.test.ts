import { describe, expect, it } from 'vitest'
import { isRelativePushUrl, urlBase64ToUint8Array } from './push.ts'

describe('urlBase64ToUint8Array', () => {
  it('decodes a known base64url vector ("Hello, World!")', () => {
    const bytes = urlBase64ToUint8Array('SGVsbG8sIFdvcmxkIQ')
    expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111, 44, 32, 87, 111, 114, 108, 100, 33])
  })

  it('round-trips arbitrary bytes through the base64url alphabet, including - and _', () => {
    // 0xfb 0xff encodes with both '-' and '_' in the base64url alphabet,
    // exercising the char substitutions the VAPID key format relies on.
    const original = new Uint8Array([0xfb, 0xff, 0x00, 0x10])
    const base64 = btoa(String.fromCharCode(...original))
    const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    expect(Array.from(urlBase64ToUint8Array(base64url))).toEqual(Array.from(original))
  })
})

describe('isRelativePushUrl', () => {
  it('accepts a same-origin relative path', () => {
    expect(isRelativePushUrl('/app/space/health/surface/srf-groceries')).toBe(true)
    expect(isRelativePushUrl('/')).toBe(true)
  })

  it('rejects a protocol-relative url', () => {
    expect(isRelativePushUrl('//evil.com/phish')).toBe(false)
  })

  it('rejects an absolute url', () => {
    expect(isRelativePushUrl('https://evil.com/phish')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isRelativePushUrl(undefined)).toBe(false)
    expect(isRelativePushUrl(null)).toBe(false)
    expect(isRelativePushUrl(42)).toBe(false)
  })

  it('rejects a backslash URL bypass ("new URL" treats \\ as /)', () => {
    expect(isRelativePushUrl('/\\evil.com/push')).toBe(false)
    expect(isRelativePushUrl('/a\\b')).toBe(false)
  })

  it('rejects a url containing ASCII control characters', () => {
    expect(isRelativePushUrl('/app/space\nhealth')).toBe(false)
    expect(isRelativePushUrl('/app/space\x00health')).toBe(false)
  })
})
