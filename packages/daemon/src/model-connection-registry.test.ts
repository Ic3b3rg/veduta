import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceChallenge } from '@veduta/protocol'
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
  type RefreshResult,
} from './model-connection-adapter.ts'
import {
  ModelConnectionRegistry,
  type ModelConnectionRegistryOptions,
} from './model-connection-registry.ts'
import { reconcileByokConnections } from './model-connection-migration.ts'
import { deriveRoutingConfig } from './model-connection-routing.ts'
import {
  defaultRoutingConfig,
  envSecretResolver,
  loadRoutingConfig,
  saveRoutingConfig,
} from './model-routing.ts'
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
    const calls: unknown[] = []
    const withCallback = new ModelConnectionRegistry(
      baseOptions(dir, [], { onCallFailure: (id, state) => calls.push([id, state]) }),
    )

    await expect(registry.noteCallFailure('nobody-here', new Error('x'))).resolves.toBeUndefined()
    await withCallback.noteCallFailure('nobody-here', new Error('x'))
    expect(calls).toEqual([])
  })

  it('fires onCallFailure once with the resulting state, regardless of which caller reached it (issue #47)', async () => {
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
    const calls: [string, string][] = []
    const registry = new ModelConnectionRegistry(
      baseOptions(dir, [], {
        onCallFailure: (id, state) => calls.push([id, state]),
      }),
    )

    await registry.noteCallFailure(
      'anthropic',
      new ModelConnectionError('unauthorized', 'the provider rejected this credential'),
    )

    expect(calls).toEqual([['anthropic', 'revoked']])
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
  it('deletes the vault entry and the record for a vault-backed key', async () => {
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
    saveConnectionsConfig(dir, { version: 1, connections: [vaultBacked], mockEnabled: false })

    const registry = new ModelConnectionRegistry(
      baseOptions(dir, [createByokAdapter('anthropic')], { vault }),
    )

    await registry.remove(vaultBackedId)

    expect(vault.has(`${vaultBackedId}-api-key`)).toBe(false)
    expect(loadConnectionsConfig(dir).connections.some((c) => c.id === vaultBackedId)).toBe(false)
  })

  it('removing an env-backed connection leaves a revoked tombstone', async () => {
    const dir = freshRoot()
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
      connections: [envBacked],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
      mockEnabled: false,
    })

    const registry = new ModelConnectionRegistry(baseOptions(dir, [createByokAdapter('anthropic')]))

    await registry.remove('anthropic')

    const file = loadConnectionsConfig(dir)
    const tombstone = file.connections.find((c) => c.id === 'anthropic')
    expect(tombstone).toBeDefined()
    expect(tombstone?.state).toBe('revoked')
    expect(tombstone?.stateReason).toBe(
      'the key comes from the daemon environment and stays there; remove the environment variable to retire it',
    )
    // The env var is left exactly where it was — the record just stops
    // pointing at it.
    expect(tombstone?.secretRef).toBe('secret://env/ANTHROPIC_API_KEY')
    // The selection that pointed at this connection is cleared.
    expect(file.selection).toBeUndefined()
  })

  it('drops a legacy routing.json connectionKeys entry for the removed id', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const vaultBackedId = 'c3c3c3c3-0000-4000-8000-000000000002'
    vault.set(`${vaultBackedId}-api-key`, 'sk-vault-backed')
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: vaultBackedId,
          method: 'anthropic-api-key',
          provider: 'anthropic',
          label: 'Claude · API key',
          state: 'connected',
          stateAt: '2026-08-09T09:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-08-09T09:00:00.000Z',
          secretRef: `secret://vault/${vaultBackedId}-api-key`,
        },
      ],
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      ...defaultRoutingConfig(),
      connectionKeys: { [vaultBackedId]: `secret://vault/${vaultBackedId}-api-key` },
    })

    const registry = new ModelConnectionRegistry(
      baseOptions(dir, [createByokAdapter('anthropic')], { vault }),
    )

    await registry.remove(vaultBackedId)

    expect(loadRoutingConfig(dir).connectionKeys[vaultBackedId]).toBeUndefined()
  })

  it('removing a connection with a legacy routing pointer drops the route in the same rebuild', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const vaultBackedId = 'e5e5e5e5-0000-4000-8000-000000000004'
    vault.set(`${vaultBackedId}-api-key`, 'sk-vault-backed')
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: vaultBackedId,
          method: 'anthropic-api-key',
          provider: 'anthropic',
          label: 'Claude · API key',
          state: 'connected',
          stateAt: '2026-08-09T09:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-08-09T09:00:00.000Z',
          secretRef: `secret://vault/${vaultBackedId}-api-key`,
        },
      ],
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      ...defaultRoutingConfig(),
      connectionKeys: { [vaultBackedId]: `secret://vault/${vaultBackedId}-api-key` },
    })

    // `onRoutingChanged` fires synchronously from inside `persist` — this
    // records what `routing.json`'s own pointer looks like at the EXACT
    // moment the live routing rebuild reads it, not after `remove` returns.
    const seenConnectionKeyDuringRebuild: (string | undefined)[] = []
    const registry = new ModelConnectionRegistry(
      baseOptions(dir, [createByokAdapter('anthropic')], {
        vault,
        onRoutingChanged: () => {
          seenConnectionKeyDuringRebuild.push(loadRoutingConfig(dir).connectionKeys[vaultBackedId])
        },
      }),
    )

    await registry.remove(vaultBackedId)

    expect(seenConnectionKeyDuringRebuild).toEqual([undefined])
  })
})

