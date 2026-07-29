import { startOfZonedDay, startOfZonedMonth, assertTimeZone, zonedParts } from './timezone.ts'
import type { ZonedParts } from './timezone.ts'

/**
 * Time-aware query expansion (issue #21): the highest-measured-gain retrieval
 * technique in LongMemEval's error analysis (`docs/references/06-memory-research.md`)
 * is extracting the query's temporal range and applying it as a date filter
 * *before* search, rather than leaning on the search engine to notice "start
 * of June" in the text. This module is that extraction step: deterministic,
 * no LLM, no clock reads (`now` is injected so the same query always resolves
 * to the same range in tests and in production).
 *
 * All calendar arithmetic — "what day is the 1st of June", "how many days
 * are in this month", "which day of the week is this" — happens in the
 * user's timezone via `./timezone.ts`, never in UTC-as-if-local. A Space has
 * no timezone field yet, so this is the shared seam every caller (retrieval,
 * the nightly Reflection) converts through.
 */

/** Inclusive lower bound for `before <point>` queries, see `extractTemporalRange`. */
export const TEMPORAL_RANGE_EPOCH = '1970-01-01T00:00:00.000Z'

export interface TemporalRange {
  /** Inclusive lower bound, UTC ISO instant. */
  from: string
  /** Exclusive upper bound, UTC ISO instant. */
  to: string
  /**
   * The matched substring of the query, lowercased. The caller strips it
   * before building search terms: the words "start of June" must not have
   * to appear in a record for that record to match.
   */
  matched: string
}

