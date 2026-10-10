import { AutomationScheduleSchema, type AutomationSchedule } from '@veduta/protocol'
import type { ReactNode } from 'react'
import { describeCron, scheduleLanguage } from './cron-description.ts'
import { SurfaceValue } from './surface-value.tsx'

export function AutomationScheduleDescription({
  schedule,
  details,
  enabled,
}: {
  schedule: string
  details?: AutomationSchedule | undefined
  enabled: boolean
}): ReactNode {
  const source = details ?? legacySchedule(schedule)
  if (!source) return schedule
  const italian = scheduleLanguage() === 'it'
  const timeZone = source.timezone ?? 'UTC'
  let zoneLabel = timeZone
  try {
    new Intl.DateTimeFormat(undefined, { timeZone })
  } catch {
    zoneLabel = `${italian ? 'Fuso orario non disponibile' : 'Timezone unavailable'}: ${timeZone}`
  }
  let rule: ReactNode
  if (source.kind === 'timer') {
    rule = source.fireAt ? (
      <>
        {italian ? 'Una volta il' : 'Once on'}{' '}
        <SurfaceValue value={source.fireAt} timeZone={timeZone} />
      </>
    ) : italian ? (
      'Data non disponibile'
    ) : (
      'Time unavailable'
    )
  } else {
    try {
      rule = describeCron(source.cron ?? '')
    } catch {
      rule = italian ? 'Programmazione non disponibile' : 'Schedule unavailable'
    }
  }
  return (
    <>
      <div>
        {rule} · {zoneLabel}
      </div>
      {source.status === 'completed' ? (
        <div>{italian ? 'Completata' : 'Completed'}</div>
      ) : source.status === 'cancelled' ? (
        <div>{italian ? 'Annullata' : 'Cancelled'}</div>
      ) : (
        source.kind === 'job' && (
          <div>
            {enabled
              ? italian
                ? 'Prossima esecuzione'
                : 'Next run'
              : italian
                ? 'In pausa · Prossimo orario programmato'
                : 'Paused · Next scheduled time'}
            :{' '}
            {source.nextRunAt ? (
              <SurfaceValue value={source.nextRunAt} timeZone={timeZone} />
            ) : italian ? (
              'non disponibile'
            ) : (
              'unavailable'
            )}
          </div>
        )
      )}
      {source.lastOutcome && (
        <div>
          {italian ? 'Ultimo risultato' : 'Last result'}: {source.lastOutcome}
        </div>
      )}
    </>
  )
}

/** Only the exact historical Scheduler projection is eligible for interpretation. */
function legacySchedule(value: string): AutomationSchedule | undefined {
  const [base = '', ...suffixes] = value.split(' — ')
  const cron = /^cron ([\d*/,\-\s]+)(?: \(([^)]+)\))?$/.exec(base)
  const timer = /^once at (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC|n\/a)$/.exec(base)
  if (!cron && !timer) return undefined
  if (
    suffixes.some(
      (part) => part !== 'done' && !part.startsWith('next ') && !part.startsWith('last: '),
    )
  )
    return undefined
  if (
    cron &&
    !suffixes.some((part) => /^next (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC|n\/a)$/.test(part))
  )
    return undefined
  const status = suffixes.includes('done') ? 'completed' : 'armed'
  const lastOutcome = suffixes.find((part) => part.startsWith('last: '))?.slice(6)
  const nextRunAt = legacyInstant(suffixes.find((part) => part.startsWith('next '))?.slice(5))
  const common = {
    timezone: cron?.[2] ?? 'UTC',
    status,
    ...(lastOutcome === undefined ? {} : { lastOutcome }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
  }
  const fireAt = legacyInstant(timer?.[1])
  const parsed = AutomationScheduleSchema.safeParse(
    cron
      ? { ...common, kind: 'job', cron: cron[1] }
      : { ...common, kind: 'timer', ...(fireAt === undefined ? {} : { fireAt }) },
  )
  return parsed.success ? parsed.data : undefined
}

function legacyInstant(value: string | undefined): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(value ?? '')
  return match ? `${match[1]}T${match[2]}Z` : undefined
}
