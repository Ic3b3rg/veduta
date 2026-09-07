// @vitest-environment jsdom
import type {
  AutomationOutcomeNotification,
  AutomationOutcomeNotificationActionResult,
  AutomationOutcomeNotificationLifecycleMessage,
  AutomationOutcomeNotificationSnapshot,
} from '@veduta/protocol'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './automation-outcome-notifications-api.ts'

vi.mock('./automation-outcome-notifications-api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchAutomationOutcomeNotifications: vi.fn(),
  openAutomationOutcomeNotification: vi.fn(),
  dismissAutomationOutcomeNotification: vi.fn(),
}))

import {
  dismissAutomationOutcomeNotification,
  fetchAutomationOutcomeNotifications,
  openAutomationOutcomeNotification,
} from './automation-outcome-notifications-api.ts'
import { useAutomationOutcomeNotificationSync } from './use-automation-outcome-notification-sync.ts'

beforeEach(() => {
  vi.mocked(fetchAutomationOutcomeNotifications).mockReset()
  vi.mocked(openAutomationOutcomeNotification).mockReset()
  vi.mocked(dismissAutomationOutcomeNotification).mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useAutomationOutcomeNotificationSync', () => {
  it('buffers lifecycle frames and does not let an older snapshot resurrect terminal state', async () => {
    const snapshot = deferred<AutomationOutcomeNotificationSnapshot>()
    vi.mocked(fetchAutomationOutcomeNotifications).mockReturnValueOnce(snapshot.promise)
    const { result } = renderHook(() =>
      useAutomationOutcomeNotificationSync(options({ spaceId: 'spc-health' })),
    )

    act(() => {
      result.current.refresh()
      result.current.handleLifecycle(lifecycle(3, { state: 'dismissed' }))
      result.current.handleLifecycle(lifecycle(2))
    })
    await act(async () => snapshot.resolve({ revision: 1, notifications: [unread()] }))

    expect(result.current.notifications).toEqual([])
    act(() => result.current.handleLifecycle(lifecycle(2)))
    expect(result.current.notifications).toEqual([])
  })

  it('ignores other-Space frames and recovers the newly focused Space snapshot', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications).mockResolvedValueOnce({
      revision: 4,
      notifications: [unread({ spaceId: 'spc-work', spaceSlug: 'work' })],
    })
    const { result, rerender } = renderHook(
      ({ spaceId }) => useAutomationOutcomeNotificationSync(options({ spaceId })),
      { initialProps: { spaceId: 'spc-health' as string | undefined } },
    )
    act(() =>
      result.current.handleLifecycle(lifecycle(5, { spaceId: 'spc-work', spaceSlug: 'work' })),
    )
    expect(result.current.notifications).toEqual([])

    rerender({ spaceId: 'spc-work' })
    await act(async () => result.current.refresh())
    expect(result.current.notifications).toMatchObject([{ spaceId: 'spc-work' }])
  })

  it('accepts a lower restored revision after reconnect and rejects frames from the old socket', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications)
      .mockResolvedValueOnce({ revision: 9, notifications: [unread({ revision: 9 })] })
      .mockResolvedValueOnce({
        revision: 2,
        notifications: [unread({ revision: 2, summary: 'Restored backup outcome' })],
      })
    const { result } = renderHook(() =>
      useAutomationOutcomeNotificationSync(options({ spaceId: 'spc-health' })),
    )
    let oldSocketHandler!: (message: AutomationOutcomeNotificationLifecycleMessage) => void
    act(() => {
      oldSocketHandler = result.current.beginConnection()
    })
    await act(async () => result.current.refresh())
    expect(result.current.notifications).toMatchObject([{ revision: 9 }])

    let restoredSocketHandler!: (message: AutomationOutcomeNotificationLifecycleMessage) => void
    act(() => {
      restoredSocketHandler = result.current.beginConnection()
    })
    await act(async () => result.current.refresh())
    expect(result.current.notifications).toMatchObject([
      { revision: 2, summary: 'Restored backup outcome' },
    ])

    act(() => {
      oldSocketHandler(lifecycle(10, { summary: 'Stale old-daemon frame' }))
      restoredSocketHandler(lifecycle(3, { summary: 'Current restored frame' }))
    })
    expect(result.current.notifications).toMatchObject([
      { revision: 3, summary: 'Current restored frame' },
    ])
  })

  it('navigates only after open is confirmed and applies dismiss confirmation', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications).mockResolvedValue({
      revision: 1,
      notifications: [unread()],
    })
    const opened = deferred<AutomationOutcomeNotificationActionResult>()
    vi.mocked(openAutomationOutcomeNotification).mockReturnValueOnce(opened.promise)
    vi.mocked(dismissAutomationOutcomeNotification).mockResolvedValueOnce({
      revision: 3,
      notification: unread({ revision: 3, state: 'dismissed' }),
    })
    const onOpenSurface = vi.fn()
    const { result } = renderHook(() =>
      useAutomationOutcomeNotificationSync(options({ spaceId: 'spc-health', onOpenSurface })),
    )
    await act(async () => result.current.refresh())

    let opening!: Promise<void>
    act(() => {
      opening = result.current.open(result.current.notifications[0]!)
    })
    expect(onOpenSurface).not.toHaveBeenCalled()
    act(() => result.current.handleLifecycle(lifecycle(5, { id: 'aon-other', state: 'dismissed' })))
    await act(async () =>
      opened.resolve({
        revision: 2,
        notification: unread({ revision: 2, state: 'opened' }),
      }),
    )
    await opening
    expect(onOpenSurface).toHaveBeenCalledWith('/app/space/health/surface/srf-plan')
    expect(result.current.notifications).toEqual([])

    await act(async () => result.current.refresh())
    expect(result.current.notifications).toEqual([])
    act(() => result.current.handleLifecycle(lifecycle(2)))
    expect(result.current.notifications).toEqual([])

    act(() => result.current.handleLifecycle(lifecycle(6)))
    await act(async () => result.current.dismiss(result.current.notifications[0]!))
    expect(dismissAutomationOutcomeNotification).toHaveBeenCalledWith(
      'spc-health',
      'aon-1',
      'token',
    )
    expect(result.current.notifications).toEqual([])
  })

  it('does not navigate when a stale open request confirms another client dismissed first', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications).mockResolvedValue({
      revision: 1,
      notifications: [unread()],
    })
    vi.mocked(openAutomationOutcomeNotification).mockResolvedValue({
      revision: 2,
      notification: unread({ revision: 2, state: 'dismissed' }),
    })
    const onOpenSurface = vi.fn()
    const { result } = renderHook(() =>
      useAutomationOutcomeNotificationSync(options({ spaceId: 'spc-health', onOpenSurface })),
    )
    await act(async () => result.current.refresh())

    await act(async () => result.current.open(result.current.notifications[0]!))

    expect(onOpenSurface).not.toHaveBeenCalled()
    expect(result.current.notifications).toEqual([])
  })

  it('ignores an action response from the daemon connection replaced during the request', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications)
      .mockResolvedValueOnce({ revision: 2, notifications: [unread({ revision: 2 })] })
      .mockResolvedValueOnce({ revision: 1, notifications: [unread({ revision: 1 })] })
    const opened = deferred<AutomationOutcomeNotificationActionResult>()
    vi.mocked(openAutomationOutcomeNotification).mockReturnValueOnce(opened.promise)
    const onOpenSurface = vi.fn()
    const { result } = renderHook(() =>
      useAutomationOutcomeNotificationSync(options({ spaceId: 'spc-health', onOpenSurface })),
    )
    act(() => void result.current.beginConnection())
    await act(async () => result.current.refresh())
    let opening!: Promise<void>
    act(() => {
      opening = result.current.open(result.current.notifications[0]!)
      result.current.beginConnection()
    })
    await act(async () => result.current.refresh())
    await act(async () =>
      opened.resolve({
        revision: 10,
        notification: unread({ revision: 10, state: 'opened' }),
      }),
    )
    await opening

    expect(onOpenSurface).not.toHaveBeenCalled()
    expect(result.current.notifications).toMatchObject([{ revision: 1, state: 'unread' }])
    act(() => result.current.handleLifecycle(lifecycle(2, { summary: 'Current frame' })))
    expect(result.current.notifications).toMatchObject([{ revision: 2, summary: 'Current frame' }])
  })

  it('does not navigate to a stale Space after focus changes during an open request', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications).mockResolvedValue({
      revision: 1,
      notifications: [unread()],
    })
    const opened = deferred<AutomationOutcomeNotificationActionResult>()
    vi.mocked(openAutomationOutcomeNotification).mockReturnValueOnce(opened.promise)
    const onOpenSurface = vi.fn()
    const { result, rerender } = renderHook(
      ({ spaceId }) => useAutomationOutcomeNotificationSync(options({ spaceId, onOpenSurface })),
      { initialProps: { spaceId: 'spc-health' as string | undefined } },
    )
    await act(async () => result.current.refresh())
    let opening!: Promise<void>
    act(() => {
      opening = result.current.open(result.current.notifications[0]!)
    })

    rerender({ spaceId: 'spc-work' })
    await act(async () =>
      opened.resolve({
        revision: 2,
        notification: unread({ revision: 2, state: 'opened' }),
      }),
    )
    await opening

    expect(onOpenSurface).not.toHaveBeenCalled()
  })

  it('does not replace newer same-Space navigation when an open request resolves late', async () => {
    vi.mocked(fetchAutomationOutcomeNotifications).mockResolvedValue({
      revision: 1,
      notifications: [unread()],
    })
    const opened = deferred<AutomationOutcomeNotificationActionResult>()
    vi.mocked(openAutomationOutcomeNotification).mockReturnValueOnce(opened.promise)
    const onOpenSurface = vi.fn()
    const { result, rerender } = renderHook(
      ({ focusKey }) =>
        useAutomationOutcomeNotificationSync(
          options({ spaceId: 'spc-health', focusKey, onOpenSurface }),
        ),
      { initialProps: { focusKey: 'location-a:srf-overview' } },
    )
    await act(async () => result.current.refresh())
    let opening!: Promise<void>
    act(() => {
      opening = result.current.open(result.current.notifications[0]!)
    })

    rerender({ focusKey: 'location-b:srf-journal' })
    await act(async () =>
      opened.resolve({
        revision: 2,
        notification: unread({ revision: 2, state: 'opened' }),
      }),
    )
    await opening

    expect(onOpenSurface).not.toHaveBeenCalled()
    expect(result.current.notifications).toEqual([])
  })
})

