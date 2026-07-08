/**
 * Minimal 5-field cron for Automations (issue #11): minute, hour,
 * day-of-month, month, day-of-week. Supported syntax per field: `*`
 * (with an optional `/step`), numbers, ranges (`a-b`, `a-b/step`) and
 * comma lists. All
 * times are UTC, like every other timestamp in the daemon. Standard
 * cron rule: when both day-of-month and day-of-week are restricted,
 * a day matches if either matches.
 */
export interface CronSchedule {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const

/** How far nextCronOccurrence searches before declaring the expression unsatisfiable. */
const MAX_SEARCH_DAYS = 366 * 5

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== FIELDS.length) {
    throw new Error(`invalid cron "${expression}": expected 5 fields, got ${parts.length}`)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELDS.map((field, index) =>
    parseField(parts[index]!, field, expression),
  )
  return {
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek: normalizeSunday(daysOfWeek!),
    // Vixie rule: a day field counts as unrestricted when it starts with
    // `*` (so `*/1` or `*/2` never turns the other day field into an OR).
    domRestricted: !parts[2]!.startsWith('*'),
    dowRestricted: !parts[4]!.startsWith('*'),
  }
}

/** The first occurrence strictly after `after`, UTC, second precision truncated. */
export function nextCronOccurrence(expression: string, after: Date): Date {
  const schedule = parseCron(expression)
  const start = new Date(after.getTime())
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)

  const day = new Date(start.getTime())
  for (let steps = 0; steps < MAX_SEARCH_DAYS; steps += 1) {
    if (dayMatches(schedule, day)) {
      const first = steps === 0
      for (const hour of sortedHours) {
        if (first && hour < day.getUTCHours()) continue
        for (const minute of sortedMinutes) {
          if (first && hour === day.getUTCHours() && minute < day.getUTCMinutes()) continue
          return new Date(
            Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute),
          )
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1)
    day.setUTCHours(0, 0, 0, 0)
  }
  throw new Error(`cron "${expression}" has no occurrence within ${MAX_SEARCH_DAYS} days`)
}

function dayMatches(schedule: CronSchedule, day: Date): boolean {
  if (!schedule.months.has(day.getUTCMonth() + 1)) return false
  const domMatch = schedule.daysOfMonth.has(day.getUTCDate())
  const dowMatch = schedule.daysOfWeek.has(day.getUTCDay())
  if (schedule.domRestricted && schedule.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

function parseField(part: string, field: (typeof FIELDS)[number], expression: string): Set<number> {
  const values = new Set<number>()
  for (const item of part.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
    if (!match) throw invalidField(expression, field.name, item)
    const [, range, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1) throw invalidField(expression, field.name, item)

    let from: number = field.min
    let to: number = field.max
    if (range !== '*') {
      const [fromText, toText] = range!.split('-')
      from = Number(fromText)
      to = toText === undefined ? from : Number(toText)
    }
    if (from < field.min || to > field.max || from > to) {
      throw invalidField(expression, field.name, item)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

/** Cron allows 7 as an alias for Sunday; Date.getUTCDay only speaks 0. */
function normalizeSunday(daysOfWeek: Set<number>): Set<number> {
  if (!daysOfWeek.has(7)) return daysOfWeek
  const normalized = new Set(daysOfWeek)
  normalized.delete(7)
  normalized.add(0)
  return normalized
}

function invalidField(expression: string, name: string, item: string): Error {
  return new Error(`invalid cron "${expression}": bad ${name} entry "${item}"`)
}
