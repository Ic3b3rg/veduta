// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurfaceCard } from './surface-card.tsx'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-20T21:59:59.000Z'))
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SurfaceCard relative-time validity', () => {
  it('shows the legacy-data caveat and visibly expires at the declared boundary without a new event', () => {
    render(
      <SurfaceCard
        surface={relativeSurface()}
        selected={false}
        canMoveUp={false}
        canMoveDown={false}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
        onError={vi.fn()}
      />,
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('note').textContent).toContain(
      '1 source record has no occurrence date and is excluded from this relative-time view.',
    )

    act(() => vi.advanceTimersByTime(1_000))

    expect(screen.getByRole('status').textContent).toContain(
      'This relative-time view expired. Values below are preserved but are not current.',
    )
    expect(screen.getByText('Bookshop')).toBeDefined()
  })
})

describe('SurfaceCard material hierarchy', () => {
  it('embeds Atom content inside one pinnable Surface shell', () => {
    const surface = SurfaceSchema.parse({
      ...relativeSurface(),
      pinned: true,
      pinnable: true,
    })
    const { container } = render(
      <SurfaceCard
        surface={surface}
        selected={true}
        canMoveUp={false}
        canMoveDown={false}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
        onError={vi.fn()}
      />,
    )

    const card = container.querySelector('article.surface-card')
    expect(card?.classList.contains('pinned')).toBe(true)
    expect(card?.getAttribute('aria-current')).toBe('true')
    const pin = screen.getByRole('button', { name: 'Pin Daily spending' })
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(pin.getAttribute('title')).toBe('Unpin')

    const content = card?.querySelector(':scope > .surface-content')
    expect(content).not.toBeNull()
    expect(content?.querySelector(':scope > [data-veduta-theme="light"]')).not.toBeNull()
  })

  it('keeps ordering controls on the left and exposes Pin as an icon-only action', () => {
    const surface = SurfaceSchema.parse({
      ...relativeSurface(),
      pinned: false,
      pinnable: true,
    })
    const { container } = render(
      <SurfaceCard
        surface={surface}
        selected={false}
        canMoveUp={true}
        canMoveDown={true}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
        onError={vi.fn()}
      />,
    )

    const toolbar = container.querySelector('.surface-toolbar')
    expect(toolbar).not.toBeNull()
    expect(
      within(toolbar as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Move Daily spending up', 'Move Daily spending down', 'Pin Daily spending'])
    expect(screen.queryByRole('button', { name: 'Focus Daily spending' })).toBeNull()

    const pin = screen.getByRole('button', { name: 'Pin Daily spending' })
    expect(pin.textContent).toBe('')
    expect(pin.querySelector('svg')).not.toBeNull()
    expect(pin.getAttribute('title')).toBe('Pin')
  })
})

function relativeSurface() {
  return SurfaceSchema.parse({
    id: 'srf-daily-spending',
    spaceId: 'spc-finance',
    title: 'Daily spending',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'rows',
          type: 'Table',
          binding: 'todayRows',
          props: { columns: ['merchant', 'amount'] },
        },
      ],
    },
    state: {
      records: [
        { occurredAt: '2026-08-20T12:00:00+02:00', merchant: 'Bookshop', amount: 18 },
        { occurredAt: null, merchant: 'Legacy shop', amount: 7 },
      ],
      todayRows: [{ merchant: 'Bookshop', amount: 18 }],
    },
    freshness: { updatedAt: '2026-08-20T12:00:00.000Z', updatedBy: 'agent' },
    validity: {
      kind: 'relative-time',
      timeZone: 'Europe/Rome',
      window: 'day',
      startsAt: '2026-08-19T22:00:00.000Z',
      expiresAt: '2026-08-20T22:00:00.000Z',
      source: { stateKey: 'records' },
      projectionStateKeys: ['todayRows'],
    },
  })
}