function options(overrides: {
  spaceId?: string | undefined
  focusKey?: string | undefined
  onOpenSurface?: (href: string) => void
}) {
  return {
    authToken: 'token',
    spaceId: overrides.spaceId,
    focusKey: overrides.focusKey ?? `focus:${overrides.spaceId ?? 'none'}`,
    onOpenSurface: overrides.onOpenSurface ?? vi.fn(),
    onUnauthorized: vi.fn(),
    onError: vi.fn(),
  }
}

function unread(
  overrides: Partial<AutomationOutcomeNotification> = {},
): AutomationOutcomeNotification {
  return {
    id: 'aon-1',
    revision: 1,
    spaceId: 'spc-health',
    spaceSlug: 'health',
    automationId: 12,
    surfaceId: 'srf-plan',
    kind: 'changed',
    title: 'Plan updated',
    summary: 'Two new entries',
    coalesceKey: 'entries',
    occurrenceCount: 1,
    state: 'unread',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    href: '/app/space/health/surface/srf-plan',
    ...overrides,
  }
}

function lifecycle(
  revision: number,
  overrides: Partial<AutomationOutcomeNotification> = {},
): AutomationOutcomeNotificationLifecycleMessage {
  return {
    type: 'automation-outcome-notification.lifecycle',
    revision,
    notification: unread({ revision, ...overrides }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
