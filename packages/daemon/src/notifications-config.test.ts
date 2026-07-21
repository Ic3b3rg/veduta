import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  budgetFor,
  isWithinQuietHours,
  loadNotificationsConfig,
  NotificationsConfigSchema,
  quietWindowEnd,
  resolveTimezone,
  saveNotificationsConfig,
  type NotificationsConfig,
} from './notifications-config.ts'

describe('loadNotificationsConfig', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-notifications-config-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('defaults when the config file is absent', () => {
    expect(loadNotificationsConfig(rootDir)).toEqual({
      defaultDailyPushBudget: 3,
      spaceBudgets: {},
      quietHours: { start: '22:00', end: '08:00' },
      digestThreshold: 3,
    })
  })

  it('rejects invalid JSON with the offending path in the message', () => {
    const path = join(rootDir, 'notifications.json')
    writeFileSync(path, '{nope')
    let message = ''
    try {
      loadNotificationsConfig(rootDir)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('invalid JSON in notifications config')
    expect(message).toContain(path)
  })

  it('rejects an invalid IANA timezone', () => {
    writeFileSync(join(rootDir, 'notifications.json'), JSON.stringify({ timezone: 'Not/AZone' }))
    expect(() => loadNotificationsConfig(rootDir)).toThrow(/not a valid IANA time zone/)
  })

  it('rejects unknown keys (strict schema)', () => {
    expect(() => NotificationsConfigSchema.parse({ nope: true })).toThrow()
  })

  it('accepts a valid IANA timezone', () => {
    writeFileSync(join(rootDir, 'notifications.json'), JSON.stringify({ timezone: 'Europe/Rome' }))
    expect(loadNotificationsConfig(rootDir).timezone).toBe('Europe/Rome')
  })
})

describe('saveNotificationsConfig', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-notifications-config-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('round-trips through save then load', () => {
    const config: NotificationsConfig = {
      defaultDailyPushBudget: 5,
      spaceBudgets: { 'space-a': 10, 'space-b': 0 },
      quietHours: { start: '23:00', end: '07:30' },
      digestThreshold: 5,
      timezone: 'Europe/Rome',
    }
    saveNotificationsConfig(rootDir, config)
    expect(loadNotificationsConfig(rootDir)).toEqual(config)
  })

  it('writes pretty-printed JSON atomically (no leftover tmp file)', () => {
    saveNotificationsConfig(rootDir, NotificationsConfigSchema.parse({}))
    const path = join(rootDir, 'notifications.json')
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('\n')
    expect(() => readFileSync(`${path}.tmp`, 'utf8')).toThrow()
  })

  it('validates through the schema before writing', () => {
    expect(() =>
      saveNotificationsConfig(
        rootDir,
        fromPartial<NotificationsConfig>({ defaultDailyPushBudget: -1 }),
      ),
    ).toThrow()
  })
})

describe('budgetFor', () => {
  it('uses the per-Space override when present', () => {
    const config = NotificationsConfigSchema.parse({
      defaultDailyPushBudget: 3,
      spaceBudgets: { home: 10 },
    })
    expect(budgetFor(config, 'home')).toBe(10)
  })

  it('falls back to the daemon-wide default', () => {
    const config = NotificationsConfigSchema.parse({
      defaultDailyPushBudget: 3,
      spaceBudgets: { home: 10 },
    })
    expect(budgetFor(config, 'other-space')).toBe(3)
  })
})

