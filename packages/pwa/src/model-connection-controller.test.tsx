// @vitest-environment jsdom
import type { ModelConnection, ModelConnectionsSnapshot } from '@veduta/protocol'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModelConnectionsController } from './model-connection-controller.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptySnapshot(
  overrides: Partial<ModelConnectionsSnapshot> = {},
): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [],
    connections: [],
    selection: null,
    ...overrides,
  }
}

describe('useModelConnectionsController', () => {
  it('fetches the snapshot on mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emptySnapshot()))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useModelConnectionsController('tok'))

    await waitFor(() => expect(result.current.snapshot).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/model-connections',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer tok' }),
      }),
    )
  })

  it('surfaces the load failure as error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'daemon offline' }, 500)),
    )

    const { result } = renderHook(() => useModelConnectionsController())

    await waitFor(() => expect(result.current.error).toBe('daemon offline'))
    expect(result.current.snapshot).toBeUndefined()
  })

  it('polls a waiting connection through its refresh endpoint and stops once it resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const waitingConnection: ModelConnection = {
      id: 'b1b1b1b1-0000-4000-8000-000000000001',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI',
      state: 'waiting-for-user',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      challenge: {
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-08-09T00:15:00.000Z',
        expirySource: 'veduta-default',
      },
    }
    const connectedConnection: ModelConnection = {
      id: waitingConnection.id,
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI',
      state: 'connected',
      stateAt: '2026-08-09T00:00:02.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      account: { label: 'prolite' },
      catalog: [{ id: 'gpt-5.5', label: 'GPT-5.5', routable: true }],
      catalogFetchedAt: '2026-08-09T00:00:02.000Z',
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptySnapshot({ connections: [waitingConnection] })))
      .mockResolvedValue(jsonResponse(connectedConnection))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useModelConnectionsController())

    await vi.waitFor(() =>
      expect(result.current.snapshot?.connections[0]?.state).toBe('waiting-for-user'),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(result.current.snapshot?.connections[0]?.state).toBe('connected')
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/model-connections/${waitingConnection.id}`,
      expect.anything(),
    )

    const callsAfterConnected = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(fetchMock.mock.calls.length).toBe(callsAfterConnected)

    vi.useRealTimers()
  })

  it('a rejected action sets error and busy toggles back to false, without changing the snapshot', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptySnapshot()))
      .mockResolvedValueOnce(jsonResponse({ error: 'the provider rejected the key' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useModelConnectionsController())
    await waitFor(() => expect(result.current.snapshot).toBeDefined())

    act(() => {
      result.current.onCreate({ method: 'anthropic-api-key', apiKey: 'sk-bad' })
    })

    await waitFor(() => expect(result.current.error).toBe('the provider rejected the key'))
    expect(result.current.busy).toBe(false)
  })

  it('onApplySelection resolves false when the request fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(emptySnapshot()))
      .mockResolvedValueOnce(jsonResponse({ error: 'the provider rejected the probe' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useModelConnectionsController())
    await waitFor(() => expect(result.current.snapshot).toBeDefined())

    let committed: boolean | undefined
    await act(async () => {
      committed = await result.current.onApplySelection('connection-1', 'model-1')
    })

    expect(committed).toBe(false)
    expect(result.current.error).toBe('the provider rejected the probe')
    expect(result.current.busy).toBe(false)
  })
})