describe('remove tombstones a reserved legacy provider id (issue #47)', () => {
  it('removing a reauthorized migrated connection leaves a tombstone so boot cannot recreate it', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    // A minimal stand-in for the BYOK adapter's own authorize/revoke
    // (`model-connection-byok.ts`), narrowed to the one thing this test
    // cares about: a vault-backed `secretRef` is written on authorize and
    // deleted on revoke, exactly like the real adapter's contract.
    const adapter = createFakeAdapter({
      authorize: async (ctx, input) => {
        const vaultName = /^secret:\/\/vault\/(.+)$/.exec(ctx.secretRef ?? '')?.[1]
        if (vaultName !== undefined && ctx.vault !== undefined && input.apiKey !== undefined) {
          ctx.vault.set(vaultName, input.apiKey)
        }
        return { state: 'connected' }
      },
      revoke: async (ctx) => {
        const vaultName = /^secret:\/\/vault\/(.+)$/.exec(ctx.secretRef ?? '')?.[1]
        if (vaultName !== undefined) ctx.vault?.delete(vaultName)
        return { providerRevoked: false }
      },
    })
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [
        {
          id: 'anthropic',
          method: 'anthropic-api-key',
          provider: 'anthropic',
          label: 'Claude · API key (legacy)',
          state: 'connected',
          stateAt: '2026-08-09T09:00:00.000Z',
          enabledForFallback: false,
          createdAt: '2026-08-09T09:00:00.000Z',
          secretRef: 'secret://env/ANTHROPIC_API_KEY',
        },
      ],
      mockEnabled: false,
    })

    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter], { vault }))
    await registry.authorize('anthropic', { apiKey: 'sk-new-key' })
    expect(vault.has('anthropic-api-key')).toBe(true)

    await registry.remove('anthropic')

    const file = loadConnectionsConfig(dir)
    const tombstone = file.connections.find((c) => c.id === 'anthropic')
    expect(tombstone).toBeDefined()
    expect(tombstone?.state).toBe('revoked')
    expect(tombstone?.stateReason).toBe(
      "the daemon's legacy provider configuration still references this provider; the tombstone keeps it retired",
    )
    // The key material is gone — the vault entry the reauthorization
    // created is still deleted, even though the record survives as a
    // tombstone rather than being removed outright.
    expect(vault.has('anthropic-api-key')).toBe(false)

    // Boot-time reconcile must not recreate a fresh 'connected' record: the
    // tombstone already occupies the reserved 'anthropic' id, and
    // `reconcileByokConnections` skips any provider that already has one.
    reconcileByokConnections({
      rootDir: dir,
      routing: {
        ...defaultRoutingConfig(),
        providerKeys: { anthropic: 'secret://env/ANTHROPIC_API_KEY' },
      },
      secrets: envSecretResolver,
      now: () => new Date('2026-08-09T11:00:00.000Z'),
    })

    const afterBoot = loadConnectionsConfig(dir).connections.find((c) => c.id === 'anthropic')
    expect(afterBoot?.state).toBe('revoked')
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

