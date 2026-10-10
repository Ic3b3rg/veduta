# Shared calendar input

Issue [#239](https://github.com/Ic3b3rg/veduta/issues/239) uses one DatePicker for Settings and
Surface inputs. The DatePicker Atom already supplies its closed props, calendar-only binding and
fast Action contract; changing its renderer also upgrades existing saved Surfaces.

## Component contract

The shared catalog UI exports Calendar, Popover, DatePicker and DateTimePicker. DatePicker is
controlled: it emits a real `YYYY-MM-DD` value and leaves persistence/confirmation to the caller.
It displays the browser-localized date without interpreting the value as a device-local instant.
The calendar grid uses `UTCDate` arithmetic through DayPicker's date-library override, so even a
civil day skipped in the device timezone stays selectable without shifting. Its Today marker still
follows the device's current calendar day. In DayPicker 10.0.2, `timeZone="UTC"` alone still uses
`TZDate` setters that normalize the skipped 2011-12-30 in Pacific/Apia; the regression tests exercise
that exact date through selection and refresh.
Only `allowEmpty` exposes Clear date. Trigger ARIA attributes carry the existing Action feedback.
Calendar locale data supplies month names, weekdays, week starts and accessible labels together.
The calendar and locales load on first open, outside the initial application bundle.

DateTimePicker composes this calendar with the shared time input, retaining partial local drafts.
Automation Settings displays the device timezone and enables saving only when both parts form a
valid local instant. A skipped daylight-saving time is refused rather than silently normalized.
An ambiguous repeated time uses the browser's earlier occurrence, as the previous native input
and JavaScript Date did. Recurring schedules keep their configured execution timezone.

Popover uses the existing presentation portal boundary, so keyboard focus and interaction stay
inside a modal Surface. Escape dismisses it; selection returns focus to the trigger. Calendar
navigation never submits an enclosing form. No new Agent tool, Atom or arbitrary markup is needed.

## Primary references

- [shadcn Date Picker](https://ui.shadcn.com/docs/components/radix/date-picker): compose Calendar
  and Popover, including the example with a separate time input.
- [shadcn Calendar source](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/calendar.tsx):
  source of the styled Calendar and day buttons, adapted to local imports and tokens. The upstream
  [MIT license](../licenses/shadcn-ui.md) is retained.
- [DayPicker localization](https://daypicker.dev/localization/changing-locale): locale-provided
  labels, language metadata and week conventions.
- [date-fns UTC](https://github.com/date-fns/utc): `UTCDate` performs calendar arithmetic without
  depending on the system timezone.
- [DayPicker date and time](https://daypicker.dev/guides/timepicker): compose inputs, synchronize
  values and validate local time before serializing the instant.

Validated against React DayPicker 10.0.2 on 2026-10-10. The shadcn-compatible `react-day-picker`
package name is retained.
