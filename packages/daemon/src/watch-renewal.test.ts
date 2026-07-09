import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchManager, type WatchTransport } from './watch-renewal.ts'

describe('WatchManager', () => {
  let rootDir: string
  let clock: Date
  let alerts: { source: string; message: string }[]

  const manager = () =>
    new WatchManager({
      rootDir,
      now: () => clock,
      onAlert: (source, message) => alerts.push({ source, message }),
    })

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-watch-'))
    clock = new Date('2026-07-09T10:00:00Z')
    alerts = []
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('renews a fresh registration immediately and records the expiry', async () => {
    const transport: WatchTransport = {
      renew: vi.fn(async () => ({
        expiresAt: new Date(clock.getTime() + 7 * 86_400_000).toISOString(),
        channelId: 'ch-1',
        resourceId: 'res-1',
      })),
    }
    const watches = manager()
    watches.register('gmail', 'gmail', transport)
    await watches.sweep()

    const [registration] = watches.registrations()
    expect(registration?.expiresAt).toBe('2026-07-16T10:00:00.000Z')
    expect(registration?.channelId).toBe('ch-1')
    expect(registration?.consecutiveFailures).toBe(0)
  })

  it('renews an expired watch on the next sweep (within the hour)', async () => {
    let renewals = 0
    const transport: WatchTransport = {
      renew: async () => {
        renewals += 1
        return { expiresAt: new Date(clock.getTime() + 86_400_000).toISOString() }
      },
    }
    const watches = manager()
    watches.register('gmail', 'gmail', transport)
    await watches.sweep()
    expect(renewals).toBe(1)

    // Two days pass while the daemon was down: the watch is now expired.
    advance(2 * 86_400_000)
    await watches.sweep()
    expect(renewals).toBe(2)
    expect(watches.registrations()[0]?.expiresAt).toBe(
      new Date(clock.getTime() + 86_400_000).toISOString(),
    )
  })

  it('renews daily even when the expiry is far away', async () => {
    let renewals = 0
    const transport: WatchTransport = {
      renew: async () => {
        renewals += 1
        return { expiresAt: new Date(clock.getTime() + 7 * 86_400_000).toISOString() }
      },
    }
    const watches = manager()
    watches.register('gmail', 'gmail', transport)
    await watches.sweep()
    advance(6 * 60 * 60 * 1000)
    await watches.sweep()
    expect(renewals).toBe(1)

    advance(19 * 60 * 60 * 1000)
    await watches.sweep()
    expect(renewals).toBe(2)
  })

  it('alerts once after three consecutive failures and resets on success', async () => {
    let fail = true
    const transport: WatchTransport = {
      renew: async () => {
        if (fail) throw new Error('watch renew boom')
        return { expiresAt: new Date(clock.getTime() + 86_400_000).toISOString() }
      },
    }
    const watches = manager()
    watches.register('cal', 'calendar', transport)

    await watches.sweep()
    await watches.sweep()
    expect(alerts).toEqual([])
    await watches.sweep()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.message).toContain('failed 3 times')
    expect(alerts[0]?.message).not.toContain('boom')

    await watches.sweep()
    expect(alerts).toHaveLength(1)

    fail = false
    await watches.sweep()
    const [registration] = watches.registrations()
    expect(registration?.consecutiveFailures).toBe(0)
    expect(registration?.alerted).toBe(false)
    expect(registration?.lastError).toBeUndefined()
  })

  it('persists registrations across a restart', async () => {
    const transport: WatchTransport = {
      renew: async () => ({ expiresAt: new Date(clock.getTime() + 86_400_000).toISOString() }),
    }
    const watches = manager()
    watches.register('gmail', 'gmail', transport)
    await watches.sweep()

    const reopened = manager()
    reopened.register('gmail', 'gmail', transport)
    const [registration] = reopened.registrations()
    expect(registration?.expiresAt).toBeDefined()
    expect(registration?.lastRenewedAt).toBeDefined()
  })
})