describe('runtimes (issue #47)', () => {
  function codexAdapter(overrides: Partial<ModelConnectionAdapter> = {}): ModelConnectionAdapter {
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
      ...overrides,
    })
  }

  it('builds a subscription runtime for a connected Codex connection whose adapter implements stream', async () => {
    const dir = freshRoot()
    const adapter = codexAdapter({
      stream: async function* () {
        yield 'hello from codex'
      },
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const connectionId = created.connections[0]?.id
    if (!connectionId) throw new Error('test setup failed')
    await registry.authorize(connectionId, {})

    const [runtime] = registry.runtimes()

    expect(runtime).toMatchObject({ connectionId, provider: 'openai', transport: 'subscription' })
    expect(runtime?.stream).toBeTypeOf('function')
    const deltas: string[] = []
    for await (const delta of runtime!.stream!({
      modelId: 'gpt-5-codex',
      prompt: { systemPrompt: '', messages: [] },
    })) {
      deltas.push(delta)
    }
    expect(deltas).toEqual(['hello from codex'])
  })

  it('a connected adapter implementing stream gets a subscription runtime regardless of method id', async () => {
    const dir = freshRoot()
    // A BYOK-shaped api-key adapter that (hypothetically) also implements
    // `stream` — the transport decision is adapter-authoritative (issue
    // #47), never keyed off `record.method === 'chatgpt-codex'` specifically.
    const adapter = createFakeAdapter({
      stream: async function* () {
        yield 'hello from a non-codex subscription adapter'
      },
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'anthropic-api-key', apiKey: 'sk-test' })
    const connectionId = created.connections[0]?.id
    if (!connectionId) throw new Error('test setup failed')

    const [runtime] = registry.runtimes()

    expect(runtime).toMatchObject({
      connectionId,
      provider: 'anthropic',
      transport: 'subscription',
    })
  })

  it('reports a chatgpt-codex connection as builtin transport when its adapter has no stream verb', async () => {
    const dir = freshRoot()
    const adapter = codexAdapter() // no `stream` override
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const connectionId = created.connections[0]?.id
    if (!connectionId) throw new Error('test setup failed')
    await registry.authorize(connectionId, {})

    const [runtime] = registry.runtimes()

    expect(runtime).toEqual({ connectionId, provider: 'openai', transport: 'builtin' })
  })

  it('omits every connection that is not connected', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter()
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    await registry.create({ method: 'anthropic-api-key' }) // never authorized: stays 'available'

    expect(registry.runtimes()).toEqual([])
  })
})

describe('isTextOnly (issue #47)', () => {
  it('is true for a connected chatgpt-codex connection', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter({
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
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const connectionId = created.connections[0]?.id
    if (!connectionId) throw new Error('test setup failed')

    expect(registry.isTextOnly(connectionId)).toBe(true)
  })

  it('is false for a BYOK connection and for an id with no matching record', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter()
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))
    const created = await registry.create({ method: 'anthropic-api-key' })
    const connectionId = created.connections[0]?.id
    if (!connectionId) throw new Error('test setup failed')

    expect(registry.isTextOnly(connectionId)).toBe(false)
    expect(registry.isTextOnly('no-such-connection')).toBe(false)
  })
})

describe('ensureFresh (issue #47)', () => {
  it('returns the post-refresh lifecycle state', async () => {
    const dir = freshRoot()
    const adapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
      refresh: async () => ({ state: 'expired', reason: 'the refresh token is gone' }),
    })
    const record: ModelConnectionRecord = {
      id: 'aaaaaaaa-1111-4000-8000-000000000000',
      method: 'chatgpt-codex',
      provider: 'openai',
      label: 'ChatGPT · Subscription',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
    }
    saveConnectionsConfig(dir, { version: 1, connections: [record], mockEnabled: false })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))

    const state = await registry.ensureFresh('aaaaaaaa-1111-4000-8000-000000000000')

    expect(state).toBe('expired')
    expect(loadConnectionsConfig(dir).connections[0]?.state).toBe('expired')
  })

  it('returns undefined for a static-refresh method without calling the adapter', async () => {
    const dir = freshRoot()
    const refreshSpy = vi.fn()
    const adapter = createFakeAdapter({ refresh: refreshSpy })
    const record: ModelConnectionRecord = {
      id: 'anthropic',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
    }
    saveConnectionsConfig(dir, { version: 1, connections: [record], mockEnabled: false })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))

    expect(await registry.ensureFresh('anthropic')).toBeUndefined()
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('reports a revoked record even inside the freshness window', async () => {
    const dir = freshRoot()
    const refreshSpy = vi.fn()
    // A static-refresh method AND a `lastRefreshAt` from a minute ago —
    // BOTH of `ensureFresh`'s skip conditions would fire on this record if
    // its current state were read after them; the record's own state must
    // win over either skip.
    const adapter = createFakeAdapter({ refresh: refreshSpy })
    const record: ModelConnectionRecord = {
      id: 'anthropic',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key',
      state: 'revoked',
      stateAt: '2026-08-09T09:00:00.000Z',
      stateReason: 'the provider rejected this credential',
      lastRefreshAt: '2026-08-09T09:59:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
    }
    saveConnectionsConfig(dir, { version: 1, connections: [record], mockEnabled: false })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))

    expect(await registry.ensureFresh('anthropic')).toBe('revoked')
    expect(refreshSpy).not.toHaveBeenCalled()
  })
})

