// @vitest-environment jsdom
import type { AutomationOutcomeNotification } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpaceAutomationOutcomeNotifications } from './space-automation-outcome-notifications.tsx'

afterEach(cleanup)

describe('SpaceAutomationOutcomeNotifications', () => {
  it('renders explicit keyboard-operable Open Surface and Dismiss actions', () => {
    const onOpen = vi.fn()
    const onDismiss = vi.fn()
    const notification = changed()
    render(
      <SpaceAutomationOutcomeNotifications
        notifications={[notification]}
        pendingIds={new Set()}
        onOpen={onOpen}
        onDismiss={onDismiss}
      />,
    )

    expect(screen.getByRole('region', { name: 'Automation updates' })).toBeTruthy()
    expect(screen.getByText('2 occurrences')).toBeTruthy()
    const open = screen.getByRole('button', { name: 'Open Surface for Plan updated' })
    open.focus()
    fireEvent.keyDown(open, { key: 'Enter' })
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith(notification)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Plan updated' }))
    expect(onDismiss).toHaveBeenCalledWith(notification)
  })

  it('disables both actions while a confirmed mutation is pending', () => {
    const notification = changed()
    render(
      <SpaceAutomationOutcomeNotifications
        notifications={[notification]}
        pendingIds={new Set([notification.id])}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Open Surface for Plan updated' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: 'Dismiss Plan updated' })).toHaveProperty(
      'disabled',
      true,
    )
  })
})

function changed(): AutomationOutcomeNotification {
  return {
    id: 'aon-1',
    revision: 2,
    spaceId: 'spc-health',
    spaceSlug: 'health',
    automationId: 12,
    surfaceId: 'srf-plan',
    kind: 'changed',
    title: 'Plan updated',
    summary: 'Two new entries',
    coalesceKey: 'entries',
    occurrenceCount: 2,
    state: 'unread',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    href: '/app/space/health/surface/srf-plan',
  }
}
