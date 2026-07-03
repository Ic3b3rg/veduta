import { describe, expect, it } from 'vitest'
import { freshnessLabel } from './api.ts'

describe('freshnessLabel', () => {
  const now = Date.parse('2026-07-03T12:00:00.000Z')

  it('says "just now" under a minute', () => {
    expect(freshnessLabel('2026-07-03T11:59:40.000Z', now)).toBe('just now')
  })

  it('uses minutes under an hour', () => {
    expect(freshnessLabel('2026-07-03T11:15:00.000Z', now)).toBe('45m ago')
  })

  it('uses hours under a day and days beyond', () => {
    expect(freshnessLabel('2026-07-03T09:00:00.000Z', now)).toBe('3h ago')
    expect(freshnessLabel('2026-07-01T12:00:00.000Z', now)).toBe('2d ago')
  })
})
