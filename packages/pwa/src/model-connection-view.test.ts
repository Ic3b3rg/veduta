import type {
  ModelConnection,
  ModelConnectionMethod,
  ModelConnectionsSnapshot,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  canContinue,
  catalogOptions,
  challengeCountdownLabel,
  connectionSelectLabel,
  lifecycleCopy,
} from './model-connection-view.ts'

const anthropicApiKeyMethod: ModelConnectionMethod = {
  id: 'anthropic-api-key',
  provider: 'anthropic',
  providerDisplayName: 'Claude',
  methodDisplayName: 'API key',
  capabilities: {
    authorization: 'api-key',
    refresh: 'static',
    revocation: 'local-only',
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
    metered: true,
  },
  available: false,
}

const anthropicApiKey: ModelConnection = {
  id: 'anthropic',
  method: 'anthropic-api-key',
  provider: 'anthropic',
  label: 'Claude · API key',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
}

const claudeSubscription: ModelConnection = {
  id: 'a1a1a1a1-0000-4000-8000-000000000001',
  method: 'claude-subscription',
  provider: 'anthropic',
  label: 'Claude · Subscription',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
}

const workKey: ModelConnection = {
  id: 'a1a1a1a1-0000-4000-8000-000000000002',
  method: 'anthropic-api-key',
  provider: 'anthropic',
  label: 'Work key',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
}

const personalKey: ModelConnection = {
  id: 'a1a1a1a1-0000-4000-8000-000000000003',
  method: 'anthropic-api-key',
  provider: 'anthropic',
  label: 'Personal key',
  state: 'connected',
  stateAt: '2026-08-09T00:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T00:00:00.000Z',
}

function emptySnapshot(
  overrides: Pick<ModelConnectionsSnapshot, 'connections' | 'selection' | 'mockEnabled'>,
): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockControlAvailable: true,
    methods: [],
    ...overrides,
  }
}

describe('connectionSelectLabel', () => {
  it('connection labels come from the snapshot method metadata', () => {
    const methods = [anthropicApiKeyMethod, claudeSubscriptionMethod]

    expect(connectionSelectLabel(anthropicApiKey, [anthropicApiKey], methods)).toBe('Claude')

    const all = [anthropicApiKey, claudeSubscription]
    expect(connectionSelectLabel(claudeSubscription, all, methods)).toBe('Claude · Subscription')
    expect(connectionSelectLabel(anthropicApiKey, all, methods)).toBe('Claude · API key')
  })

  it('appends the user label when provider and method both collide', () => {
    const all = [workKey, personalKey]
    const methods = [anthropicApiKeyMethod]
    expect(connectionSelectLabel(workKey, all, methods)).toBe('Claude · API key · Work key')
    expect(connectionSelectLabel(personalKey, all, methods)).toBe('Claude · API key · Personal key')
  })

  it('an unknown provider falls back to its raw name', () => {
    const novelConnection: ModelConnection = {
      ...anthropicApiKey,
      provider: 'some-future-provider',
    }
    // No method in the snapshot's `methods[]` matches this connection's
    // method id, so the label falls back to the connection's own raw
    // `provider` string instead of the daemon-supplied display name.
    expect(connectionSelectLabel(novelConnection, [novelConnection], [])).toBe(
      'some-future-provider',
    )
  })
})

describe('lifecycleCopy', () => {
  it('offers a reconnect action for a revoked connection', () => {
    const revoked: ModelConnection = {
      ...anthropicApiKey,
      state: 'revoked',
      stateReason: 'the provider revoked this connection',
    }
    expect(lifecycleCopy(revoked)).toEqual({
      title: 'Revoked',
      detail: 'the provider revoked this connection',
      action: 'reconnect',
    })
  })

  it('offers a retry action for a failed connection, using stateReason as the detail', () => {
    const failed: ModelConnection = {
      ...anthropicApiKey,
      state: 'failed',
      stateReason: 'the key was rejected by the provider',
    }
    expect(lifecycleCopy(failed)).toEqual({
      title: 'Failed',
      detail: 'the key was rejected by the provider',
      action: 'retry',
    })
  })

  it('reports the account label for a connected connection when one was supplied', () => {
    const connected: ModelConnection = {
      ...anthropicApiKey,
      account: { label: 'plus plan' },
    }
    expect(lifecycleCopy(connected)).toEqual({
      title: 'Connected',
      detail: 'Signed in as plus plan.',
      action: 'none',
    })
  })

  it('waits for the user during a device-code login', () => {
    const waiting: ModelConnection = { ...anthropicApiKey, state: 'waiting-for-user' }
    expect(lifecycleCopy(waiting).title).toBe('Waiting for you to finish signing in…')
    expect(lifecycleCopy(waiting).action).toBe('none')
  })
})

