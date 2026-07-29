import { describe, expect, it } from 'vitest'
import {
  assertTimeZone,
  startOfZonedDay,
  startOfZonedMonth,
  zonedParts,
  zonedTimeToUtc,
} from './timezone.ts'

describe('assertTimeZone', () => {
  it('returns a valid IANA zone unchanged', () => {
    expect(assertTimeZone('Europe/Rome')).toBe('Europe/Rome')
  })

  it('rejects an unknown zone, naming the bad value', () => {
    expect(() => assertTimeZone('Not/AZone')).toThrow(/Not\/AZone/)
  })
})

describe('zonedParts', () => {
  it('normalizes midnight to hour 0', () => {
    expect(zonedParts('UTC', new Date('2026-01-01T00:00:00.000Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    })
  })
})

describe('zonedTimeToUtc', () => {
  it('converts an Europe/Rome summer (CEST, UTC+2) local time', () => {
    expect(
      zonedTimeToUtc('Europe/Rome', { year: 2026, month: 6, day: 1, hour: 0, minute: 0 }),
    ).toEqual(new Date('2026-05-31T22:00:00.000Z'))
  })

  it('converts an Europe/Rome winter (CET, UTC+1) local time', () => {
    expect(
      zonedTimeToUtc('Europe/Rome', { year: 2026, month: 1, day: 1, hour: 0, minute: 0 }),
    ).toEqual(new Date('2025-12-31T23:00:00.000Z'))
  })

  it('resolves a spring-forward gap to the transition instant', () => {
    // Europe/Rome jumps clocks 02:00 -> 03:00 on 2026-03-29: 02:30 never happens.
    const result = zonedTimeToUtc('Europe/Rome', {
      year: 2026,
      month: 3,
      day: 29,
      hour: 2,
      minute: 30,
    })
    expect(result.toISOString()).toBe('2026-03-29T01:00:00.000Z')
    expect(zonedParts('Europe/Rome', result).hour).toBe(3)
  })

  it('resolves a fall-back overlap to the earlier of the two instants', () => {
    // Europe/Rome falls clocks back 03:00 -> 02:00 on 2026-10-25: 02:30 happens
    // twice, first at 00:30Z (CEST, UTC+2), then again at 01:30Z (CET, UTC+1).
    const result = zonedTimeToUtc('Europe/Rome', {
      year: 2026,
      month: 10,
      day: 25,
      hour: 2,
      minute: 30,
    })
    expect(result.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('round-trips through Australia/Lord_Howe half-hour DST shifts', () => {
    const zone = 'Australia/Lord_Howe'
    const samples = [
      { year: 2026, month: 3, day: 1, hour: 10, minute: 0 },
      { year: 2026, month: 6, day: 15, hour: 15, minute: 30 },
      { year: 2026, month: 9, day: 1, hour: 0, minute: 0 },
      { year: 2026, month: 10, day: 4, hour: 1, minute: 0 },
      { year: 2026, month: 10, day: 4, hour: 3, minute: 0 },
      { year: 2026, month: 12, day: 25, hour: 23, minute: 45 },
    ]
    for (const parts of samples) {
      expect(zonedParts(zone, zonedTimeToUtc(zone, parts))).toEqual(parts)
    }
  })
})

describe('startOfZonedDay', () => {
  it('resolves Pacific/Kiritimati (UTC+14) midnight', () => {
    expect(startOfZonedDay('Pacific/Kiritimati', { year: 2026, month: 1, day: 1 })).toEqual(
      new Date('2025-12-31T10:00:00.000Z'),
    )
  })

  it('resolves Pacific/Niue (UTC-11) midnight', () => {
    expect(startOfZonedDay('Pacific/Niue', { year: 2026, month: 1, day: 1 })).toEqual(
      new Date('2026-01-01T11:00:00.000Z'),
    )
  })
})

describe('startOfZonedMonth', () => {
  it('matches startOfZonedDay for day 1 of the month', () => {
    expect(startOfZonedMonth('Pacific/Kiritimati', 2026, 1)).toEqual(
      startOfZonedDay('Pacific/Kiritimati', { year: 2026, month: 1, day: 1 }),
    )
  })
})
