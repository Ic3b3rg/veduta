// @vitest-environment jsdom
import type { ModelConnection, ModelConnectionsSnapshot } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatModelSelects } from './chat-model-selects.tsx'

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

const connectedConnection: ModelConnection = {
  id: 'a1a1a1a1-0000-4000-8000-000000000001',
  method: 'anthropic-api-key',
  provider: 'anthropic',
  label: 'Claude',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
  selectedModelId: 'claude-sonnet-5',
  catalog: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet', routable: true },
    { id: 'claude-opus-5', label: 'Claude Opus', routable: true },
  ],
}

function connectedSnapshot(
  overrides: Partial<ModelConnectionsSnapshot> = {},
): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [],
    connections: [connectedConnection],
    selection: { connectionId: connectedConnection.id, modelId: 'claude-sonnet-5' },
    ...overrides,
  }
}

describe('ChatModelSelects', () => {
  it('shows the active global connection and model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(connectedSnapshot())))

    render(<ChatModelSelects token="tok" />)

    const connectionSelect = await screen.findByRole('combobox', { name: 'Connection' })
    const modelSelect = screen.getByRole('combobox', { name: 'Model' })
    await waitFor(() =>
      expect((connectionSelect as HTMLSelectElement).value).toBe(connectedConnection.id),
    )
    expect((modelSelect as HTMLSelectElement).value).toBe('claude-sonnet-5')
  })

  it('a rejected model change restores the previous selection and shows the provider exact reason', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(connectedSnapshot()))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'the provider rejected the probe: invalid_api_key' }, 400),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<ChatModelSelects token="tok" />)

    const modelSelect = (await screen.findByRole('combobox', {
      name: 'Model',
    })) as HTMLSelectElement
    await waitFor(() => expect(modelSelect.value).toBe('claude-sonnet-5'))

    fireEvent.change(modelSelect, { target: { value: 'claude-opus-5' } })

    await screen.findByText('the provider rejected the probe: invalid_api_key')
    expect(screen.getByRole('alert').textContent).toBe(
      'the provider rejected the probe: invalid_api_key',
    )
    // Verify-then-commit: the rejected apply committed nothing server-side,
    // so the select -- controlled by the untouched snapshot -- snaps back to
    // the value that was actually applied last.
    await waitFor(() => expect(modelSelect.value).toBe('claude-sonnet-5'))
  })

  it('offers no way to add or revoke a connection, nor its own settings-view button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(connectedSnapshot())))

    render(<ChatModelSelects token="tok" />)

    await screen.findByRole('combobox', { name: 'Connection' })
    expect(screen.queryByRole('button', { name: /^add/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^authorize$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^revoke$/i })).toBeNull()
    expect(screen.queryByLabelText(/api key/i)).toBeNull()
    // The "Model connections" button lives unconditionally in the topbar
    // (`app.tsx`) since issue #47, not inside this self-contained,
    // no-connections-renders-nothing component.
    expect(screen.queryByRole('button', { name: 'Model connections' })).toBeNull()
  })

  it('renders nothing when no connections exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          vaultAvailable: true,
          mockEnabled: true,
          mockControlAvailable: false,
          methods: [],
          connections: [],
          selection: null,
        } satisfies ModelConnectionsSnapshot),
      ),
    )

    const { container } = render(<ChatModelSelects token="tok" />)

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
