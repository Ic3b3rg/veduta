import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeartbeatConfigSchema, loadHeartbeatConfig, timeToCron } from './heartbeat-config.ts'

describe('loadHeartbeatConfig', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-heartbeat-config-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('defaults to twice-daily UTC sweeps with a 24h staleness threshold', () => {
    expect(loadHeartbeatConfig(rootDir)).toEqual({
      enabled: true,
      times: ['06:00', '18:00'],
      staleAfterHours: 24,
    })
  })

  it('applies overrides for enabled, times and staleAfterHours', () => {
    writeFileSync(
      join(rootDir, 'heartbeat.json'),
      JSON.stringify({ enabled: false, times: ['07:15'], staleAfterHours: 12 }),
    )
    expect(loadHeartbeatConfig(rootDir)).toEqual({
      enabled: false,
      times: ['07:15'],
      staleAfterHours: 12,
    })
  })

  it('rejects an invalid time-of-day', () => {
    writeFileSync(join(rootDir, 'heartbeat.json'), JSON.stringify({ times: ['99:99'] }))
    expect(() => loadHeartbeatConfig(rootDir)).toThrow(/must match HH:MM/)
  })

  it('rejects duplicate times', () => {
    writeFileSync(join(rootDir, 'heartbeat.json'), JSON.stringify({ times: ['06:00', '06:00'] }))
    expect(() => loadHeartbeatConfig(rootDir)).toThrow(/must be unique/)
  })

  it('rejects invalid JSON with the offending path in the message', () => {
    writeFileSync(join(rootDir, 'heartbeat.json'), '{nope')
    expect(() => loadHeartbeatConfig(rootDir)).toThrow(/invalid JSON in heartbeat config/)
  })

  it('rejects unknown keys (strict schema)', () => {
    expect(() => HeartbeatConfigSchema.parse({ nope: true })).toThrow()
  })
})

describe('timeToCron', () => {
  it('converts HH:MM to a daily cron expression', () => {
    expect(timeToCron('06:00')).toBe('0 6 * * *')
    expect(timeToCron('18:05')).toBe('5 18 * * *')
  })

  it('throws on an invalid time-of-day', () => {
    expect(() => timeToCron('99:99')).toThrow(/invalid time-of-day/)
  })
})
