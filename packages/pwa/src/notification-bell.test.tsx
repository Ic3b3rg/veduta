// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationBell } from './notification-bell.tsx'
import { enablePush, pushSupported, syncPush } from './push.ts'

vi.mock('./push.ts', () => ({ enablePush: vi.fn(), pushSupported: vi.fn(), syncPush: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('Notification', { permission: 'default' })
  vi.stubGlobal('matchMedia', () => fromPartial<MediaQueryList>({ matches: false }))
  vi.mocked(pushSupported).mockReturnValue(true)
  vi.mocked(enablePush).mockResolvedValue('denied')
  vi.mocked(syncPush).mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('NotificationBell', () => {
  it('keeps denied feedback outside the header and dismisses it with focus return', async () => {
    render(
      <header>
        <NotificationBell token="owner-session" />
      </header>,
    )
    expect(enablePush).not.toHaveBeenCalled()
    const bell = screen.getByRole('button', { name: 'Enable notifications' })
    fireEvent.click(bell)
    const notice = await screen.findByRole('dialog', { name: 'Notifications' })
    await within(notice).findByText('Notifications are blocked in the browser settings.')
    expect(within(screen.getByRole('banner')).queryByRole('dialog')).toBeNull()
    expect(enablePush).toHaveBeenCalledExactlyOnceWith('owner-session')
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss notification notice' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(bell))
    fireEvent.click(bell)
    await screen.findByRole('dialog', { name: 'Notifications' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers retry after a failed subscription and hides the bell only after success', async () => {
    vi.mocked(enablePush).mockResolvedValueOnce('error').mockResolvedValueOnce('subscribed')
    render(<NotificationBell token="owner-session" />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))
    await screen.findByText("Couldn't enable notifications. Try again.")
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull(),
    )
    expect(enablePush).toHaveBeenCalledTimes(2)
  })

  it('does not call a dismissed prompt blocked', async () => {
    vi.mocked(enablePush).mockResolvedValue('dismissed')
    render(<NotificationBell token={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable notifications' }))
    await screen.findByText(
      'Notifications are not enabled. You can try again whenever you are ready.',
    )
    expect(screen.queryByText(/blocked/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
  })

  it('uses the same dismissible overlay for iOS installation guidance', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone Safari')
    vi.mocked(pushSupported).mockReturnValue(false)
    render(
      <header>
        <NotificationBell token={undefined} />
      </header>,
    )
    const bell = screen.getByRole('button', { name: 'Enable notifications' })
    fireEvent.click(bell)
    const guide = await screen.findByRole('dialog', {
      name: 'Install Veduta to enable notifications',
    })
    expect(within(guide).getByText('Tap the Share button in Safari.')).toBeDefined()
    expect(within(screen.getByRole('banner')).queryByRole('dialog')).toBeNull()
    expect(enablePush).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(bell)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss installation guide' }))
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull()
  })

  it('does not offer unsupported push', () => {
    vi.mocked(pushSupported).mockReturnValue(false)
    render(<NotificationBell token={undefined} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(enablePush).not.toHaveBeenCalled()
  })
})
