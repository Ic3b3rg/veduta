import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPendingDecisions, resolvePendingDecision } from './pending-decisions-api.ts'

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

describe('fetchPendingDecisions', () => {
  it('gets and validates the authoritative lifecycle snapshot', async () => {
    const body = {
      revision: 7,
      decisions: [
        {
          id: 'approval:effect-1',
          kind: 'approval',
          summary: 'Send message to alice@example.com',
          scope: { type: 'space', spaceId: 'spc-work' },
          allowedResolutions: ['approve', 'reject'],
          state: 'terminal',
          outcome: 'executed',
          createdAt: '2026-08-25T10:00:00.000Z',
          resolvedAt: '2026-08-25T10:01:00.000Z',
          resolvedBy: 'trusted:user',
        },
      ],
    }
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchPendingDecisions('test-token')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/pending-decisions', {
      headers: { authorization: 'Bearer test-token' },
    })
  })
})
