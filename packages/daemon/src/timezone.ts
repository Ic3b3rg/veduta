/**
 * Global user-timezone helpers (issue #21). Time-aware memory queries ("what
 * did I weigh at the start of June?") and the nightly Reflection's firing
 * time must be anchored to the user's own timezone, not wherever the daemon
 * happens to be deployed — `SpaceSchema` has no timezone concept today, so
 * this is the shared seam every caller converts through. Built on
 * `Intl.DateTimeFormat` only: no timezone-database npm dependency to keep
 * current as the IANA database changes.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_GAP_SCAN_MINUTES = 180

export interface ZonedParts {
  year: number
  /** 1-12, unlike `Date`'s 0-11 month index. */
  month: number
  day: number
  hour: number
  minute: number
}

/**
 * Validates an IANA zone name the only way `Intl` exposes one: constructing
 * a formatter for it and seeing whether that throws. Returns `zone`
 * unchanged so call sites can validate-and-use in one expression.
 */
export function assertTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    throw new Error(`invalid time zone "${zone}"`)
  }
  return zone
}

const ZONED_PARTS_FORMAT: Intl.DateTimeFormatOptions = {
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}

function partAsNumber(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const part = parts.find((candidate) => candidate.type === type)
  if (part === undefined) {
    throw new Error(`Intl.DateTimeFormat produced no "${type}" part`)
  }
  return Number(part.value)
}

/**
 * The wall-clock reading of `instant` in `zone`. `hour12: false` reads
 * midnight as `'00'` on this runtime's ICU, but some ICU builds instead
 * report `'24'` for the same instant — normalized to 0 either way so
 * callers never see an out-of-range hour.
 */
/**
 * One formatter per zone, kept for the process's lifetime. Constructing an
 * `Intl.DateTimeFormat` is the expensive part of every conversion here, and
 * `zonedTimeToUtc` needs eight to ten readings per call — a query naming
 * several months, or a cron search walking days, multiplies that again.
 * Formatters are stateless, so reuse is safe.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zonedFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...ZONED_PARTS_FORMAT })
  formatterCache.set(zone, formatter)
  return formatter
}

export function zonedParts(zone: string, instant: Date): ZonedParts {
  const parts = zonedFormatter(zone).formatToParts(instant)
  return {
    year: partAsNumber(parts, 'year'),
    month: partAsNumber(parts, 'month'),
    day: partAsNumber(parts, 'day'),
    hour: partAsNumber(parts, 'hour') % 24,
    minute: partAsNumber(parts, 'minute'),
  }
}

/** `ZonedParts` reinterpreted as if they were UTC fields, as a `Date.UTC` timestamp. */
function utcTimestampOfZonedParts(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

/**
 * Rolls out-of-range fields into the real calendar date they denote, so
 * `{ month: 0 }` becomes December of the previous year and `{ day: 0 }` the
 * last day of the previous month. Callers do their calendar arithmetic in
 * plain numbers (`temporal-query.ts` builds "last month" as `month - 1`), and
 * `Date.UTC` accepts that; the comparisons inside `zonedTimeToUtc` do not, so
 * this runs before any of them.
 */
function canonicalizeParts(parts: ZonedParts): ZonedParts {
  const utc = new Date(utcTimestampOfZonedParts(parts))
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: utc.getUTCHours(),
    minute: utc.getUTCMinutes(),
  }
}

/**
 * Normalizes an ISO timestamp to a single instant with a `Z` offset, or
 * `undefined` when it does not parse. Every timestamp the memory subsystem
 * stores or filters on goes through here: those comparisons are lexical
 * (`docs/adr/0011-disposable-hybrid-index.md`), which is only valid when every
 * value shares one offset, and an imported or hand-written record may carry
 * `+02:00`. Never throws, so a caller can drop one bad value instead of
 * failing a whole file or a whole query.
 */
export function normalizeIsoInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : new Date(value).toISOString()
}

/** The zone's UTC offset (minutes-as-milliseconds, positive east of UTC) at real instant `instantMs`. */
function offsetAtInstant(zone: string, instantMs: number): number {
  return utcTimestampOfZonedParts(zonedParts(zone, new Date(instantMs))) - instantMs
}

function partsEqual(a: ZonedParts, b: ZonedParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  )
}

/** Lexicographic comparison of `ZonedParts` as a `(year, month, day, hour, minute)` tuple. */
function compareParts(a: ZonedParts, b: ZonedParts): number {
  return (
    a.year - b.year || a.month - b.month || a.day - b.day || a.hour - b.hour || a.minute - b.minute
  )
}

