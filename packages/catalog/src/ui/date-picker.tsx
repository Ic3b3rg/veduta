import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react'
import { CalendarIcon } from 'lucide-react'
import { cn } from 'cn'
import { isControlDate } from '@veduta/protocol'
import { UTCDate } from '@date-fns/utc'
import { formatSurfaceValue } from '../surface-value.tsx'
import { Button } from './button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx'

// Load the calendar and its locale data only when a user opens a picker.
const Calendar = lazy(() =>
  import('./calendar.tsx').then((module) => ({ default: module.Calendar })),
)

const calendarDates = {
  newDate: (year: number, month: number, day: number) => new UTCDate(year, month, day),
}

type DatePickerProps = Omit<
  ComponentProps<typeof Button>,
  'value' | 'onChange' | 'onSelect' | 'children' | 'type' | 'ref'
> & {
  value: string
  onValueChange: (value: string) => void
  allowEmpty?: boolean | undefined
}

/** Calendar-only wire values; the parent owns confirmation and persistence. */
export function DatePicker({
  value,
  onValueChange,
  allowEmpty = false,
  disabled,
  className,
  ...props
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (disabled || !restoreFocus.current) return
    restoreFocus.current = false
    if (document.activeElement === document.body) trigger.current?.focus()
  }, [disabled])
  // UTC calendar arithmetic preserves date-only values even across skipped civil days.
  const selected = isControlDate(value) ? new UTCDate(`${value}T12:00:00Z`) : undefined
  const now = new Date()
  const today = new UTCDate(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const label = props['aria-label'] ?? 'Choose date'
  function choose(date: Date | undefined) {
    if (disabled || (!date && !allowEmpty)) return
    const next = date ? date.toISOString().slice(0, 10) : ''
    if (isControlDate(next, allowEmpty)) onValueChange(next)
    setOpen(false)
  }
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          {...props}
          ref={trigger}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            'w-full min-w-0 justify-between font-normal pointer-coarse:min-h-[var(--catalog-control-touch-target,2.75rem)]',
            className,
          )}
        >
          <span className="truncate">
            {selected ? formatSurfaceValue(value, 'date').text : 'Choose date'}
          </span>
          <CalendarIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-0.125rem)] p-0"
        collisionPadding={1}
        aria-label={label}
        onCloseAutoFocus={(event) => {
          if (trigger.current?.disabled) {
            event.preventDefault()
            restoreFocus.current = true
          }
        }}
      >
        <Suspense
          fallback={
            <div className="p-4" role="status">
              Loading calendar…
            </div>
          }
        >
          <Calendar
            mode="single"
            dateLib={calendarDates}
            today={today}
            selected={selected}
            {...(selected ? { defaultMonth: selected } : {})}
            onSelect={choose}
            required
            autoFocus
          />
        </Suspense>
        {allowEmpty && (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full pointer-coarse:min-h-[var(--catalog-control-touch-target,2.75rem)]"
              disabled={!selected}
              onClick={() => choose(undefined)}
            >
              Clear date
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