export interface TemporalQueryOptions {
  timezone: string
  now: Date
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

const MONTH_PATTERN = `(?:${Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`
const YEAR_PATTERN = `\\d{4}`
const DATE_PATTERN = `\\d{4}-\\d{2}-\\d{2}`

/** Case-insensitive; the leading/trailing `\b` keep "may" out of "maybe" and "june" out of "junee". */
const START_OF_RE = new RegExp(
  `\\b(?:start of|beginning of)\\s+(${MONTH_PATTERN})(?:\\s+(${YEAR_PATTERN}))?\\b`,
  'gi',
)
const END_OF_RE = new RegExp(`\\bend of\\s+(${MONTH_PATTERN})(?:\\s+(${YEAR_PATTERN}))?\\b`, 'gi')
const IN_MONTH_RE = new RegExp(`\\bin\\s+(${MONTH_PATTERN})(?:\\s+(${YEAR_PATTERN}))?\\b`, 'gi')
const MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_PATTERN})\\s+(${YEAR_PATTERN})\\b`, 'gi')
const LAST_MONTH_NAMED_RE = new RegExp(`\\blast\\s+(${MONTH_PATTERN})\\b`, 'gi')
const BARE_MONTH_RE = new RegExp(`\\b(${MONTH_PATTERN})\\b`, 'gi')
const TODAY_RE = /\btoday\b/gi
const YESTERDAY_RE = /\byesterday\b/gi
const THIS_WEEK_RE = /\bthis week\b/gi
const LAST_WEEK_RE = /\blast week\b/gi
const THIS_MONTH_RE = /\bthis month\b/gi
const LAST_MONTH_RELATIVE_RE = /\blast month\b/gi
const LAST_N_DAYS_RE = /\blast (\d{1,3}) days\b/gi
const LAST_N_WEEKS_RE = /\blast (\d{1,3}) weeks\b/gi
const LAST_N_MONTHS_RE = /\blast (\d{1,3}) months\b/gi
const SINCE_RE = new RegExp(
  `\\bsince\\s+(?:(${MONTH_PATTERN})(?:\\s+(${YEAR_PATTERN}))?|(${DATE_PATTERN}))\\b`,
  'gi',
)
const BEFORE_RE = new RegExp(
  `\\bbefore\\s+(?:(${MONTH_PATTERN})(?:\\s+(${YEAR_PATTERN}))?|(${DATE_PATTERN}))\\b`,
  'gi',
)
const BARE_DATE_RE = new RegExp(`\\b(${DATE_PATTERN})\\b`, 'g')

function monthNumber(text: string | undefined): number | undefined {
  return text === undefined ? undefined : MONTHS[text.toLowerCase()]
}

/** `text` matched `DATE_PATTERN`, so the three groups are always present. */
function parseIsoDate(text: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`not a YYYY-MM-DD date: "${text}"`)
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/** `Date.UTC` normalizes an out-of-range day (0, 32, -3...) into the adjacent month/year. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Day-of-week as a pure calendar computation (Mon=0 .. Sun=6), independent of
 * any timezone: a calendar date's weekday does not depend on where it is
 * observed. Used only to locate the Monday of a week; the actual UTC bound is
 * still built through `startOfZonedDay`.
 */
function daysSinceMonday(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return (jsDay + 6) % 7
}

function mondayOfWeek(parts: ZonedParts): number {
  return parts.day - daysSinceMonday(parts.year, parts.month, parts.day)
}

interface Bounds {
  from: Date
  to: Date
}

/** Whole calendar month `[start of month, start of next month)`. */
function wholeMonth(zone: string, year: number, month: number): Bounds {
  return {
    from: startOfZonedMonth(zone, year, month),
    to: startOfZonedMonth(zone, year, month + 1),
  }
}

/** First 7 local days of the month. */
function startOfMonthWindow(zone: string, year: number, month: number): Bounds {
  return {
    from: startOfZonedMonth(zone, year, month),
    to: startOfZonedDay(zone, { year, month, day: 8 }),
  }
}

/** Last 7 local days of the month. */
function endOfMonthWindow(zone: string, year: number, month: number): Bounds {
  const lastDay = daysInMonth(year, month)
  return {
    from: startOfZonedDay(zone, { year, month, day: lastDay - 6 }),
    to: startOfZonedMonth(zone, year, month + 1),
  }
}

/**
 * A month with no year names its most recent occurrence at or before `now`:
 * with `now` in July 2026, "June" is June 2026 (June <= July, same year) but
 * "September" is September 2025 (September > July, so last year's).
 */
function mostRecentYear(nowParts: ZonedParts, month: number): number {
  return month <= nowParts.month ? nowParts.year : nowParts.year - 1
}

interface Candidate extends Bounds {
  index: number
  length: number
  matched: string
}

export function extractTemporalRange(
  query: string,
  options: TemporalQueryOptions,
): TemporalRange | undefined {
  const zone = assertTimeZone(options.timezone)
  const now = options.now
  const nowParts = zonedParts(zone, now)
  const monday = mondayOfWeek(nowParts)

  const candidates: Candidate[] = []
  const push = (match: RegExpMatchArray, bounds: Bounds) => {
    if (match.index === undefined) return
    candidates.push({
      index: match.index,
      length: match[0].length,
      matched: match[0].toLowerCase(),
      ...bounds,
    })
  }

  for (const match of query.matchAll(START_OF_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined) continue
    const year = match[2] !== undefined ? Number(match[2]) : mostRecentYear(nowParts, month)
    push(match, startOfMonthWindow(zone, year, month))
  }

  for (const match of query.matchAll(END_OF_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined) continue
    const year = match[2] !== undefined ? Number(match[2]) : mostRecentYear(nowParts, month)
    push(match, endOfMonthWindow(zone, year, month))
  }

  for (const match of query.matchAll(IN_MONTH_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined) continue
    const year = match[2] !== undefined ? Number(match[2]) : mostRecentYear(nowParts, month)
    push(match, wholeMonth(zone, year, month))
  }

  for (const match of query.matchAll(MONTH_YEAR_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined || match[2] === undefined) continue
    push(match, wholeMonth(zone, Number(match[2]), month))
  }

  for (const match of query.matchAll(LAST_MONTH_NAMED_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined) continue
    push(match, wholeMonth(zone, mostRecentYear(nowParts, month), month))
  }

  for (const match of query.matchAll(BARE_MONTH_RE)) {
    const month = monthNumber(match[1])
    if (month === undefined) continue
    push(match, wholeMonth(zone, mostRecentYear(nowParts, month), month))
  }

  for (const match of query.matchAll(TODAY_RE)) {
    push(match, {
      from: startOfZonedDay(zone, nowParts),
      to: startOfZonedDay(zone, { ...nowParts, day: nowParts.day + 1 }),
    })
  }

  for (const match of query.matchAll(YESTERDAY_RE)) {
    push(match, {
      from: startOfZonedDay(zone, { ...nowParts, day: nowParts.day - 1 }),
      to: startOfZonedDay(zone, nowParts),
    })
  }

  // Weeks start Monday: ISO 8601's convention, and the one users mean when
  // they say "this week" outside en-US calendars.
  for (const match of query.matchAll(THIS_WEEK_RE)) {
    push(match, {
      from: startOfZonedDay(zone, { ...nowParts, day: monday }),
      to: startOfZonedDay(zone, { ...nowParts, day: monday + 7 }),
    })
  }

  for (const match of query.matchAll(LAST_WEEK_RE)) {
    push(match, {
      from: startOfZonedDay(zone, { ...nowParts, day: monday - 7 }),
      to: startOfZonedDay(zone, { ...nowParts, day: monday }),
    })
  }

  for (const match of query.matchAll(THIS_MONTH_RE)) {
    push(match, wholeMonth(zone, nowParts.year, nowParts.month))
  }

  for (const match of query.matchAll(LAST_MONTH_RELATIVE_RE)) {
    push(match, wholeMonth(zone, nowParts.year, nowParts.month - 1))
  }

  // "last N <unit>s" is a rolling window of N whole units (day/week/month)
  // ending with, and including, the unit that contains `now` — so "last 1
  // week" coincides with "this week" and "last 1 month" with "this month".
  for (const match of query.matchAll(LAST_N_DAYS_RE)) {
    const n = parseWindowCount(match[1])
    if (n === undefined) continue
    push(match, {
      from: startOfZonedDay(zone, { ...nowParts, day: nowParts.day - (n - 1) }),
      to: startOfZonedDay(zone, { ...nowParts, day: nowParts.day + 1 }),
    })
  }

  for (const match of query.matchAll(LAST_N_WEEKS_RE)) {
    const n = parseWindowCount(match[1])
    if (n === undefined) continue
    push(match, {
      from: startOfZonedDay(zone, { ...nowParts, day: monday - 7 * (n - 1) }),
      to: startOfZonedDay(zone, { ...nowParts, day: monday + 7 }),
    })
  }

  for (const match of query.matchAll(LAST_N_MONTHS_RE)) {
    const n = parseWindowCount(match[1])
    if (n === undefined) continue
    push(match, {
      from: startOfZonedMonth(zone, nowParts.year, nowParts.month - (n - 1)),
      to: startOfZonedMonth(zone, nowParts.year, nowParts.month + 1),
    })
  }

  for (const match of query.matchAll(SINCE_RE)) {
    const to = now
    const month = monthNumber(match[1])
    if (month !== undefined) {
      const year = match[2] !== undefined ? Number(match[2]) : mostRecentYear(nowParts, month)
      push(match, { from: startOfZonedMonth(zone, year, month), to })
      continue
    }
    if (match[3] !== undefined) {
      push(match, { from: startOfZonedDay(zone, parseIsoDate(match[3])), to })
    }
  }

  for (const match of query.matchAll(BEFORE_RE)) {
    const from = new Date(TEMPORAL_RANGE_EPOCH)
    const month = monthNumber(match[1])
    if (month !== undefined) {
      const year = match[2] !== undefined ? Number(match[2]) : mostRecentYear(nowParts, month)
      push(match, { from, to: startOfZonedMonth(zone, year, month) })
      continue
    }
    if (match[3] !== undefined) {
      push(match, { from, to: startOfZonedDay(zone, parseIsoDate(match[3])) })
    }
  }

  for (const match of query.matchAll(BARE_DATE_RE)) {
    const dateText = match[1]
    if (dateText === undefined) continue
    const parts = parseIsoDate(dateText)
    push(match, {
      from: startOfZonedDay(zone, parts),
      to: startOfZonedDay(zone, { ...parts, day: parts.day + 1 }),
    })
  }

  if (candidates.length === 0) return undefined

  // Longest matched substring wins ("start of june" beats a bare "june");
  // on equal length, the earliest position in the query wins.
  candidates.sort((a, b) => b.length - a.length || a.index - b.index)
  const best = candidates[0]
  if (best === undefined) return undefined
  return { from: best.from.toISOString(), to: best.to.toISOString(), matched: best.matched }
}

/** `undefined` for anything outside the supported 1-120 range, so the caller falls through to "no match". */
function parseWindowCount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  return n >= 1 && n <= 120 ? n : undefined
}
