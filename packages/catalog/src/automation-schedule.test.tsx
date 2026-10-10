// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function automation(props: Record<string, unknown>) {
  const surface = SurfaceSchema.parse({
    id: 'srf-automations',
    spaceId: 'spc-health',
    title: 'Automations',
    state: {},
    freshness: { updatedAt: '2026-10-09T04:00:00.000Z', updatedBy: 'job' },
    tree: {
      id: 'automation',
      type: 'Automation',
      props: {
        label: 'Review Health',
        schedule: 'Legacy fallback',
        enabled: true,
        ...props,
      },
    },
  })
  return render(renderNode(surface.tree, { state: {}, dispatch: vi.fn() }))
}

describe('Automation schedule presentation', () => {
  it.each([
    ['en-US', 'At 4:00 AM every day', 'Oct 10, 2026, 4:00 AM', 'Next run'],
    ['it-IT', 'Alle 04:00 ogni giorno', '10 ott 2026, 04:00', 'Prossima esecuzione'],
  ])('describes a local recurring rule and next run for %s', (locale, rule, next, prefix) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale])
    const view = automation({
      scheduleDetails: {
        kind: 'job',
        cron: '0 4 * * *',
        timezone: 'Europe/Rome',
        nextRunAt: '2026-10-10T02:00:00.000Z',
        status: 'armed',
      },
    })
    expect(view.container.textContent).toContain(rule)
    expect(view.container.textContent).toContain('Europe/Rome')
    expect(view.container.textContent).toContain(`${prefix}: ${next}`)
    expect(view.container.textContent).not.toContain('0 4 * * *')
    expect(view.container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-10T02:00:00.000Z',
    )
  })

  it('upgrades the existing stored scheduler labels at render time', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    const view = automation({
      schedule: 'cron 0 4 * * * (Europe/Rome) — next 2026-10-10 02:00 UTC',
    })
    expect(view.container.textContent).toContain('At 4:00 AM every day')
    expect(view.container.textContent).toContain('Next run: Oct 10, 2026, 4:00 AM')
    expect(view.container.textContent).not.toContain('cron ')
    view.unmount()
    const timer = automation({ schedule: 'once at 2026-10-09 21:00 UTC — done' })
    expect(timer.container.textContent).toContain('Once on Oct 9, 2026, 9:00 PM')
    expect(timer.container.textContent).toContain('Completed')
    expect(timer.container.textContent).not.toContain('Next run')
  })

  it.each([
    ['*/20 * * * *', 'Every 20 minutes every day'],
    ['*/17 * * * *', 'At minutes 0, 17, 34, and 51 of every hour every day'],
    ['0 9 * * 1-5', 'At 9:00 AM on Monday–Friday'],
    ['0 0 13 * 5', 'At 12:00 AM on day 13 of the month or on Friday'],
    [
      '0 9 */2 * 5',
      'At 9:00 AM on days 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, and 31 of the month and on Friday',
    ],
    ['0 9 1-31 * 1', 'At 9:00 AM every day'],
    ['5/2 4 * * 7', 'At 4:05 AM on Sunday'],
    [
      '*/20 9-11 1,15 1,6 1-5/2',
      'At minutes 0, 20, and 40 during hours 09–11 (24-hour clock) on days 1 and 15 of the month or on Monday, Wednesday, and Friday; in January and June',
    ],
  ])('faithfully describes all fields of %s using the execution grammar', (cron, rule) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    const view = automation({ scheduleDetails: { kind: 'job', cron, timezone: 'UTC' } })
    expect(view.container.textContent).toContain(`${rule} · UTC`)
    expect(view.container.textContent).toContain('Next run: unavailable')
  })

  it('retains the configured wall time across a seasonal offset and labels paused schedules honestly', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it-IT'])
    const view = automation({
      enabled: false,
      scheduleDetails: {
        kind: 'job',
        cron: '0 4 * * *',
        timezone: 'Europe/Rome',
        nextRunAt: '2027-01-10T03:00:00.000Z',
      },
    })
    expect(view.container.textContent).toContain('Alle 04:00 ogni giorno')
    expect(view.container.textContent).toContain(
      'In pausa · Prossimo orario programmato: 10 gen 2027, 04:00',
    )
    expect(view.container.textContent).not.toContain('Prossima esecuzione:')
  })

  it('shows unavailable schedule values without guessing and leaves authored natural text literal', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    let view = automation({ scheduleDetails: { kind: 'job', cron: 'not a cron', timezone: 'UTC' } })
    expect(view.container.textContent).toContain('Schedule unavailable')
    view.unmount()
    view = automation({ scheduleDetails: { kind: 'timer' } })
    expect(view.container.textContent).toContain('Time unavailable')
    view.unmount()
    view = automation({ schedule: 'Every time I finish a book' })
    expect(screen.getByText('Every time I finish a book')).toBeDefined()
    view.unmount()
    view = automation({
      scheduleDetails: {
        kind: 'job',
        cron: '0 4 * * *',
        timezone: 'Missing/Zone',
        nextRunAt: '2026-10-10T02:00:00.000Z',
      },
    })
    expect(view.container.textContent).toContain('Timezone unavailable: Missing/Zone')
    expect(view.container.textContent).toContain('2026-10-10T02:00:00.000Z')
  })
})
