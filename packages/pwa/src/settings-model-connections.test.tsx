// @vitest-environment jsdom
import type { ModelConnectionsSnapshot } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsModelConnections } from './settings-model-connections.tsx'

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

function emptySnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [
      {
        id: 'anthropic-api-key',
        provider: 'anthropic',
        providerDisplayName: 'Claude',
        methodDisplayName: 'API key',
        capabilities: {
          authorization: 'api-key',
          refresh: 'static',
          revocation: 'local-only',
          vedutaTools: true,
          metered: true,
        },
        available: true,
      },
    ],
    connections: [],
    selection: null,
  }
}

describe('SettingsModelConnections', () => {
  it('renders the panel and Back calls onBack', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(emptySnapshot())))
    const onBack = vi.fn()

    render(<SettingsModelConnections token="tok" onBack={onBack} />)

    expect(screen.getByRole('heading', { name: 'Model connections', level: 2 })).toBeDefined()

    await waitFor(() => {
      expect(document.getElementById('model-connection-method')).not.toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
