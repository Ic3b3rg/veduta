import { describe, expect, it } from 'vitest'
import {
  assertFetchableUrl,
  describeUrl,
  MAX_REDIRECT_DEPTH,
  normalizeHost,
  resolveRedirect,
} from './fetch-policy.ts'

/**
 * `fetch-policy.ts` (issue #46, `docs/adr/0013-signed-self-update.md`): the
 * https/loopback and redirect rules shared by the feed fetch (WHATWG
 * `fetch`) and the artifact fetch (`node:http`/`node:https`). These tests
 * exercise the policy directly, with no network and no transport — the
 * point of pulling it out of `update-ports.ts` in the first place.
 */

describe('normalizeHost', () => {
  it('lowercases and strips IPv6 brackets', () => {
    expect(normalizeHost('GitHub.com')).toBe('github.com')
    expect(normalizeHost('[::1]')).toBe('::1')
    expect(normalizeHost('[2001:DB8::1]')).toBe('2001:db8::1')
  })
})

describe('assertFetchableUrl', () => {
  const cases: Array<{ name: string; url: string; ok: boolean }> = [
    { name: 'https on any host', url: 'https://github.com/a', ok: true },
    { name: 'http on loopback IPv4', url: 'http://127.0.0.1/x', ok: true },
    // update-ports.ts compared url.hostname to the literal '::1', but
    // WHATWG URL keeps the IPv6 bracket form in .hostname, so that
    // comparison never matched — this asserts the bracketed form works.
    { name: 'http on loopback IPv6 (bracketed)', url: 'http://[::1]/x', ok: true },
    { name: 'http on a non-loopback host', url: 'http://example.test/x', ok: false },
  ]

  for (const { name, url, ok } of cases) {
    it(`${ok ? 'accepts' : 'refuses'} ${name}`, () => {
      const run = () =>
        assertFetchableUrl(new URL(url), { what: 'artifact', pinnedHost: undefined })
      if (ok) {
        expect(run).not.toThrow()
      } else {
        expect(run).toThrow(/refusing a non-https URL from a non-loopback host/)
      }
    })
  }

  it('matches a pinned host case-insensitively', () => {
    expect(() =>
      assertFetchableUrl(new URL('https://GitHub.com/a'), {
        what: 'feed',
        pinnedHost: 'github.com',
      }),
    ).not.toThrow()
  })

  it('refuses a pinned-host mismatch', () => {
    expect(() =>
      assertFetchableUrl(new URL('https://evil.test/a'), {
        what: 'feed',
        pinnedHost: 'github.com',
      }),
    ).toThrow(/feed host 'evil\.test' does not match the pinned host 'github\.com'/)
  })
})

describe('resolveRedirect', () => {
  it('refuses at the depth cap', () => {
    expect(() =>
      resolveRedirect({
        current: new URL('https://github.com/a'),
        location: 'https://github.com/b',
        depth: MAX_REDIRECT_DEPTH,
        allowCrossHostRedirects: true,
      }),
    ).toThrow(/too many redirects fetching https:\/\/github\.com\/a/)
  })

  it('succeeds one hop below the depth cap', () => {
    const target = resolveRedirect({
      current: new URL('https://github.com/a'),
      location: 'https://github.com/b',
      depth: MAX_REDIRECT_DEPTH - 1,
      allowCrossHostRedirects: true,
    })
    expect(target.href).toBe('https://github.com/b')
  })

  it('refuses a malformed Location', () => {
    expect(() =>
      resolveRedirect({
        current: new URL('https://github.com/a'),
        location: 'http://[invalid',
        depth: 0,
        allowCrossHostRedirects: true,
      }),
    ).toThrow(/malformed redirect Location fetching https:\/\/github\.com\/a/)
  })

  it('resolves a relative Location against current', () => {
    const target = resolveRedirect({
      current: new URL('https://github.com/a/b'),
      location: '../c',
      depth: 0,
      allowCrossHostRedirects: false,
    })
    expect(target.href).toBe('https://github.com/c')
  })

  it('refuses an https -> http downgrade even when allowCrossHostRedirects is true', () => {
    expect(() =>
      resolveRedirect({
        current: new URL('https://github.com/a'),
        location: 'http://github.com/a',
        depth: 0,
        allowCrossHostRedirects: true,
      }),
    ).toThrow(
      /refusing an https -> http redirect: https:\/\/github\.com\/a -> http:\/\/github\.com\/a/,
    )
  })

  it('allows a loopback-http redirect to loopback-http (not a downgrade)', () => {
    const target = resolveRedirect({
      current: new URL('http://127.0.0.1/a'),
      location: 'http://127.0.0.1/b',
      depth: 0,
      allowCrossHostRedirects: false,
    })
    expect(target.href).toBe('http://127.0.0.1/b')
  })

  it('refuses a cross-host redirect when allowCrossHostRedirects is false', () => {
    expect(() =>
      resolveRedirect({
        current: new URL('https://github.com/a'),
        location: 'https://release-assets.githubusercontent.com/a',
        depth: 0,
        allowCrossHostRedirects: false,
      }),
    ).toThrow(
      /refusing a cross-host redirect: github\.com -> release-assets\.githubusercontent\.com/,
    )
  })

  it('accepts a cross-host https redirect when allowCrossHostRedirects is true', () => {
    const target = resolveRedirect({
      current: new URL('https://github.com/a'),
      location: 'https://release-assets.githubusercontent.com/a?sig=xyz',
      depth: 0,
      allowCrossHostRedirects: true,
    })
    expect(target.hostname).toBe('release-assets.githubusercontent.com')
  })

  it('treats a redirect from 127.0.0.1 to [::1] as cross-host', () => {
    expect(() =>
      resolveRedirect({
        current: new URL('http://127.0.0.1/a'),
        location: 'http://[::1]/a',
        depth: 0,
        allowCrossHostRedirects: false,
      }),
    ).toThrow(/refusing a cross-host redirect: 127\.0\.0\.1 -> ::1/)
  })

  it('refuses a loopback-http chain hopping to a plaintext external host even when allowCrossHostRedirects is true', () => {
    // The target-side `assertFetchableUrl` call is the only thing standing
    // between a local rehearsal feed (loopback http) and a redirect onto a
    // plaintext external host — `allowCrossHostRedirects` only waives the
    // same-host check, never the https-or-loopback one.
    expect(() =>
      resolveRedirect({
        current: new URL('http://127.0.0.1/a'),
        location: 'http://example.com/x',
        depth: 0,
        allowCrossHostRedirects: true,
      }),
    ).toThrow(/refusing a non-https URL from a non-loopback host/)
  })
})

describe('describeUrl', () => {
  it('keeps origin and pathname but drops the query string', () => {
    const url = new URL('https://release-assets.githubusercontent.com/a/b?sig=secret&jwt=token')
    expect(describeUrl(url)).toBe('https://release-assets.githubusercontent.com/a/b')
  })
})
