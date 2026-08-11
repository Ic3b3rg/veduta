// @vitest-environment jsdom
import type {
  ModelConnection,
  ModelConnectionMethod,
  ModelConnectionsSnapshot,
} from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionPanel } from './model-connection-panel.tsx'

afterEach(cleanup)

const anthropicApiKeyMethod: ModelConnectionMethod = {
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
}

const claudeSubscriptionMethod: ModelConnectionMethod = {
  id: 'claude-subscription',
  provider: 'anthropic',
  providerDisplayName: 'Claude',
  methodDisplayName: 'Subscription',
  capabilities: {
    authorization: 'none',
    refresh: 'static',
    revocation: 'local-only',
    vedutaTools: true,
    metered: true,
  },
  available: false,
  unavailableReason: 'Claude subscription connections are not offered by this build yet.',
  docsUrl: 'https://example.com/docs/claude-subscription',
}

const chatgptCodexMethod: ModelConnectionMethod = {
  id: 'chatgpt-codex',
  provider: 'openai',
  providerDisplayName: 'OpenAI',
  methodDisplayName: 'ChatGPT subscription',
  capabilities: {
    authorization: 'device-code',
    refresh: 'automatic',
    revocation: 'provider',
    vedutaTools: false,
    metered: false,
  },
  available: true,
}

function baseSnapshot(overrides: Partial<ModelConnectionsSnapshot> = {}): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: true,
    methods: [anthropicApiKeyMethod, claudeSubscriptionMethod],
    connections: [],
    selection: null,
    ...overrides,
  }
}

const noop = {
  onCreate: vi.fn(),
  onAuthorize: vi.fn(),
  onVerify: vi.fn(),
  onApplySelection: vi.fn().mockResolvedValue(true),
  onUpdate: vi.fn(),
  onRemove: vi.fn(),
  onSetMock: vi.fn(),
  onRefreshCatalog: vi.fn(),
}

