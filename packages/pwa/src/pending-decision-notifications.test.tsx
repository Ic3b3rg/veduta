// @vitest-environment jsdom
import type { PendingDecision } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PendingDecisionStrip,
  type PendingDecisionNotification,
} from './pending-decision-notifications.tsx'

afterEach(cleanup)

describe('PendingDecisionStrip', () => {
  it('expands one accessible global summary into exact quick actions and safe Review links', () => {
    const onResolve = vi.fn()
    const notifications: PendingDecisionNotification[] = [
      {
        decision: decision('approval:effect-1', 'Send the signed contract'),
        reviewPath: '/app/space/work/surface/srf-approval-effect-1',
      },
      {
        decision: {
          ...decision('space-proposal:proposal-1', 'Create Space “Travel”'),
          kind: 'space-proposal',
          scope: { type: 'global' },
          allowedResolutions: ['accept', 'reject'],
          decisionSurfaceId: undefined,
        },
      },
      {
        decision: {
          ...decision('update-offer:2.0.0', 'Install Veduta 2.0.0'),
          kind: 'update-offer',
          scope: { type: 'global' },
          allowedResolutions: ['apply'],
          decisionSurfaceId: undefined,
        },
      },
    ]

    render(
      <MemoryRouter>
        <PendingDecisionStrip
          notifications={notifications}
          resolvingDecisionIds={new Set()}
          onResolve={onResolve}
        />
      </MemoryRouter>,
    )

    const toggle = screen.getByRole('button', { name: '3 decisions await review' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Send the signed contract')).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const contract = screen.getByRole('article', { name: 'Send the signed contract' })
    const travel = screen.getByRole('article', { name: 'Create Space “Travel”' })
    const update = screen.getByRole('article', { name: 'Install Veduta 2.0.0' })
    const review = within(contract).getByRole('link', { name: 'Review Send the signed contract' })
    expect(review.getAttribute('href')).toBe('/app/space/work/surface/srf-approval-effect-1')
    expect(within(travel).queryByRole('link', { name: /Review/ })).toBeNull()
    expect(
      within(contract).getByRole('button', { name: 'Reject Send the signed contract' }),
    ).toBeDefined()
    expect(
      within(travel).getByRole('button', { name: 'Reject Create Space “Travel”' }),
    ).toBeDefined()

    fireEvent.click(
      within(contract).getByRole('button', { name: 'Approve Send the signed contract' }),
    )
    fireEvent.click(within(travel).getByRole('button', { name: 'Accept Create Space “Travel”' }))
    fireEvent.click(within(update).getByRole('button', { name: 'Apply Install Veduta 2.0.0' }))

    expect(onResolve).toHaveBeenNthCalledWith(1, 'approval:effect-1', 'approve')
    expect(onResolve).toHaveBeenNthCalledWith(2, 'space-proposal:proposal-1', 'accept')
    expect(onResolve).toHaveBeenNthCalledWith(3, 'update-offer:2.0.0', 'apply')
  })
})

function decision(id: string, summary: string): PendingDecision {
  return {
    id,
    kind: 'approval',
    summary,
    scope: { type: 'space', spaceId: 'spc-work' },
    allowedResolutions: ['approve', 'reject'],
    state: 'pending',
    decisionSurfaceId: `srf-${id.replace(':', '-')}`,
    createdAt: '2026-08-28T10:00:00.000Z',
  }
}
