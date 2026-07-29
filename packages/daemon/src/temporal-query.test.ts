import { describe, expect, it } from 'vitest'
import { zonedParts } from './timezone.ts'
import { extractTemporalRange, TEMPORAL_RANGE_EPOCH } from './temporal-query.ts'

const NOW = new Date('2026-07-28T12:00:00.000Z')
const rome = { timezone: 'Europe/Rome', now: NOW }

describe('extractTemporalRange', () => {
  it('resolves "start of June" in Europe/Rome to the first 7 local days of June', () => {
    expect(extractTemporalRange('How much did I weigh at the start of June?', rome)).toEqual({
      from: '2026-05-31T22:00:00.000Z',
      to: '2026-06-07T22:00:00.000Z',
      matched: 'start of june',
    })
  })

  it('shifts the same query by the zone offset in Pacific/Kiritimati (UTC+14)', () => {
    expect(
      extractTemporalRange('How much did I weigh at the start of June?', {
        timezone: 'Pacific/Kiritimati',
        now: NOW,
      }),
    ).toEqual({
      from: '2026-05-31T10:00:00.000Z',
      to: '2026-06-07T10:00:00.000Z',
      matched: 'start of june',
    })
  })

  it('shifts the same query by the zone offset in Pacific/Niue (UTC-11)', () => {
    expect(
      extractTemporalRange('How much did I weigh at the start of June?', {
        timezone: 'Pacific/Niue',
        now: NOW,
      }),
    ).toEqual({
      from: '2026-06-01T11:00:00.000Z',
      to: '2026-06-08T11:00:00.000Z',
      matched: 'start of june',
    })
  })

  it('returns undefined for a query with no temporal phrase', () => {
    expect(extractTemporalRange('what is my current weight?', rome)).toBeUndefined()
  })

  it('returns undefined for an unrecognized phrase', () => {
    expect(extractTemporalRange('sometime soonish', rome)).toBeUndefined()
  })

  it('resolves "today"', () => {
    expect(extractTemporalRange('today', rome)).toEqual({
      from: '2026-07-27T22:00:00.000Z',
      to: '2026-07-28T22:00:00.000Z',
      matched: 'today',
    })
  })

  it('resolves "yesterday"', () => {
    expect(extractTemporalRange('yesterday', rome)).toEqual({
      from: '2026-07-26T22:00:00.000Z',
      to: '2026-07-27T22:00:00.000Z',
      matched: 'yesterday',
    })
  })

  it('resolves "this week" starting Monday', () => {
    // 2026-07-28 is a Tuesday, so this week's Monday is 2026-07-27.
    expect(extractTemporalRange('this week', rome)).toEqual({
      from: '2026-07-26T22:00:00.000Z',
      to: '2026-08-02T22:00:00.000Z',
      matched: 'this week',
    })
  })

  it('resolves "last week" as the preceding Monday-to-Monday window', () => {
    expect(extractTemporalRange('last week', rome)).toEqual({
      from: '2026-07-19T22:00:00.000Z',
      to: '2026-07-26T22:00:00.000Z',
      matched: 'last week',
    })
  })

  it('resolves "last 3 months" as a rolling window including the current month', () => {
    expect(extractTemporalRange('last 3 months', rome)).toEqual({
      from: '2026-04-30T22:00:00.000Z',
      to: '2026-07-31T22:00:00.000Z',
      matched: 'last 3 months',
    })
  })

  it('resolves "in March 2020"', () => {
    expect(extractTemporalRange('in March 2020', rome)).toEqual({
      from: '2020-02-29T23:00:00.000Z',
      to: '2020-03-31T22:00:00.000Z',
      matched: 'in march 2020',
    })
  })

  it('resolves "since 2026-06-15" as that day through now', () => {
    expect(extractTemporalRange('since 2026-06-15', rome)).toEqual({
      from: '2026-06-14T22:00:00.000Z',
      to: NOW.toISOString(),
      matched: 'since 2026-06-15',
    })
  })

  it('resolves "before July" as the epoch through the start of the most recent July', () => {
    // "July" with no year is at-or-before `now` (2026-07-28), so it is July 2026 itself.
    expect(extractTemporalRange('before July', rome)).toEqual({
      from: TEMPORAL_RANGE_EPOCH,
      to: '2026-06-30T22:00:00.000Z',
      matched: 'before july',
    })
  })

  it('resolves "before 2026-06-15" as the epoch through that day', () => {
    expect(extractTemporalRange('before 2026-06-15', rome)).toEqual({
      from: TEMPORAL_RANGE_EPOCH,
      to: '2026-06-14T22:00:00.000Z',
      matched: 'before 2026-06-15',
    })
  })

  it('resolves a bare YYYY-MM-DD as that single local day', () => {
    expect(extractTemporalRange('2026-06-15', rome)).toEqual({
      from: '2026-06-14T22:00:00.000Z',
      to: '2026-06-15T22:00:00.000Z',
      matched: '2026-06-15',
    })
  })

  it('resolves "end of May" as the last 7 local days of the month', () => {
    expect(extractTemporalRange('end of May', rome)).toEqual({
      from: '2026-05-24T22:00:00.000Z',
      to: '2026-05-31T22:00:00.000Z',
      matched: 'end of may',
    })
  })

  it('resolves a bare month at or before the current month to this year', () => {
    // `now` is July 2026; June <= July, so it resolves to June 2026.
    expect(extractTemporalRange('june', rome)).toEqual({
      from: '2026-05-31T22:00:00.000Z',
      to: '2026-06-30T22:00:00.000Z',
      matched: 'june',
    })
  })

  it('resolves a bare month after the current month to last year', () => {
    // `now` is July 2026; September > July, so it resolves to September 2025.
    expect(extractTemporalRange('september', rome)).toEqual({
      from: '2025-08-31T22:00:00.000Z',
      to: '2025-09-30T22:00:00.000Z',
      matched: 'september',
    })
  })

  it('picks the longest matched substring when several phrases match', () => {
    // Both "start of june" (14 chars) and the bare "june" (4 chars) match;
    // the longer wins per the documented precedence rule.
    expect(extractTemporalRange('start of june and also june', rome)).toEqual({
      from: '2026-05-31T22:00:00.000Z',
      to: '2026-06-07T22:00:00.000Z',
      matched: 'start of june',
    })
  })

  it('picks the earliest position when two matches are the same length', () => {
    // "today" appears twice, tied in length; the first occurrence wins.
    const result = extractTemporalRange('today, not today', rome)
    expect(result?.matched).toBe('today')
    expect(result).toEqual({
      from: '2026-07-27T22:00:00.000Z',
      to: '2026-07-28T22:00:00.000Z',
      matched: 'today',
    })
  })

  it('throws for an invalid timezone', () => {
    expect(() => extractTemporalRange('today', { timezone: 'Not/AZone', now: NOW })).toThrow(
      /Not\/AZone/,
    )
  })

  it('throws for an invalid timezone even when the query has no temporal phrase', () => {
    // The timezone is validated unconditionally, so a bad configuration
    // fails loudly instead of silently resolving to "no date filter".
    expect(() =>
      extractTemporalRange('what is my current weight?', { timezone: 'Not/AZone', now: NOW }),
    ).toThrow(/Not\/AZone/)
  })

  it('keeps both bounds of a DST-crossing month at local midnight, despite different UTC offsets', () => {
    // Europe/Rome springs forward on 2026-03-29, inside this range.
    const result = extractTemporalRange('in March 2026', rome)
    expect(result).toEqual({
      from: '2026-02-28T23:00:00.000Z',
      to: '2026-03-31T22:00:00.000Z',
      matched: 'in march 2026',
    })
    expect(zonedParts('Europe/Rome', new Date(result!.from))).toMatchObject({ hour: 0, minute: 0 })
    expect(zonedParts('Europe/Rome', new Date(result!.to))).toMatchObject({ hour: 0, minute: 0 })
    // The offsets either side of the transition differ (CET vs CEST): one
    // bound is 23:00 UTC the day before, the other 22:00 UTC.
    expect(result!.from.endsWith('23:00:00.000Z')).toBe(true)
    expect(result!.to.endsWith('22:00:00.000Z')).toBe(true)
  })
})