describe('authorize secretRef repointing (issue #47)', () => {
  function migratedEnvBackedRecord(
    overrides: Partial<ModelConnectionRecord> = {},
  ): ModelConnectionRecord {
    return {
      id: 'anthropic',
      method: 'anthropic-api-key',
      provider: 'anthropic',
      label: 'Claude · API key',
      state: 'connected',
      stateAt: '2026-08-09T09:00:00.000Z',
      enabledForFallback: false,
      createdAt: '2026-08-09T09:00:00.000Z',
      secretRef: 'secret://env/ANTHROPIC_API_KEY',
      ...overrides,
    }
  }

  it('reauthorizing a migrated env-backed connection repoints secretRef at the per-connection vault entry', async () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [migratedEnvBackedRecord()],
      mockEnabled: false,
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [createFakeAdapter()]))

    await registry.authorize('anthropic', { apiKey: 'sk-new-key' })

    const updated = loadConnectionsConfig(dir).connections.find((c) => c.id === 'anthropic')
    expect(updated?.secretRef).toBe('secret://vault/anthropic-api-key')
    expect(updated?.state).toBe('connected')
  })

  it('a reauthorized migrated connection resolves the new key for catalog and routing', async () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [migratedEnvBackedRecord({ selectedModelId: 'model-a' })],
      selection: { connectionId: 'anthropic', modelId: 'model-a' },
      mockEnabled: false,
    })
    let seenSecretRef: string | undefined
    const adapter = createFakeAdapter({
      catalog: async (ctx) => {
        seenSecretRef = ctx.secretRef
        return [{ id: 'model-a', label: 'Model A', routable: true }]
      },
    })
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter]))

    await registry.authorize('anthropic', { apiKey: 'sk-new-key' })

    expect(seenSecretRef).toBe('secret://vault/anthropic-api-key')
    const derived = deriveRoutingConfig(defaultRoutingConfig(), loadConnectionsConfig(dir))
    expect(derived.connectionKeys['anthropic']).toBe('secret://vault/anthropic-api-key')
  })
})

