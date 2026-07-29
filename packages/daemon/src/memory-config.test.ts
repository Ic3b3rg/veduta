import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryConfigSchema, loadMemoryConfig } from './memory-config.ts'

describe('loadMemoryConfig', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-config-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('defaults to UTC, an enabled 4:00 reflection and a 4000-unit budget', () => {
    expect(loadMemoryConfig(rootDir)).toEqual({
      timezone: 'UTC',
      reflection: { enabled: true, time: '04:00' },
      budget: { low: 4000 },
    })
  })

  it('applies overrides for timezone, reflection and budget', () => {
    writeFileSync(
      join(rootDir, 'memory.json'),
      JSON.stringify({
        timezone: 'Europe/Rome',
        reflection: { enabled: false, time: '03:30' },
        budget: { low: 2000 },
      }),
    )
    expect(loadMemoryConfig(rootDir)).toEqual({
      timezone: 'Europe/Rome',
      reflection: { enabled: false, time: '03:30' },
      budget: { low: 2000 },
    })
  })

  it('rejects an unknown timezone, naming the bad value', () => {
    writeFileSync(join(rootDir, 'memory.json'), JSON.stringify({ timezone: 'Not/AZone' }))
    expect(() => loadMemoryConfig(rootDir)).toThrow(/Not\/AZone/)
  })

  it('rejects an invalid reflection time', () => {
    writeFileSync(join(rootDir, 'memory.json'), JSON.stringify({ reflection: { time: '25:00' } }))
    expect(() => loadMemoryConfig(rootDir)).toThrow(/must match HH:MM/)
  })

  it('rejects invalid JSON, naming the config path', () => {
    writeFileSync(join(rootDir, 'memory.json'), '{nope')
    expect(() => loadMemoryConfig(rootDir)).toThrow(/invalid JSON in memory config .*memory\.json/)
  })

  it('rejects unknown top-level keys (strict schema)', () => {
    expect(() => MemoryConfigSchema.parse({ nope: true })).toThrow()
  })

  it('rejects unknown keys inside reflection (strict nested schema)', () => {
    expect(() => MemoryConfigSchema.parse({ reflection: { nope: true } })).toThrow()
  })

  it('rejects unknown keys inside budget (strict nested schema)', () => {
    expect(() => MemoryConfigSchema.parse({ budget: { nope: true } })).toThrow()
  })
})
