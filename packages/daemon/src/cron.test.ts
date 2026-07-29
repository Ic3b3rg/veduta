import { describe, expect, it } from 'vitest'
import { nextCronOccurrence, parseCron } from './cron.ts'

const at = (iso: string) => new Date(iso)

describe('parseCron', () => {
  it('rejects the wrong number of fields', () => {
    expect(() => parseCron('0 8 * *')).toThrow(/expected 5 fields/)
    expect(() => parseCron('0 8 * * * *')).toThrow(/expected 5 fields/)
  })

  it('rejects out-of-range and malformed entries', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/bad minute/)
    expect(() => parseCron('* 24 * * *')).toThrow(/bad hour/)
    expect(() => parseCron('* * 0 * *')).toThrow(/bad day-of-month/)
    expect(() => parseCron('* * * 13 *')).toThrow(/bad month/)
    expect(() => parseCron('* * * * 8')).toThrow(/bad day-of-week/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/bad minute/)
    expect(() => parseCron('5-1 * * * *')).toThrow(/bad minute/)
    expect(() => parseCron('mon * * * *')).toThrow(/bad minute/)
  })

  it('expands steps, ranges and lists', () => {
    const schedule = parseCron('*/20 9-11 1,15 * 1-5/2')
    expect([...schedule.minutes].sort((a, b) => a - b)).toEqual([0, 20, 40])
    expect([...schedule.hours].sort((a, b) => a - b)).toEqual([9, 10, 11])
    expect([...schedule.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15])
    expect(schedule.months.size).toBe(12)
    expect([...schedule.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 3, 5])
  })

  it('treats day-of-week 7 as Sunday', () => {
    expect(parseCron('* * * * 7').daysOfWeek.has(0)).toBe(true)
  })
})

describe('nextCronOccurrence', () => {
  it('finds the next daily occurrence, same day and next day', () => {
    expect(nextCronOccurrence('0 8 * * *', at('2026-07-08T06:30:00Z'))).toEqual(
      at('2026-07-08T08:00:00Z'),
    )
    expect(nextCronOccurrence('0 8 * * *', at('2026-07-08T08:00:00Z'))).toEqual(
      at('2026-07-09T08:00:00Z'),
    )
  })

  it('is strictly after the reference minute', () => {
    expect(nextCronOccurrence('* * * * *', at('2026-07-08T10:15:30Z'))).toEqual(
      at('2026-07-08T10:16:00Z'),
    )
  })

  it('crosses month and year boundaries', () => {
    expect(nextCronOccurrence('0 0 1 * *', at('2026-07-08T09:00:00Z'))).toEqual(
      at('2026-08-01T00:00:00Z'),
    )
    expect(nextCronOccurrence('30 6 1 1 *', at('2026-07-08T09:00:00Z'))).toEqual(
      at('2027-01-01T06:30:00Z'),
    )
  })

  it('honors day-of-week schedules', () => {
    // 2026-07-08 is a Wednesday; next Monday is 2026-07-13.
    expect(nextCronOccurrence('0 9 * * 1', at('2026-07-08T10:00:00Z'))).toEqual(
      at('2026-07-13T09:00:00Z'),
    )
  })

  it('treats star-with-step day fields as unrestricted (Vixie rule)', () => {
    // `*/1` day-of-month must not turn "every Monday" into "every day".
    expect(nextCronOccurrence('0 9 */1 * 1', at('2026-07-08T10:00:00Z'))).toEqual(
      at('2026-07-13T09:00:00Z'),
    )
    // `*/2` day-of-month ANDs with the weekday instead of ORing.
    expect(nextCronOccurrence('0 9 */2 * 5', at('2026-07-08T10:00:00Z'))).toEqual(
      at('2026-07-17T09:00:00Z'), // Friday the 17th: odd day AND Friday
    )
  })

  it('uses the standard OR rule when both day fields are restricted', () => {
    // 13th (Monday) OR Friday: from Wed 2026-07-08 the first match is Friday the 10th.
    expect(nextCronOccurrence('0 0 13 * 5', at('2026-07-08T10:00:00Z'))).toEqual(
      at('2026-07-10T00:00:00Z'),
    )
    // ...and from the 11th, the day-of-month leg wins before next Friday.
    expect(nextCronOccurrence('0 0 13 * 5', at('2026-07-11T10:00:00Z'))).toEqual(
      at('2026-07-13T00:00:00Z'),
    )
  })

  it('rejects unsatisfiable expressions instead of spinning forever', () => {
    expect(() => nextCronOccurrence('0 0 30 2 *', at('2026-07-08T00:00:00Z'))).toThrow(
      /no occurrence/,
    )
  })
})

