// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
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
        onFocus={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onCreationFeedbackShown={vi.fn()}
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
        { merchant: 'Legacy shop', amount: 7 },
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
