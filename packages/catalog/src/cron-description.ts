import { parseCron, type CronSchedule } from '@veduta/protocol'
import { browserLocales } from './surface-value.tsx'

export function scheduleLanguage(): 'it' | 'en' {
  return new Intl.DateTimeFormat(browserLocales()).resolvedOptions().locale.startsWith('it')
    ? 'it'
    : 'en'
}

/** Describe expanded fields, including the scheduler's exact day-field combination. */
export function describeCron(expression: string): string {
  const schedule = parseCron(expression)
  const italian = scheduleLanguage() === 'it'
  const time = describeTime(schedule, italian)
  const days = describeDays(schedule, italian)
  const months =
    schedule.months.size === 12
      ? ''
      : `; ${italian ? 'nei mesi di' : 'in'} ${ranges(schedule.months, monthName)}`
  return `${time} ${days}${months}`
}

function describeTime(schedule: CronSchedule, italian: boolean): string {
  const hours = sorted(schedule.hours)
  const minutes = sorted(schedule.minutes)
  if (hours.length * minutes.length <= 6) {
    const times = hours.flatMap((hour) =>
      minutes.map((minute) =>
        new Intl.DateTimeFormat(browserLocales(), {
          timeStyle: 'short',
          timeZone: 'UTC',
        }).format(new Date(Date.UTC(2024, 0, 1, hour, minute))),
      ),
    )
    return `${italian ? 'Alle' : 'At'} ${list(times)}`
  }
  if (hours.length === 24) {
    if (minutes.length === 60) return italian ? 'Ogni minuto' : 'Every minute'
    const step = minutes[1]
    if (
      minutes[0] === 0 &&
      step &&
      60 % step === 0 &&
      minutes.length === 60 / step &&
      minutes.every((minute, index) => minute === index * step)
    )
      return italian ? `Ogni ${step} minuti` : `Every ${step} minutes`
    return italian
      ? `Ai minuti ${ranges(schedule.minutes)} di ogni ora`
      : `At minutes ${ranges(schedule.minutes)} of every hour`
  }
  const hourList = ranges(schedule.hours, (hour) => String(hour).padStart(2, '0'))
  return italian
    ? `${minutes.length === 60 ? 'Ogni minuto' : `Ai minuti ${ranges(schedule.minutes)}`} nelle ore ${hourList} (formato 24 ore)`
    : `${minutes.length === 60 ? 'Every minute' : `At minutes ${ranges(schedule.minutes)}`} during hours ${hourList} (24-hour clock)`
}

function describeDays(schedule: CronSchedule, italian: boolean): string {
  const allDates = schedule.daysOfMonth.size === 31
  const allWeekdays = schedule.daysOfWeek.size === 7
  const either = schedule.domRestricted && schedule.dowRestricted
  if ((allDates && allWeekdays) || (either && (allDates || allWeekdays)))
    return italian ? 'ogni giorno' : 'every day'
  const dayPrefix =
    schedule.daysOfMonth.size === 1
      ? italian
        ? 'il giorno'
        : 'on day'
      : italian
        ? 'nei giorni'
        : 'on days'
  const dates = `${dayPrefix} ${ranges(schedule.daysOfMonth)} ${italian ? 'del mese' : 'of the month'}`
  const weekdays = `${italian ? 'di' : 'on'} ${ranges(schedule.daysOfWeek, weekdayName)}`
  if (allDates) return weekdays
  if (allWeekdays) return dates
  return `${dates} ${either ? (italian ? 'oppure' : 'or') : italian ? 'e' : 'and'} ${weekdays}`
}

function monthName(month: number): string {
  return new Intl.DateTimeFormat(browserLocales(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, month - 1, 1)),
  )
}

function weekdayName(day: number): string {
  return new Intl.DateTimeFormat(browserLocales(), { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 7 + day)),
  )
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((left, right) => left - right)
}

function list(values: string[]): string {
  return new Intl.ListFormat(browserLocales(), { style: 'long', type: 'conjunction' }).format(
    values,
  )
}

function ranges(values: ReadonlySet<number>, label: (value: number) => string = String): string {
  const ordered = sorted(values)
  const parts: string[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const first = ordered[index]!
    let last = index
    while (ordered[last + 1] === ordered[last]! + 1) last += 1
    if (last - index >= 2) {
      parts.push(`${label(first)}–${label(ordered[last]!)}`)
      index = last
    } else parts.push(label(first))
  }
  return list(parts)
}