describe('catalogOptions', () => {
  it('returns every entry the daemon reported and disables the unroutable ones', () => {
    const withCatalog: ModelConnection = {
      ...anthropicApiKey,
      catalog: [
        { id: 'claude-a', label: 'Claude A', routable: true },
        { id: 'claude-b', label: 'Claude B', routable: false },
      ],
    }
    expect(catalogOptions(withCatalog)).toEqual([
      { value: 'claude-a', label: 'Claude A', disabled: false },
      { value: 'claude-b', label: 'Claude B', disabled: true, note: 'not routable by this build' },
    ])
  })

  it('returns an empty list when the connection has never fetched a catalog', () => {
    expect(catalogOptions(anthropicApiKey)).toEqual([])
  })
})

describe('canContinue', () => {
  it('always passes on loopback', () => {
    expect(
      canContinue(
        emptySnapshot({ connections: [], selection: null, mockEnabled: false }),
        'loopback',
      ),
    ).toBe(true)
  })

  it('requires the development mock control or a verified selection on local-vps', () => {
    const noConnectionNoMock = emptySnapshot({
      connections: [],
      selection: null,
      mockEnabled: false,
    })
    expect(canContinue(noConnectionNoMock, 'local-vps')).toBe(false)

    const mockOnly = emptySnapshot({ connections: [], selection: null, mockEnabled: true })
    expect(canContinue(mockOnly, 'local-vps')).toBe(true)

    const connectedNoSelection = emptySnapshot({
      connections: [anthropicApiKey],
      selection: null,
      mockEnabled: false,
    })
    expect(canContinue(connectedNoSelection, 'local-vps')).toBe(false)

    const connectedAndSelected = emptySnapshot({
      connections: [anthropicApiKey],
      selection: { connectionId: anthropicApiKey.id, modelId: 'claude-a' },
      mockEnabled: false,
    })
    expect(canContinue(connectedAndSelected, 'local-vps')).toBe(true)
  })

  it('requires an actual connected selection on vps, ignoring the mock control entirely', () => {
    const selectedButNotConnected: ModelConnection = { ...anthropicApiKey, state: 'expired' }
    const snapshot = emptySnapshot({
      connections: [selectedButNotConnected],
      selection: { connectionId: selectedButNotConnected.id, modelId: 'claude-a' },
      mockEnabled: true,
    })
    expect(canContinue(snapshot, 'vps')).toBe(false)

    const connectedAndSelected = emptySnapshot({
      connections: [anthropicApiKey],
      selection: { connectionId: anthropicApiKey.id, modelId: 'claude-a' },
      mockEnabled: false,
    })
    expect(canContinue(connectedAndSelected, 'vps')).toBe(true)
  })
})

describe('challengeCountdownLabel', () => {
  it('renders a minutes:seconds countdown before expiry', () => {
    const challenge = {
      loginId: 'login-1',
      verificationUrl: 'https://example.com/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T00:05:30.000Z',
      expirySource: 'provider' as const,
    }
    expect(challengeCountdownLabel(challenge, new Date('2026-08-09T00:00:00.000Z'))).toBe(
      'expires in 5:30',
    )
  })

  it('reports "expired" once now has passed expiresAt', () => {
    const challenge = {
      loginId: 'login-1',
      verificationUrl: 'https://example.com/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T00:00:00.000Z',
      expirySource: 'veduta-default' as const,
    }
    expect(challengeCountdownLabel(challenge, new Date('2026-08-09T00:00:01.000Z'))).toBe('expired')
  })
})
