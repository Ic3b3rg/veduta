import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createByokAdapter } from './model-connection-byok.ts'
import {
  CONNECTIONS_FILE_NAME,
  loadConnectionsConfig,
  saveConnectionsConfig,
  type ConnectionsFile,
  type ModelConnectionRecord,
} from './connections-config.ts'
import {
  ModelConnectionError,
  type AuthorizeResult,
  type ModelConnectionAdapter,
} from './model-connection-adapter.ts'
import {
  ModelConnectionRegistry,
  type ModelConnectionRegistryOptions,
} from './model-connection-registry.ts'
import { envSecretResolver } from './model-routing.ts'
import { defaultRedactor } from './redaction.ts'
import { SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-connection-registry-'))
  return rootDir
}

function createFakeAdapter(
  overrides: Partial<ModelConnectionAdapter> = {},
): ModelConnectionAdapter {
  return {
    methodId: 'anthropic-api-key',
    providerName: 'anthropic',
    providerDisplayName: 'Fake',
    methodDisplayName: 'Fake method',
    capabilities: {
      authorization: 'api-key',
      refresh: 'static',
      revocation: 'local-only',
      vedutaTools: true,
      metered: true,
    },
    availability: async () => ({ available: true }),
    authorize: async (): Promise<AuthorizeResult> => ({ state: 'connected' }),
    refresh: async () => ({ state: 'connected' }),
    catalog: async () => [{ id: 'model-a', label: 'Model A', routable: true }],
    verify: async () => {},
    revoke: async () => ({ providerRevoked: false }),
    ...overrides,
  }
}

function baseOptions(
  dir: string,
  adapters: readonly ModelConnectionAdapter[],
  overrides: Partial<ModelConnectionRegistryOptions> = {},
): ModelConnectionRegistryOptions {
  return {
    rootDir: dir,
    adapters,
    vault: undefined,
    secrets: envSecretResolver,
    profile: 'loopback',
    fetchImpl: vi.fn() as unknown as typeof fetch,
    now: () => new Date('2026-08-09T10:00:00.000Z'),
    probe: async () => {},
    isRoutableModel: () => true,
    env: {},
    ...overrides,
  }
}

function rawFile(dir: string): string {
  return readFileSync(join(dir, CONNECTIONS_FILE_NAME), 'utf8')
}

describe('mutation queue', () => {
  it('two concurrent updates to the same connection both survive (the mutation queue serializes them)', async () => {
    const dir = freshRoot()
    const deviceAdapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [deviceAdapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    await Promise.all([
      registry.update(id, { label: 'Renamed' }),
      registry.update(id, { enabledForFallback: true }),
    ])

    const file = loadConnectionsConfig(dir)
    const record = file.connections.find((candidate) => candidate.id === id)
    expect(record?.label).toBe('Renamed')
    expect(record?.enabledForFallback).toBe(true)
  })
})

describe('refresh singleflight', () => {
  it('two concurrent reads while waiting-for-user issue one adapter refresh', async () => {
    const dir = freshRoot()
    const refreshMock = vi.fn().mockResolvedValue({ state: 'waiting-for-user' })
    const deviceAdapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
      authorize: async () => ({
        state: 'waiting-for-user',
        challenge: {
          loginId: 'login-1',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'ABCD-1234',
          expiresAt: '2026-08-09T10:15:00.000Z',
          expirySource: 'provider',
        },
      }),
      refresh: refreshMock,
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [deviceAdapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')
    await registry.authorize(id, {})

    await Promise.all([registry.read(id), registry.read(id)])

    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})

describe('create', () => {
  it('generates a uuid id', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter()
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const snapshot = await registry.create({ method: 'anthropic-api-key' })
    const id = snapshot.connections[0]?.id
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('refuses an unavailable method with its exact reason', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter({
      availability: async () => ({ available: false, reason: 'nope, not right now' }),
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const error = await registry
      .create({ method: 'anthropic-api-key' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unsupported')
    expect((error as ModelConnectionError).message).toBe('nope, not right now')
    expect(loadConnectionsConfig(dir).connections).toHaveLength(0)
  })
})

describe('normalizeInFlightStatesOnBoot', () => {
  it('moves waiting-for-user to failed with the interrupted-authorization reason', () => {
    const dir = freshRoot()
    const record: ModelConnectionRecord = {
      id: 'aaaaaaaa-0000-4000-8000-000000000000',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'ChatGPT · Subscription',
      state: 'waiting-for-user',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
    }
    const file: ConnectionsFile = { version: 1, connections: [record], mockEnabled: false }
    saveConnectionsConfig(dir, file)

    const adapter = createFakeAdapter({ methodId: 'chatgpt-codex', providerName: 'openai' })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    registry.normalizeInFlightStatesOnBoot()

    const updated = loadConnectionsConfig(dir).connections[0]
    expect(updated?.state).toBe('failed')
    expect(updated?.stateReason).toBe(
      'authorization was interrupted by a daemon restart; start it again',
    )
  })
})

describe('device challenge', () => {
  function deviceAdapterWithChallenge(expiresAt: string): ModelConnectionAdapter {
    return createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
      authorize: async () => ({
        state: 'waiting-for-user',
        challenge: {
          loginId: 'login-1',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'ABCD-1234',
          expiresAt,
          expirySource: 'provider',
        },
      }),
    })
  }

  it('is served from memory and never written to connections.json', async () => {
    const dir = freshRoot()
    const adapter = deviceAdapterWithChallenge('2026-08-09T10:15:00.000Z')
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const snapshot = await registry.authorize(id, {})
    const connection = snapshot.connections.find((candidate) => candidate.id === id)
    expect(connection?.challenge?.userCode).toBe('ABCD-1234')
    expect(rawFile(dir)).not.toContain('ABCD-1234')
    expect(rawFile(dir)).not.toContain('verificationUrl')
  })

  it('past its expiry moves the connection to failed and clears it', async () => {
    const dir = freshRoot()
    const adapter = deviceAdapterWithChallenge('2026-08-09T10:05:00.000Z')
    let clock = new Date('2026-08-09T10:00:00.000Z')
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter], { now: () => clock }))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')
    await registry.authorize(id, {})

    clock = new Date('2026-08-09T10:10:00.000Z')
    const connection = await registry.read(id)

    expect(connection.state).toBe('failed')
    expect(connection.stateReason).toBe(
      'the device code expired before it was entered; start authorization again',
    )
    expect(connection.challenge).toBeUndefined()
  })
})

describe('noteCallFailure', () => {
  const DISTINCTIVE_SECRET = 'zzz-registry-distinctive-marker-24680'

  it('marks a connection failed with the sanitized provider text and a matching provider id maps onto the migrated record', async () => {
    const dir = freshRoot()
    const migratedRecord: ModelConnectionRecord = {
      id: 'anthropic',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
      secretRef: 'secret://vault/anthropic',
    }
    saveConnectionsConfig(dir, { version: 1, connections: [migratedRecord], mockEnabled: false })

    const registry = new ModelConnectionRegistry(baseOptions(dir, []))
    defaultRedactor.register(DISTINCTIVE_SECRET)

    await registry.noteCallFailure(
      'anthropic',
      new Error(`upstream said no for ${DISTINCTIVE_SECRET}`),
    )

    const updated = loadConnectionsConfig(dir).connections.find((c) => c.id === 'anthropic')
    expect(updated?.state).toBe('failed')
    expect(updated?.stateReason).not.toContain(DISTINCTIVE_SECRET)
  })

  it('is a no-op when no record matches', async () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, { version: 1, connections: [], mockEnabled: false })
    const registry = new ModelConnectionRegistry(baseOptions(dir, []))
    await expect(registry.noteCallFailure('nobody-here', new Error('x'))).resolves.toBeUndefined()
  })
})

describe('commitSelection', () => {
  it('rejects when the generation moved (the try-again reason)', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter()
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'anthropic-api-key', apiKey: 'sk-test' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const prepared = await registry.applySelectionPrepared(id, 'model-a')
    await registry.update(id, { label: 'changed while probing' })

    const error = await registry.commitSelection(prepared).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('rejected')
    expect((error as ModelConnectionError).message).toBe(
      'the Model connections changed while the model test was running; try again',
    )
  })

  it('commits when the generation has not moved', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter()
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'anthropic-api-key', apiKey: 'sk-test' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const prepared = await registry.applySelectionPrepared(id, 'model-a')
    await registry.commitSelection(prepared)

    expect(loadConnectionsConfig(dir).selection).toEqual({ connectionId: id, modelId: 'model-a' })
  })
})

