import { DateValueSchema, type ValueFormat } from '@veduta/protocol'
import type { ReactNode } from 'react'
import { text } from './atom-helpers.ts'

export function browserLocales(): string[] | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.languages.length > 0 ? [...navigator.languages] : [navigator.language]
}

interface ValuePresentationOptions {
  timeZone?: string | undefined
  axis?: boolean | undefined
}

export function formatSurfaceValue(
  value: unknown,
  format?: ValueFormat,
  options: ValuePresentationOptions = {},
): { text: string; accessible: string; dateTime?: string } {
  const literal = text(value)
  if (format === 'text' || !DateValueSchema.safeParse(value).success)
    return { text: literal, accessible: literal }

  const dateOnly = literal.length === 10
  const date = new Date(literal)
  const withTime = !dateOnly && format !== 'date' && !options.axis
  // A calendar date has no instant or timezone; never shift it to the previous day.
  const timeZone = dateOnly ? 'UTC' : options.timeZone
  const locales = browserLocales()
  try {
    const compact = new Intl.DateTimeFormat(locales, {
      ...(options.axis
        ? { month: 'short', day: 'numeric' }
        : { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' } : {}) }),
      timeZone,
    }).format(date)
    const full = new Intl.DateTimeFormat(locales, {
      dateStyle: 'full',
      ...(!dateOnly ? { timeStyle: 'long' } : {}),
      timeZone,
    }).format(date)
    return { text: compact, accessible: `${full} (${literal})`, dateTime: literal }
  } catch {
    return { text: literal, accessible: literal }
  }
}

export function SurfaceValue({
  value,
  format,
  timeZone,
}: {
  value: unknown
  format?: ValueFormat | undefined
  timeZone?: string | undefined
}): ReactNode {
  const presentation = formatSurfaceValue(value, format, { timeZone })
  return presentation.dateTime ? (
    <time
      dateTime={presentation.dateTime}
      title={presentation.accessible}
      aria-label={presentation.accessible}
    >
      {presentation.text}
    </time>
  ) : (
    presentation.text
  )
}
