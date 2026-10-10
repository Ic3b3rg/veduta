// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecisionFeedbackNotice } from './decision-feedback-notice.tsx'
import type { PendingDecisionFeedbackView } from './pending-decision-state.ts'

const now = new Date('2026-10-10T10:00:00Z')
const accepted: PendingDecisionFeedbackView = {
  id: 'tree-proposal:1',
  state: 'terminal',
  tone: 'success',
  text: 'Accepted: Change the Surface tree.',
  resolvedAt: now.toISOString(),
}

beforeEach(() => {
  sessionStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DecisionFeedbackNotice', () => {
  it('expires from resolution time, not from a replay or remount', () => {
    vi.setSystemTime(new Date(now.getTime() + 5_000))
    const { rerender, unmount } = render(<DecisionFeedbackNotice feedback={accepted} />)
    expect(screen.getByRole('status').textContent).toContain(accepted.text)
    act(() => vi.advanceTimersByTime(2_000))
    rerender(<DecisionFeedbackNotice feedback={{ ...accepted }} />)
    expect(screen.getByRole('status')).toBeDefined()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    render(<DecisionFeedbackNotice feedback={accepted} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not show a completed historical outcome when the page opens', () => {
    vi.setSystemTime(new Date(now.getTime() + 60_000))
    render(<DecisionFeedbackNotice feedback={accepted} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('dismisses only this lifecycle notice and remembers dismissal on remount', () => {
    const resolving: PendingDecisionFeedbackView = {
      id: accepted.id,
      state: 'resolving',
      tone: 'pending',
      text: 'In progress: Change the Surface tree.',
    }
    const first = render(<DecisionFeedbackNotice feedback={resolving} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss decision feedback' }))
    expect(screen.queryByRole('status')).toBeNull()
    first.unmount()
    const second = render(<DecisionFeedbackNotice feedback={resolving} />)
    expect(screen.queryByRole('status')).toBeNull()
    second.rerender(<DecisionFeedbackNotice feedback={accepted} />)
    expect(screen.getByRole('status').textContent).toContain(accepted.text)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss decision feedback' }))
    second.rerender(<DecisionFeedbackNotice feedback={{ ...accepted, id: 'tree-proposal:2' }} />)
    expect(screen.getByRole('status')).toBeDefined()
  })

  it.each(['warning', 'danger', 'pending'] as const)(
    'keeps %s feedback until explicitly dismissed',
    (tone) => {
      render(
        <DecisionFeedbackNotice
          feedback={{ ...accepted, tone, state: tone === 'pending' ? 'resolving' : 'terminal' }}
        />,
      )
      act(() => vi.advanceTimersByTime(60_000))
      expect(screen.getByRole('status')).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss decision feedback' }))
      expect(screen.queryByRole('status')).toBeNull()
    },
  )

  it('also retires an explicit rejection without confusing it with a failure', () => {
    render(<DecisionFeedbackNotice feedback={{ ...accepted, tone: 'muted' }} />)
    act(() => vi.advanceTimersByTime(8_000))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('bounds the lifetime when the server clock is ahead', () => {
    const future = { ...accepted, resolvedAt: new Date(now.getTime() + 60_000).toISOString() }
    const first = render(<DecisionFeedbackNotice feedback={future} />)
    act(() => vi.advanceTimersByTime(5_000))
    first.unmount()
    render(<DecisionFeedbackNotice feedback={future} />)
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still dismisses feedback when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    render(<DecisionFeedbackNotice feedback={accepted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss decision feedback' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
