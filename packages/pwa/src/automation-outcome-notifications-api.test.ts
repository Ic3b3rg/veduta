import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissAutomationOutcomeNotification,
  fetchAutomationOutcomeNotifications,
  openAutomationOutcomeNotification,
} from './automation-outcome-notifications-api.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Automation outcome notification API', () => {
  it('reads an encoded Space snapshot with authentication', async () => {
    const body = { revision: 0, notifications: [] }
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAutomationOutcomeNotifications('spc/home', 'token')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spaces/spc%2Fhome/automation-outcome-notifications',
      { headers: { authorization: 'Bearer token' } },
    )
  })

  it.each([
    ['open', openAutomationOutcomeNotification, 'opened'],
    ['dismiss', dismissAutomationOutcomeNotification, 'dismissed'],
  ] as const)(
    'posts the exact %s action and parses confirmed state',
    async (action, invoke, state) => {
      const notification = { ...unread(), revision: 2, state }
      const body = { revision: 2, notification }
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify(body), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      await expect(invoke('spc-health', 'aon/1', 'token')).resolves.toEqual(body)
      const [path, init] = fetchMock.mock.calls[0]!
      expect(path).toBe(`/api/spaces/spc-health/automation-outcome-notifications/aon%2F1/${action}`)
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({})
    },
  )
})

function unread() {
  return {
    id: 'aon-1',
    revision: 1,
    spaceId: 'spc-health',
    spaceSlug: 'health',
    automationId: 12,
    surfaceId: 'srf-plan',
    kind: 'changed' as const,
    title: 'Plan updated',
    summary: 'Two new entries',
    coalesceKey: 'entries',
    occurrenceCount: 1,
    state: 'unread' as const,
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    href: '/app/space/health/surface/srf-plan',
  }
}