describe('ModelConnectionPanel', () => {
  it('renders the Claude method as unavailable with its exact reason and no login button', () => {
    render(<ModelConnectionPanel snapshot={baseSnapshot()} busy={false} error={null} {...noop} />)

    expect(
      screen.getByText('Claude subscription connections are not offered by this build yet.'),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: /log in/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /authorize/i })).toBeNull()
  })

  it('shows the device code and verification URL while waiting for the user', () => {
    const waiting: ModelConnection = {
      id: 'b1b1b1b1-0000-4000-8000-000000000001',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI · ChatGPT subscription',
      state: 'waiting-for-user',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      challenge: {
        loginId: 'login-1',
        verificationUrl: 'https://chatgpt.com/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-08-09T00:05:00.000Z',
        expirySource: 'provider',
      },
    }

    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ methods: [chatgptCodexMethod], connections: [waiting] })}
        busy={false}
        error={null}
        now={() => new Date('2026-08-09T00:00:00.000Z')}
        {...noop}
      />,
    )

    const link = screen.getByRole('link', { name: 'https://chatgpt.com/device' })
    expect(link.getAttribute('href')).toBe('https://chatgpt.com/device')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(screen.getByText('ABCD-1234').tagName).toBe('CODE')
    expect(screen.getAllByText('Waiting for you to finish signing in…').length).toBeGreaterThan(0)
    expect(screen.getByText('expires in 5:00')).toBeDefined()
  })

  it('lists models when a polled device connection becomes connected', () => {
    const connectionId = 'b1b1b1b1-0000-4000-8000-000000000001'
    const waiting: ModelConnection = {
      id: connectionId,
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI · ChatGPT subscription',
      state: 'waiting-for-user',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      challenge: {
        loginId: 'login-1',
        verificationUrl: 'https://chatgpt.com/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-08-09T00:05:00.000Z',
        expirySource: 'provider',
      },
    }
    const connected: ModelConnection = {
      id: connectionId,
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI · ChatGPT subscription',
      state: 'connected',
      stateAt: '2026-08-09T00:00:02.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      account: { label: 'prolite' },
      catalog: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', routable: true }],
      catalogFetchedAt: '2026-08-09T00:00:02.000Z',
    }

    const { rerender } = render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ methods: [chatgptCodexMethod], connections: [waiting] })}
        busy={false}
        error={null}
        {...noop}
      />,
    )

    rerender(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ methods: [chatgptCodexMethod], connections: [connected] })}
        busy={false}
        error={null}
        {...noop}
      />,
    )

    const connectionSelect = document.getElementById('model-connection-select') as HTMLSelectElement
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement
    expect(connectionSelect.value).toBe(connectionId)
    expect([...modelSelect.options].map((option) => option.textContent)).toContain('GPT-5.6-Sol')
  })

  it('the model select only lists models from the selected connection', () => {
    const connectionA: ModelConnection = {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      catalog: [{ id: 'claude-model-a', label: 'Claude model A', routable: true }],
    }
    const connectionB: ModelConnection = {
      id: 'a1a1a1a1-0000-4000-8000-000000000002',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      catalog: [{ id: 'codex-model-b', label: 'Codex model B', routable: true }],
    }

    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({
          methods: [anthropicApiKeyMethod, chatgptCodexMethod],
          connections: [connectionA, connectionB],
          selection: { connectionId: connectionA.id, modelId: 'claude-model-a' },
        })}
        busy={false}
        error={null}
        {...noop}
      />,
    )

    const modelSelect = document.getElementById('model-select') as HTMLSelectElement
    const optionLabels = [...modelSelect.options].map((option) => option.textContent)
    expect(optionLabels).toContain('Claude model A')
    expect(optionLabels).not.toContain('Codex model B')
  })

  it('a text-only connection renders the no-Veduta-tools note', () => {
    const codexConnection: ModelConnection = {
      id: 'c1c1c1c1-0000-4000-8000-000000000001',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'OpenAI',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
    }

    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ methods: [chatgptCodexMethod], connections: [codexConnection] })}
        busy={false}
        error={null}
        {...noop}
      />,
    )

    expect(
      screen.getByText(
        'Answers in text only — Veduta tools such as memory search are not available through this connection.',
      ),
    ).toBeDefined()
  })

  it('the development mock checkbox renders only when the snapshot reports mockControlAvailable', () => {
    const { rerender } = render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ mockControlAvailable: false })}
        busy={false}
        error={null}
        {...noop}
      />,
    )
    expect(screen.queryByLabelText(/built-in mock provider/i)).toBeNull()

    rerender(
      <ModelConnectionPanel
        snapshot={baseSnapshot({ mockControlAvailable: true })}
        busy={false}
        error={null}
        {...noop}
      />,
    )
    expect(screen.getByLabelText(/built-in mock provider/i)).toBeDefined()
  })

  it('an unroutable catalog entry is disabled with its note', () => {
    const connection: ModelConnection = {
      id: 'd1d1d1d1-0000-4000-8000-000000000001',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      catalog: [
        { id: 'claude-good', label: 'Claude good', routable: true },
        { id: 'claude-bad', label: 'Claude bad', routable: false },
      ],
    }

    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({
          methods: [anthropicApiKeyMethod],
          connections: [connection],
          selection: { connectionId: connection.id, modelId: 'claude-good' },
        })}
        busy={false}
        error={null}
        {...noop}
      />,
    )

    const modelSelect = document.getElementById('model-select') as HTMLSelectElement
    const badOption = [...modelSelect.options].find((option) => option.value === 'claude-bad')
    expect(badOption?.disabled).toBe(true)
    expect(badOption?.textContent).toBe('Claude bad (not routable by this build)')
  })

  it('renders the error prop with the wizard error style and role=alert', () => {
    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot()}
        busy={false}
        error="something went wrong"
        {...noop}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('something went wrong')
    expect(alert.className).toBe('error')
  })

  it('calls onCreate with the trimmed key when adding an api-key connection', () => {
    const onCreate = vi.fn()
    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot()}
        busy={false}
        error={null}
        {...noop}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: '  sk-test-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))

    expect(onCreate).toHaveBeenCalledWith({ method: 'anthropic-api-key', apiKey: 'sk-test-key' })
  })

  it('a rejected selection resets both selects to the committed selection', async () => {
    const connectionA: ModelConnection = {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      catalog: [
        { id: 'claude-model-a', label: 'Claude model A', routable: true },
        { id: 'claude-model-b', label: 'Claude model B', routable: true },
      ],
    }
    const onApplySelection = vi.fn().mockResolvedValue(false)

    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({
          methods: [anthropicApiKeyMethod],
          connections: [connectionA],
          selection: { connectionId: connectionA.id, modelId: 'claude-model-a' },
        })}
        busy={false}
        error="the provider rejected the probe: invalid_api_key"
        {...noop}
        onApplySelection={onApplySelection}
      />,
    )

    const connectionSelect = document.getElementById('model-connection-select') as HTMLSelectElement
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement

    fireEvent.change(modelSelect, { target: { value: 'claude-model-b' } })
    expect(modelSelect.value).toBe('claude-model-b')

    fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))

    expect(onApplySelection).toHaveBeenCalledWith(connectionA.id, 'claude-model-b')

    // Verify-then-commit: nothing was applied Gateway-side, so both drafts
    // snap back to the selection that is actually committed rather than
    // leaving the selects showing the rejected value under the error
    // banner (issue #47).
    await waitFor(() => expect(modelSelect.value).toBe('claude-model-a'))
    expect(connectionSelect.value).toBe(connectionA.id)
  })

  it("a rejected selection resets the selects to the Gateway's current selection, not the stale one", async () => {
    const connectionA: ModelConnection = {
      id: 'a1a1a1a1-0000-4000-8000-000000000001',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude',
      state: 'connected',
      stateAt: '2026-08-09T00:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      catalog: [
        { id: 'claude-model-a', label: 'Claude model A', routable: true },
        { id: 'claude-model-b', label: 'Claude model B', routable: true },
        { id: 'claude-model-c', label: 'Claude model C', routable: true },
      ],
    }
    let resolveApply: ((committed: boolean) => void) | undefined
    const onApplySelection = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApply = resolve
        }),
    )

    const { rerender } = render(
      <ModelConnectionPanel
        snapshot={baseSnapshot({
          methods: [anthropicApiKeyMethod],
          connections: [connectionA],
          selection: { connectionId: connectionA.id, modelId: 'claude-model-a' },
        })}
        busy={false}
        error={null}
        {...noop}
        onApplySelection={onApplySelection}
      />,
    )

    const connectionSelect = document.getElementById('model-connection-select') as HTMLSelectElement
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement

    fireEvent.change(modelSelect, { target: { value: 'claude-model-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))
    expect(onApplySelection).toHaveBeenCalledWith(connectionA.id, 'claude-model-b')

    // While the apply is still in flight, ANOTHER client committed
    // `claude-model-c` Gateway-side, and the controller's refetch (triggered
    // as part of handling this rejection) delivers that as a fresh
    // `snapshot` prop -- before `onApplySelection`'s own promise settles.
    rerender(
      <ModelConnectionPanel
        snapshot={baseSnapshot({
          methods: [anthropicApiKeyMethod],
          connections: [connectionA],
          selection: { connectionId: connectionA.id, modelId: 'claude-model-c' },
        })}
        busy={false}
        error="the provider rejected the probe: invalid_api_key"
        {...noop}
        onApplySelection={onApplySelection}
      />,
    )

    resolveApply!(false)

    // The rollback must read the snapshot as it stands NOW (`claude-model-c`),
    // not the one captured in the `onClick` closure at the moment the click
    // happened (`claude-model-a`).
    await waitFor(() => expect(modelSelect.value).toBe('claude-model-c'))
    expect(connectionSelect.value).toBe(connectionA.id)
  })

  it('calls onSetMock when the development mock checkbox is toggled', () => {
    const onSetMock = vi.fn()
    render(
      <ModelConnectionPanel
        snapshot={baseSnapshot()}
        busy={false}
        error={null}
        {...noop}
        onSetMock={onSetMock}
      />,
    )

    fireEvent.click(screen.getByLabelText(/built-in mock provider/i))
    expect(onSetMock).toHaveBeenCalledWith(true)
  })
})