describe('applyRefreshResult compare-and-swap (issue #47)', () => {
  function deviceChallenge(userCode: string): DeviceChallenge {
    return {
      loginId: `login-${userCode}`,
      verificationUrl: 'https://chatgpt.com/device',
      userCode,
      expiresAt: '2026-08-09T12:00:00.000Z',
      expirySource: 'provider',
    }
  }

  it('a late refresh result never clobbers a newer reauthorization challenge', async () => {
    const dir = freshRoot()
    let refreshResolve: ((result: RefreshResult) => void) | undefined
    const refreshDeferred = new Promise<RefreshResult>((resolve) => {
      refreshResolve = resolve
    })
    let challengeCounter = 0
    const adapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
      authorize: async () => {
        challengeCounter += 1
        return { state: 'waiting-for-user', challenge: deviceChallenge(`CODE-${challengeCounter}`) }
      },
      refresh: () => refreshDeferred,
    })
    let clock = new Date('2026-08-09T10:00:00.000Z')
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter], { now: () => clock }))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed')
    await registry.authorize(id, {}) // challenge #1, at the first clock reading

    clock = new Date('2026-08-09T10:05:00.000Z') // the second, later clock reading
    const readPromise = registry.read(id) // captures the pre-image, then blocks on the deferred refresh

    // While that refresh is in flight, the user re-authorizes: a brand-new
    // challenge #2 replaces #1, and the record's stateAt moves to the later
    // clock reading.
    await registry.authorize(id, {})

    // Now the stale refresh resolves.
    refreshResolve!({ state: 'waiting-for-user' })
    const resolved = await readPromise

    expect(resolved.challenge?.userCode).toBe('CODE-2')
    expect(resolved.stateAt).toBe(clock.toISOString())
    const persisted = loadConnectionsConfig(dir).connections.find((c) => c.id === id)
    expect(persisted?.stateAt).toBe(clock.toISOString())
  })

  it('a late refresh result never overwrites a record changed while it was in flight', async () => {
    const dir = freshRoot()
    let refreshResolve: ((result: RefreshResult) => void) | undefined
    const refreshDeferred = new Promise<RefreshResult>((resolve) => {
      refreshResolve = resolve
    })
    const adapter = createFakeAdapter({ refresh: () => refreshDeferred })
    let clock = new Date('2026-08-09T10:00:00.000Z')
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter], { now: () => clock }))
    const created = await registry.create({ method: 'anthropic-api-key', apiKey: 'sk-test' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed')

    clock = new Date('2026-08-09T10:05:00.000Z')
    const refreshPromise = registry.refresh(id) // captures the 'connected'/creation-time pre-image

    clock = new Date('2026-08-09T10:10:00.000Z')
    await registry.noteCallFailure(id, new Error('boom')) // moves the record to 'failed'

    refreshResolve!({ state: 'connected' })
    const resolved = await refreshPromise

    expect(resolved.state).toBe('failed')
    const persisted = loadConnectionsConfig(dir).connections.find((c) => c.id === id)
    expect(persisted?.state).toBe('failed')
  })
})

describe('refresh singleflight challenge identity (issue #47)', () => {
  function deviceChallenge(userCode: string): DeviceChallenge {
    return {
      loginId: `login-${userCode}`,
      verificationUrl: 'https://chatgpt.com/device',
      userCode,
      expiresAt: '2026-08-09T12:00:00.000Z',
      expirySource: 'provider',
    }
  }

  it("a poll for a new challenge never receives the previous challenge's refresh result", async () => {
    const dir = freshRoot()
    let firstRefreshResolve: ((result: RefreshResult) => void) | undefined
    const firstRefreshDeferred = new Promise<RefreshResult>((resolve) => {
      firstRefreshResolve = resolve
    })
    let challengeCounter = 0
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => firstRefreshDeferred)
      .mockImplementationOnce(async () => ({ state: 'connected' }) satisfies RefreshResult)
    const adapter = createFakeAdapter({
      methodId: 'chatgpt-codex',
      providerName: 'openai',
      capabilities: {
        authorization: 'device-code',
        refresh: 'automatic',
        revocation: 'provider',
        vedutaTools: false,
        metered: false,
      },
      authorize: async () => {
        challengeCounter += 1
        return { state: 'waiting-for-user', challenge: deviceChallenge(`CODE-${challengeCounter}`) }
      },
      refresh,
    })
    // An advancing clock (mirroring `applyRefreshResult compare-and-swap`'s
    // own tests above): the compare-and-swap this test relies on to prove
    // A's stale result never persists distinguishes mutations by `stateAt`,
    // which only moves when `now()` actually does.
    let clock = new Date('2026-08-09T10:00:00.000Z')
    const registry = new ModelConnectionRegistry(baseOptions(dir, [adapter], { now: () => clock }))
    const created = await registry.create({ method: 'chatgpt-codex' })
    const id = created.connections[0]?.id
    if (!id) throw new Error('test setup failed')
    await registry.authorize(id, {}) // installs challenge #1 ("A")

    clock = new Date('2026-08-09T10:05:00.000Z')
    const pollA = registry.read(id) // starts a refresh call for challenge A, and blocks on it

    clock = new Date('2026-08-09T10:10:00.000Z')
    await registry.authorize(id, {}) // installs challenge #2 ("B") while A's refresh is still in flight

    const pollB = registry.read(id) // must NOT join A's stale in-flight refresh

    // A's refresh finally settles, with a result that would be wrong to
    // hand to a caller polling for B (the connection is not actually
    // 'connected' from B's point of view).
    firstRefreshResolve!({ state: 'expired', reason: 'stale result for challenge A' })

    const resultB = await pollB
    await pollA

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(resultB.state).toBe('connected')
  })
})
