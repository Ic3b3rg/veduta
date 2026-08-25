import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePendingDecision } from './pending-decisions-api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolvePendingDecision', () => {
  it('posts an exact decision id and parses the authoritative terminal outcome', async () => {
    const body = {
      decision: {
        id: 'space-proposal:proposal-1',
        kind: 'space-proposal',
        summary: 'Create Space “Travel”',
        scope: { type: 'global' },
        allowedResolutions: ['accept', 'reject'],
        state: 'terminal',
        outcome: 'accepted',
        createdAt: '2026-08-25T10:00:00.000Z',
        decisionAt: '2026-08-25T10:01:00.000Z',
        resolvedAt: '2026-08-25T10:01:00.000Z',
        resolvedBy: 'trusted:user',
      },
      replayed: false,
    }
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePendingDecision('space-proposal:proposal-1', 'accept', 'test-token')

    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/pending-decisions/space-proposal%3Aproposal-1/resolve')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ resolution: 'accept' })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' })
    expect(result).toEqual(body)
  })
})
