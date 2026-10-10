// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DatePicker } from './date-picker.tsx'
import { DateTimePicker, localDateTimeToIso } from './date-time-picker.tsx'
import { PortalContainerContext } from './portal-container.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('uses the browser locale, submits a calendar date without submitting its enclosing form, and returns focus', async () => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it-IT'])
  const change = vi.fn()
  const submit = vi.fn((event) => event.preventDefault())
  const view = render(
    <form onSubmit={submit}>
      <DatePicker aria-label="Due date" value="2026-10-01" onValueChange={change} />
    </form>,
  )
  const trigger = screen.getByRole('button', { name: 'Due date' })
  expect(trigger.textContent).toContain('1 ott 2026')
  fireEvent.click(trigger)
  const day = await screen.findByRole(
    'button',
    { name: /venerdì 2 ottobre 2026/i },
    { timeout: 5000 },
  )
  fireEvent.click(day)
  expect(change).toHaveBeenCalledExactlyOnceWith('2026-10-02')
  expect(submit).not.toHaveBeenCalled()
  expect(trigger.textContent).toContain('1 ott 2026')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  view.rerender(<DatePicker aria-label="Due date" value="2026-10-02" onValueChange={change} />)
  expect(screen.getByRole('button', { name: 'Due date' }).textContent).toContain('2 ott 2026')
})

it('clears only when allowed and places its calendar within the owning presentation boundary', async () => {
  const portal = document.createElement('div')
  document.body.append(portal)
  const change = vi.fn()
  const view = render(
    <PortalContainerContext.Provider value={portal}>
      <DatePicker aria-label="Due date" value="2024-02-29" onValueChange={change} />
    </PortalContainerContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Due date' }))
  await screen.findByRole('grid')
  expect(portal.querySelector('[data-slot="calendar"]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Clear date' })).toBeNull()
  view.rerender(
    <PortalContainerContext.Provider value={portal}>
      <DatePicker aria-label="Due date" value="2024-02-29" onValueChange={change} allowEmpty />
    </PortalContainerContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Clear date' }))
  expect(change).toHaveBeenCalledExactlyOnceWith('')
  view.unmount()
  portal.remove()
})

it('keeps date and time drafts controlled and exposes disabled controls', async () => {
  const change = vi.fn()
  render(
    <DateTimePicker
      label="Schedule"
      value={{ date: '2026-10-01', time: '09:30' }}
      onValueChange={change}
      disabled
    />,
  )
  expect(screen.getByRole('button', { name: 'Date' })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText('Time')).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Date' }))
  await act(async () => {})
  expect(screen.queryByRole('grid')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('rejects partial and impossible local date/time drafts and serializes the selected instant', () => {
  expect(localDateTimeToIso({ date: '', time: '09:30' })).toBeUndefined()
  expect(localDateTimeToIso({ date: '2026-02-30', time: '09:30' })).toBeUndefined()
  expect(localDateTimeToIso({ date: '2026-10-01', time: '' })).toBeUndefined()
  expect(localDateTimeToIso({ date: '2026-10-01', time: '25:00' })).toBeUndefined()
  const instant = localDateTimeToIso({ date: '2026-10-01', time: '09:30' })
  expect(instant).toBe(new Date(2026, 9, 1, 9, 30).toISOString())
  const date = new Date(instant!)
  expect([
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ]).toEqual([2026, 9, 1, 9, 30])
})