describe('resolveTimezone', () => {
  it('uses the configured timezone when present', () => {
    const config = NotificationsConfigSchema.parse({ timezone: 'Europe/Rome' })
    expect(resolveTimezone(config)).toBe('Europe/Rome')
  })

  it('falls back to the daemon process timezone otherwise', () => {
    const config = NotificationsConfigSchema.parse({})
    expect(resolveTimezone(config)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe('isWithinQuietHours (Europe/Rome)', () => {
  const wrapping = { start: '22:00', end: '08:00' }
  const nonWrapping = { start: '08:00', end: '22:00' }

  it('is true inside a midnight-wrapping window, before midnight', () => {
    // 2026-01-15T22:00:00Z -> 23:00 local (Rome, CET = UTC+1), inside the wrapped window.
    expect(isWithinQuietHours(new Date('2026-01-15T22:00:00Z'), wrapping, 'Europe/Rome')).toBe(true)
  })

  it('is true inside a midnight-wrapping window, after midnight', () => {
    expect(isWithinQuietHours(new Date('2026-01-16T03:00:00Z'), wrapping, 'Europe/Rome')).toBe(true)
  })

  it('is false outside a midnight-wrapping window', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T11:00:00Z'), wrapping, 'Europe/Rome')).toBe(
      false,
    )
  })

  it('is true exactly at the wrapping window start (inclusive)', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T21:00:00Z'), wrapping, 'Europe/Rome')).toBe(true)
  })

  it('is false exactly at the wrapping window end (exclusive)', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T07:00:00Z'), wrapping, 'Europe/Rome')).toBe(
      false,
    )
  })

  it('is true inside a non-wrapping window', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T09:00:00Z'), nonWrapping, 'Europe/Rome')).toBe(
      true,
    )
  })

  it('is false outside a non-wrapping window', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T22:00:00Z'), nonWrapping, 'Europe/Rome')).toBe(
      false,
    )
  })

  it('is true exactly at the non-wrapping window start (inclusive)', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T07:00:00Z'), nonWrapping, 'Europe/Rome')).toBe(
      true,
    )
  })

  it('is false exactly at the non-wrapping window end (exclusive)', () => {
    expect(isWithinQuietHours(new Date('2026-01-15T21:00:00Z'), nonWrapping, 'Europe/Rome')).toBe(
      false,
    )
  })

  it('never matches when start === end (degenerate empty window)', () => {
    const empty = { start: '09:00', end: '09:00' }
    expect(isWithinQuietHours(new Date('2026-01-15T08:00:00Z'), empty, 'Europe/Rome')).toBe(false)
    expect(isWithinQuietHours(new Date('2026-01-15T20:00:00Z'), empty, 'Europe/Rome')).toBe(false)
  })
})

describe('quietWindowEnd (Europe/Rome)', () => {
  const wrapping = { start: '22:00', end: '08:00' }

  it('resolves to later the same UTC day when evaluated before midnight', () => {
    // now = 2026-01-15T21:00Z = 22:00 local (CET, UTC+1) -> inside the window, just started.
    // next 08:00 local hasn't happened yet today -> rolls to 2026-01-16 08:00 local = 07:00Z.
    expect(quietWindowEnd(new Date('2026-01-15T21:00:00Z'), wrapping, 'Europe/Rome')).toEqual(
      new Date('2026-01-16T07:00:00Z'),
    )
  })

  it('resolves to the same UTC day when evaluated after midnight', () => {
    // now = 2026-01-16T03:00Z = 04:00 local -> today's 08:00 local (07:00Z) is still ahead.
    expect(quietWindowEnd(new Date('2026-01-16T03:00:00Z'), wrapping, 'Europe/Rome')).toEqual(
      new Date('2026-01-16T07:00:00Z'),
    )
  })

  it('still yields a valid, later end instant across the Europe/Rome DST transition', () => {
    // Last Sunday of March 2026 (2026-03-29): CET (UTC+1) -> CEST (UTC+2) at 01:00Z.
    // now = 2026-03-29T00:30Z = 01:30 local (still CET, pre-transition), within the window.
    const now = new Date('2026-03-29T00:30:00Z')
    const end = quietWindowEnd(now, wrapping, 'Europe/Rome')
    expect(end.getTime()).toBeGreaterThan(now.getTime())
    // 08:00 local on 2026-03-29 falls after the transition, so it's CEST (UTC+2) -> 06:00Z.
    expect(end).toEqual(new Date('2026-03-29T06:00:00Z'))
  })
})
