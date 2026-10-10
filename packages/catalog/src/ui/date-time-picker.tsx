import { isControlDate } from '@veduta/protocol'
import { DatePicker } from './date-picker.tsx'
import { Input } from './input.tsx'

export interface LocalDateTime {
  date: string
  time: string
}

/** Reject normalization (including skipped daylight-saving times) rather than scheduling another time. */
export function localDateTimeToIso({ date, time }: LocalDateTime): string | undefined {
  if (!isControlDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined
  const instant = new Date(`${date}T${time}:00`)
  if (!Number.isFinite(instant.getTime())) return undefined
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  if (
    instant.getFullYear() !== year ||
    instant.getMonth() + 1 !== month ||
    instant.getDate() !== day ||
    instant.getHours() !== hours ||
    instant.getMinutes() !== minutes
  )
    return undefined
  return instant.toISOString()
}

export function DateTimePicker({
  label,
  value,
  onValueChange,
  disabled = false,
}: {
  label: string
  value: LocalDateTime
  onValueChange: (value: LocalDateTime) => void
  disabled?: boolean | undefined
}) {
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-2 border-0 p-0">
      <legend className="mb-2 text-sm">{label}</legend>
      <label className="grid min-w-0 gap-2 text-sm">
        Date
        <DatePicker
          aria-label="Date"
          value={value.date}
          onValueChange={(date) => onValueChange({ ...value, date })}
          disabled={disabled}
        />
      </label>
      <label className="grid min-w-0 gap-2 text-sm">
        Time
        <Input
          type="time"
          className="pointer-coarse:min-h-[var(--catalog-control-touch-target,2.75rem)]"
          value={value.time}
          onChange={(event) => onValueChange({ ...value, time: event.currentTarget.value })}
          disabled={disabled}
          required={value.date !== ''}
        />
      </label>
    </fieldset>
  )
}
