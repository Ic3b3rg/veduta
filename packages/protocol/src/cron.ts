/**
 * Five-field Automation cron: minute, hour, day-of-month, month, day-of-week.
 * Fields accept numbers, ranges, lists, and optional steps. Scheduling and
 * presentation share this grammar, including its day-field combination flags.
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