/**
 * Converts a wall-clock reading in `zone` to the UTC instant it denotes.
 * `Intl` only converts instant -> zone; this is the inverse, solved by
 * offset-guessing rather than a bundled transition table, so it works for
 * any zone `assertTimeZone` accepts.
 *
 * The naive guess (`Date.UTC` on the requested fields, as if they were
 * already UTC) is corrected by the zone's actual offset — but near a
 * transition a single correction can land on either side of it, so the
 * offset is sampled at three points (the requested day and the days
 * immediately before and after) and each sample is refined once more from
 * its own resulting instant. This guarantees a transition landing on the
 * requested day itself cannot hide one of its two sides from the search,
 * however the transition is signed (a positive-offset zone's naive guess
 * tends to fall after its own target instant; a negative-offset zone's
 * tends to fall before it).
 *
 * DST makes this inverse a relation, not a function, at the two edges of a
 * transition. Two deliberate policies resolve that, both driven by which
 * candidates round-trip back to the requested parts via `zonedParts`:
 *
 * - Fall-back overlap (the requested local time occurs twice, e.g. the
 *   moment clocks fall back 03:00 -> 02:00): more than one candidate
 *   round-trips. Returns the **earlier** of them — the first wall-clock
 *   occurrence, before the repeat.
 * - Spring-forward gap (the requested local time never occurs, e.g. the
 *   moment clocks jump 02:00 -> 03:00): no candidate round-trips. Returns
 *   the transition instant itself — the earliest real instant whose local
 *   time is at or after the one requested — found by scanning forward
 *   minute by minute from the earliest candidate, for at most
 *   `MAX_GAP_SCAN_MINUTES`. A caller asking for a local time that does not
 *   exist gets the nearest one that does, moving forward in time.
 */
export function zonedTimeToUtc(zone: string, requested: ZonedParts): Date {
  assertTimeZone(zone)
  // Callers do calendar arithmetic in plain numbers and hand over the result
  // — "the month before January" as `month: 0`, "the day before the 1st" as
  // `day: 0` (see `temporal-query.ts`). `Date.UTC` already rolls those into a
  // real date, but the round-trip and gap-scan comparisons below test the
  // candidate against the *requested* fields, so an out-of-range field would
  // never compare equal and, when it underflows, `compareParts` stays
  // negative forever and the scan runs out and throws. Canonicalize first, so
  // every comparison below is against the date the caller actually denoted.
  const parts = canonicalizeParts(requested)
  const guess = utcTimestampOfZonedParts(parts)

  const refine = (initialOffset: number): number => {
    const firstPass = guess - initialOffset
    const refinedOffset = offsetAtInstant(zone, firstPass)
    return refinedOffset === initialOffset ? firstPass : guess - refinedOffset
  }

  const probeOffsets = new Set<number>([
    offsetAtInstant(zone, guess),
    offsetAtInstant(zone, guess - DAY_MS),
    offsetAtInstant(zone, guess + DAY_MS),
  ])
  const candidates = new Set<number>()
  for (const offset of probeOffsets) candidates.add(refine(offset))

  const roundTripped = Array.from(candidates).filter((candidate) =>
    partsEqual(zonedParts(zone, new Date(candidate)), parts),
  )
  if (roundTripped.length > 0) return new Date(Math.min(...roundTripped))

  const scanStart = Math.min(...candidates)
  for (let minute = 0; minute <= MAX_GAP_SCAN_MINUTES; minute++) {
    const instantMs = scanStart + minute * 60_000
    if (compareParts(zonedParts(zone, new Date(instantMs)), parts) >= 0) {
      return new Date(instantMs)
    }
  }
  // A gap wider than the scan — a zone that skipped a whole calendar day, as
  // Pacific/Apia did crossing the date line at the end of 2011. Degrade rather
  // than throw: this sits under `nextCronOccurrence`, and throwing would take
  // down the scheduler's whole search over a date nobody can do anything about.
  // Return the LATEST candidate, which is the first instant past the gap: the
  // earliest one lies *before* the skipped day, which would fire a job on the
  // wrong calendar day and contradict this function's forward-gap policy.
  return new Date(Math.max(...candidates))
}

/** Midnight of the given zoned calendar day, as a UTC instant. */
export function startOfZonedDay(
  zone: string,
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
): Date {
  return zonedTimeToUtc(zone, { ...parts, hour: 0, minute: 0 })
}

/** Midnight of the first day of the given zoned calendar month, as a UTC instant. */
export function startOfZonedMonth(zone: string, year: number, month: number): Date {
  return zonedTimeToUtc(zone, { year, month, day: 1, hour: 0, minute: 0 })
}
