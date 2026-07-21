import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebPushError } from 'web-push'
import {
  ALLOWED_PUSH_HOSTS,
  WebPushTransport,
  ensureVapidKeys,
  isAllowedPushEndpoint,
  type VapidConfig,
} from './web-push-transport.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-vapid-'))
  return rootDir
}

describe('ensureVapidKeys', () => {
  it('generates a keypair on first call and persists it', () => {
    const dir = freshRoot()
    const keys = ensureVapidKeys(dir)
    expect(keys.publicKey.length).toBeGreaterThan(0)
    expect(keys.privateKey.length).toBeGreaterThan(0)
    const onDisk = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'))
    expect(onDisk).toEqual(keys)
  })

  it('is idempotent: a second call returns identical keys', () => {
    const dir = freshRoot()
    const first = ensureVapidKeys(dir)
    const second = ensureVapidKeys(dir)
    expect(second).toEqual(first)
  })

  it('writes vapid.json with mode 0600', () => {
    const dir = freshRoot()
    ensureVapidKeys(dir)
    // Windows does not honor POSIX permission bits; this check is meaningless there.
    if (platform() === 'win32') return
    const mode = statSync(join(dir, 'vapid.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('re-asserts mode 0600 on a pre-existing vapid.json restored with permissive permissions', () => {
    const dir = freshRoot()
    const path = join(dir, 'vapid.json')
    const preExisting: VapidConfig = {
      publicKey: 'restored-public',
      privateKey: 'restored-private',
      subject: 'mailto:restored@veduta.local',
    }
    writeFileSync(path, JSON.stringify(preExisting), { mode: 0o644 })
    // Windows does not honor POSIX permission bits; this check is meaningless there.
    if (platform() === 'win32') return
    expect(statSync(path).mode & 0o777).toBe(0o644)

    const loaded = ensureVapidKeys(dir)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loaded).toEqual(preExisting)
  })

  it('defaults the subject to the placeholder mailto when VEDUTA_ACME_EMAIL is unset', () => {
    const dir = freshRoot()
    const keys = ensureVapidKeys(dir, {})
    expect(keys.subject).toBe('mailto:admin@veduta.local')
  })

  it('honors VEDUTA_ACME_EMAIL for the subject', () => {
    const dir = freshRoot()
    const keys = ensureVapidKeys(dir, { VEDUTA_ACME_EMAIL: 'ops@example.com' })
    expect(keys.subject).toBe('mailto:ops@example.com')
  })
})

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc123',
    'https://foo.push.services.mozilla.com/wpush/v2/abc',
    'https://bar.notify.windows.com/w/abc',
  ])('allows %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true)
  })

  it.each([
    [
      'http://fcm.googleapis.com/fcm/send/abc123',
      'rejects http even for an otherwise-allowed host',
    ],
    ['https://evilnotify.windows.com.attacker.com/x', 'rejects an attacker parent domain'],
    ['https://xnotify.windows.com/x', 'rejects a non-label-boundary lookalike host'],
    [
      'https://notreal.push.services.mozilla.com.attacker.com/x',
      'rejects a suffix embedded before attacker domain',
    ],
    [
      'https://attacker.com/fcm.googleapis.com',
      'rejects an unrelated host with an allowed substring in the path',
    ],
    ['not a url', 'rejects an unparseable endpoint'],
    ['ftp://fcm.googleapis.com/x', 'rejects a non-https scheme'],
  ])('%s (%s)', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false)
  })

  it('exposes the allowlist as a single static const', () => {
    expect(ALLOWED_PUSH_HOSTS.exact).toContain('fcm.googleapis.com')
    expect(ALLOWED_PUSH_HOSTS.suffix).toContain('.notify.windows.com')
  })
})

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  p256dh: 'p256dh-value',
  auth: 'auth-value',
}

const PAYLOAD = { title: 'Space updated', body: 'Something happened', url: '/' }

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:admin@veduta.local' }

describe('WebPushTransport.send', () => {
  it('maps a resolved sendNotification to ok', async () => {
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    await expect(transport.send(SUBSCRIPTION, PAYLOAD)).resolves.toBe('ok')
    expect(sendNotification).toHaveBeenCalledTimes(1)
    const call = sendNotification.mock.calls[0]
    if (!call) throw new Error('expected sendNotification to have been called')
    const [subscription, body, options] = call
    expect(subscription).toEqual({
      endpoint: SUBSCRIPTION.endpoint,
      keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth },
    })
    expect(JSON.parse(body)).toEqual(PAYLOAD)
    expect(options).toMatchObject({ vapidDetails: VAPID, TTL: 3600, timeout: 10000 })
  })

  it('maps a 404 WebPushError to gone', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(new WebPushError('not found', 404, {}, '', SUBSCRIPTION.endpoint))
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    await expect(transport.send(SUBSCRIPTION, PAYLOAD)).resolves.toBe('gone')
  })

  it('maps a 410 WebPushError to gone', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(new WebPushError('gone', 410, {}, '', SUBSCRIPTION.endpoint))
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    await expect(transport.send(SUBSCRIPTION, PAYLOAD)).resolves.toBe('gone')
  })

  it('maps a 500 WebPushError to error', async () => {
    const sendNotification = vi
      .fn()
      .mockRejectedValue(new WebPushError('server error', 500, {}, '', SUBSCRIPTION.endpoint))
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    await expect(transport.send(SUBSCRIPTION, PAYLOAD)).resolves.toBe('error')
  })

  it('maps a thrown TypeError to error', async () => {
    const sendNotification = vi.fn().mockRejectedValue(new TypeError('boom'))
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    await expect(transport.send(SUBSCRIPTION, PAYLOAD)).resolves.toBe('error')
  })

  it('rejects a disallowed endpoint as error without calling the impl', async () => {
    const sendNotification = vi.fn()
    const transport = new WebPushTransport({ vapid: VAPID, webpushImpl: { sendNotification } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      transport.send({ ...SUBSCRIPTION, endpoint: 'https://attacker.example.com/x' }, PAYLOAD),
    ).resolves.toBe('error')
    expect(sendNotification).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