describe('remove', () => {
  it('deletes the vault entry for a vault-backed key and keeps an env-backed one (R6)', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const vaultBackedId = 'b2b2b2b2-0000-4000-8000-000000000001'
    vault.set(`${vaultBackedId}-api-key`, 'sk-vault-backed')

    const vaultBacked: ModelConnectionRecord = {
      id: vaultBackedId,
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
      secretRef: `secret://vault/${vaultBackedId}-api-key`,
    }
    const envBacked: ModelConnectionRecord = {
      id: 'anthropic',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key (legacy)',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
      secretRef: 'secret://env/ANTHROPIC_API_KEY',
    }
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [vaultBacked, envBacked],
      mockEnabled: false,
    })

    const registry = new ModelConnectionRegistry(
      baseOptions(dir, [createByokAdapter('anthropic')], { vault }),
    )

    await registry.remove(vaultBackedId)
    expect(vault.has(`${vaultBackedId}-api-key`)).toBe(false)
    expect(loadConnectionsConfig(dir).connections.some((c) => c.id === vaultBackedId)).toBe(false)

    await registry.remove('anthropic')
    expect(loadConnectionsConfig(dir).connections.some((c) => c.id === 'anthropic')).toBe(false)
  })
})

describe('authorize', () => {
  it('is method-discriminated (both rejected messages)', async () => {
    const dir = freshRoot()
    const apiKeyAdapter = createFakeAdapter()
    const deviceAdapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [apiKeyAdapter, deviceAdapter]))

    const apiKeyConnection = await registry.create({ method: 'anthropic-api-key' })
    const apiKeyId = apiKeyConnection.connections[0]?.id
    if (!apiKeyId) throw new Error('test setup failed')
    const apiKeyError = await registry.authorize(apiKeyId, {}).catch((caught: unknown) => caught)
    expect(apiKeyError).toBeInstanceOf(ModelConnectionError)
    expect((apiKeyError as ModelConnectionError).message).toBe(
      'this connection is an API-key connection: submit the replacement key',
    )

    const deviceConnection = await registry.create({ method: 'chatgpt-codex' })
    const deviceId = deviceConnection.connections[1]?.id
    if (!deviceId) throw new Error('test setup failed')
    const deviceError = await registry
      .authorize(deviceId, { apiKey: 'should-not-be-here' })
      .catch((caught: unknown) => caught)
    expect(deviceError).toBeInstanceOf(ModelConnectionError)
    expect((deviceError as ModelConnectionError).message).toBe(
      "this connection re-authorizes through the provider's device code: submit an empty body",
    )
  })
})