describe('nextCronOccurrence with a timezone (issue #21)', () => {
  it('interprets the fields as local wall-clock time, not UTC', () => {
    // Europe/Rome is CEST (UTC+2) in July and CET (UTC+1) in January, so the
    // same "04:00 local" cron expression lands on a different UTC instant.
    expect(nextCronOccurrence('0 4 * * *', at('2026-07-01T00:00:00Z'), 'Europe/Rome')).toEqual(
      at('2026-07-01T02:00:00Z'),
    )
    expect(nextCronOccurrence('0 4 * * *', at('2026-01-01T00:00:00Z'), 'Europe/Rome')).toEqual(
      at('2026-01-01T03:00:00Z'),
    )
  })

  it('resolves a spring-forward gap to the transition instant, exactly once', () => {
    // Europe/Rome jumps 02:00 CET -> 03:00 CEST on 2026-03-29: local 02:00
    // never occurs that day.
    const first = nextCronOccurrence('0 2 * * *', at('2026-03-29T00:00:00Z'), 'Europe/Rome')
    expect(first).toEqual(at('2026-03-29T01:00:00Z'))
    // The following day's 02:00 is an ordinary, unambiguous occurrence.
    expect(nextCronOccurrence('0 2 * * *', first, 'Europe/Rome')).toEqual(
      at('2026-03-30T00:00:00Z'),
    )
  })

  it('resolves a fall-back overlap to the earlier instant, exactly once', () => {
    // Europe/Rome repeats local 02:30 on 2026-10-25 (CEST 02:30, then CET
    // 02:30 an hour later): only the earlier instant fires.
    const first = nextCronOccurrence('30 2 * * *', at('2026-10-25T00:00:00Z'), 'Europe/Rome')
    expect(first).toEqual(at('2026-10-25T00:30:00Z'))
    // Strictly after the first firing, the next one is the following day's
    // 02:30 — the repeated 02:30 later on the 25th is never returned again.
    expect(nextCronOccurrence('30 2 * * *', first, 'Europe/Rome')).toEqual(
      at('2026-10-26T01:30:00Z'),
    )
  })

  it('handles a 30-minute DST shift (Australia/Lord_Howe)', () => {
    // Lord Howe jumps 01:59 -> 02:30 on 2026-10-04 (standard -> DST): local
    // 02:00 never occurs.
    const first = nextCronOccurrence('0 2 * * *', at('2026-10-03T14:00:00Z'), 'Australia/Lord_Howe')
    expect(first).toEqual(at('2026-10-03T15:30:00Z'))
    expect(nextCronOccurrence('0 2 * * *', first, 'Australia/Lord_Howe')).toEqual(
      at('2026-10-04T15:00:00Z'),
    )

    // Lord Howe repeats local 02:15 on 2026-04-05 (DST -> standard, -30min).
    const secondFirst = nextCronOccurrence(
      '15 2 * * *',
      at('2026-04-04T14:00:00Z'),
      'Australia/Lord_Howe',
    )
    expect(secondFirst).toEqual(at('2026-04-04T15:45:00Z'))
    expect(nextCronOccurrence('15 2 * * *', secondFirst, 'Australia/Lord_Howe')).toEqual(
      at('2026-04-05T15:45:00Z'),
    )
  })

  it('crosses the date line correctly (Pacific/Kiritimati, UTC+14)', () => {
    expect(
      nextCronOccurrence('0 0 * * *', at('2026-07-08T09:00:00Z'), 'Pacific/Kiritimati'),
    ).toEqual(at('2026-07-08T10:00:00Z'))
    expect(
      nextCronOccurrence('0 0 * * *', at('2026-07-08T23:00:00Z'), 'Pacific/Kiritimati'),
    ).toEqual(at('2026-07-09T10:00:00Z'))
  })

  it('keeps the day-of-month/day-of-week either-or rule in local calendar days', () => {
    // 13th (Monday) OR Friday, evaluated against America/New_York's local
    // calendar, not UTC's.
    expect(
      nextCronOccurrence('0 0 13 * 5', at('2026-07-08T22:00:00Z'), 'America/New_York'),
    ).toEqual(at('2026-07-10T04:00:00Z'))
    expect(
      nextCronOccurrence('0 0 13 * 5', at('2026-07-11T22:00:00Z'), 'America/New_York'),
    ).toEqual(at('2026-07-13T04:00:00Z'))
  })

  it('throws on an invalid timezone', () => {
    expect(() => nextCronOccurrence('0 4 * * *', at('2026-07-08T00:00:00Z'), 'Not/AZone')).toThrow(
      /invalid time zone/,
    )
  })
})
