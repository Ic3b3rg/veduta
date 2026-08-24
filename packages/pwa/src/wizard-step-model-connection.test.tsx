// @vitest-environment jsdom
import type { ModelConnectionsSnapshot, OnboardingStatus } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WizardStepModelConnection } from './wizard-step-model-connection.tsx'

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

const anthropicApiKeyMethod = {
  id: 'anthropic-api-key' as const,
  provider: 'anthropic',
  providerDisplayName: 'Claude',
  methodDisplayName: 'API key',
  capabilities: {
    authorization: 'api-key' as const,
    refresh: 'static' as const,
    revocation: 'local-only' as const,
    metered: true,
  },
  primaryRoutable: true,
  available: true,
}

function connectedVerifiedSnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [anthropicApiKeyMethod],
    connections: [
      {
        id: 'a1a1a1a1-0000-4000-8000-000000000001',
        method: 'anthropic-api-key',
        provider: 'anthropic',
        label: 'Claude',
        state: 'connected',
        stateAt: '2026-08-09T00:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-08-09T00:00:00.000Z',
        selectedModelId: 'claude-sonnet-5',
        catalog: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet', routable: true }],
      },
    ],
    selection: { connectionId: 'a1a1a1a1-0000-4000-8000-000000000001', modelId: 'claude-sonnet-5' },
  }
}

function buildStatus(profile: 'loopback' | 'local-vps' | 'vps'): OnboardingStatus {
  return fromPartial<OnboardingStatus>({ profile })
}

describe('WizardStepModelConnection', () => {
  it('renders Continue and Add another connection after a verified selection, and never a Skip button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(connectedVerifiedSnapshot())))

    render(
      <WizardStepModelConnection
        status={buildStatus('loopback')}
        busy={false}
        error={undefined}
        onContinue={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()
    })
    expect(screen.getByRole('button', { name: 'Add another connection' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^skip$/i })).toBeNull()
  })

  it('the loopback statement is shown, and Continue is enabled with no connection at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          vaultAvailable: false,
          mockEnabled: false,
          mockControlAvailable: false,
          methods: [anthropicApiKeyMethod],
          connections: [],
          selection: null,
        } satisfies ModelConnectionsSnapshot),
      ),
    )

    render(
      <WizardStepModelConnection
        status={buildStatus('loopback')}
        busy={false}
        error={undefined}
        onContinue={vi.fn()}
      />,
    )

    expect(await screen.findByText(/This install uses the built-in mock provider/)).toBeDefined()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveProperty('disabled', true)
    })
  })

  it('Continue is disabled on vps with no connection, and never a Skip button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          vaultAvailable: false,
          mockEnabled: false,
          mockControlAvailable: false,
          methods: [anthropicApiKeyMethod],
          connections: [],
          selection: null,
        } satisfies ModelConnectionsSnapshot),
      ),
    )

    render(
      <WizardStepModelConnection
        status={buildStatus('vps')}
        busy={false}
        error={undefined}
        onContinue={vi.fn()}
      />,
    )

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })
    expect(screen.queryByRole('button', { name: /^skip$/i })).toBeNull()
  })

  it('Continue posts useMock: true on local-vps once the mock checkbox is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          vaultAvailable: false,
          mockEnabled: true,
          mockControlAvailable: true,
          methods: [anthropicApiKeyMethod],
          connections: [],
          selection: null,
        } satisfies ModelConnectionsSnapshot),
      ),
    )
    const onContinue = vi.fn()

    render(
      <WizardStepModelConnection
        status={buildStatus('local-vps')}
        busy={false}
        error={undefined}
        onContinue={onContinue}
      />,
    )

    const continueButton = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      return button
    })
    continueButton.click()
    expect(onContinue).toHaveBeenCalledWith({ useMock: true })
  })
})
