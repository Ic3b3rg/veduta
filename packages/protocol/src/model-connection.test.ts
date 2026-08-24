import { describe, expect, it } from 'vitest'
import {
  ConnectionLifecycleStateSchema,
  CreateModelConnectionRequestSchema,
  DeviceChallengeSchema,
  ModelConnectionIdSchema,
  ModelConnectionMethodSchema,
  ModelConnectionSchema,
  ModelConnectionsSnapshotSchema,
} from './model-connection.ts'

const validConnection = {
  id: '5b1c9a6e-2f3a-4b8a-9c1d-0e2f3a4b5c6d',
  method: 'anthropic-api-key' as const,
  provider: 'anthropic',
  label: 'Claude · API key',
  state: 'connected' as const,
  stateAt: '2026-08-09T10:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T10:00:00.000Z',
}

describe('ModelConnectionSchema', () => {
  it('parses a minimal connected connection', () => {
    expect(ModelConnectionSchema.safeParse(validConnection).success).toBe(true)
  })

  it('rejects a payload carrying a secretRef', () => {
    expect(
      ModelConnectionSchema.safeParse({
        ...validConnection,
        secretRef: 'secret://vault/anthropic',
      }).success,
    ).toBe(false)
  })
})

describe('ConnectionLifecycleStateSchema', () => {
  it('lists exactly the nine states', () => {
    const states = [
      'available',
      'authorizing',
      'waiting-for-user',
      'verifying',
      'connected',
      'expired',
      'reconnecting',
      'failed',
      'revoked',
    ]
    for (const state of states) {
      expect(ConnectionLifecycleStateSchema.safeParse(state).success).toBe(true)
    }
    expect(ConnectionLifecycleStateSchema.options).toHaveLength(states.length)
  })

  it('rejects an unknown state', () => {
    expect(ConnectionLifecycleStateSchema.safeParse('unavailable').success).toBe(false)
  })
})

describe('ModelConnectionIdSchema', () => {
  it('accepts a uuid', () => {
    expect(ModelConnectionIdSchema.safeParse('5b1c9a6e-2f3a-4b8a-9c1d-0e2f3a4b5c6d').success).toBe(
      true,
    )
  })

  it('accepts the three reserved legacy provider ids', () => {
    for (const id of ['anthropic', 'openai', 'openrouter']) {
      expect(ModelConnectionIdSchema.safeParse(id).success).toBe(true)
    }
  })

  it('rejects a path traversal like "../escape"', () => {
    expect(ModelConnectionIdSchema.safeParse('../escape').success).toBe(false)
  })
})

describe('ModelConnectionsSnapshotSchema', () => {
  it('parses a snapshot with zero connections and a null selection', () => {
    const snapshot = {
      vaultAvailable: true,
      mockEnabled: false,
      mockControlAvailable: false,
      methods: [],
      connections: [],
      selection: null,
    }
    expect(ModelConnectionsSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })
})

describe('ModelConnectionMethodSchema', () => {
  const method = {
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

  it('requires explicit primary-route eligibility', () => {
    expect(
      ModelConnectionMethodSchema.safeParse({ ...method, primaryRoutable: true }).success,
    ).toBe(true)
    expect(ModelConnectionMethodSchema.safeParse(method).success).toBe(false)
  })
})

describe('CreateModelConnectionRequestSchema', () => {
  it('accepts a device-code method with no apiKey', () => {
    expect(CreateModelConnectionRequestSchema.safeParse({ method: 'chatgpt-codex' }).success).toBe(
      true,
    )
  })

  it('rejects an empty apiKey string', () => {
    expect(
      CreateModelConnectionRequestSchema.safeParse({
        method: 'anthropic-api-key',
        apiKey: '',
      }).success,
    ).toBe(false)
  })
})

describe('DeviceChallengeSchema', () => {
  const base = {
    loginId: 'login-1',
    verificationUrl: 'https://chatgpt.com/device',
    userCode: 'ABCD-1234',
    expiresAt: '2026-08-09T10:15:00.000Z',
  }

  it('requires an explicit expirySource', () => {
    expect(DeviceChallengeSchema.safeParse(base).success).toBe(false)
    expect(DeviceChallengeSchema.safeParse({ ...base, expirySource: 'provider' }).success).toBe(
      true,
    )
  })
})
