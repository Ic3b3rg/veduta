import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  saveConnectionsConfig,
  type ConnectionsFile,
  type ModelConnectionRecord,
} from './connections-config.ts'
import {
  buildRuntimeRouting,
  deriveRoutingConfig,
  egressProvidersFor,
  pruneOrphanConnectionKeys,
  RoutingState,
} from './model-connection-routing.ts'
import { primaryRoutableMethodsFixture } from './model-connection-test-support.ts'
import {
  RuntimeRoutingConfigSchema,
  defaultRoutingConfig,
  loadRoutingConfig,
  saveRoutingConfig,
  type RoutingConfig,
  type SecretResolver,
} from './model-routing.ts'

const baseConfig: RoutingConfig = defaultRoutingConfig()
const primaryRoutableMethods = primaryRoutableMethodsFixture

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-connection-routing-'))
  return rootDir
}

function record(overrides: Partial<ModelConnectionRecord> = {}): ModelConnectionRecord {
  return fromPartial<ModelConnectionRecord>({
    id: 'conn-1',
    method: 'anthropic-api-key',
    provider: 'anthropic',
    label: 'Claude · API key',
    state: 'connected',
    stateAt: '2026-08-09T10:00:00.000Z',
    enabledForFallback: false,
    createdAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  })
}

function connectionsFile(overrides: Partial<ConnectionsFile> = {}): ConnectionsFile {
  return fromPartial<ConnectionsFile>({
    version: 1,
    connections: [],
    mockEnabled: false,
    ...overrides,
  })
}

describe('deriveRoutingConfig', () => {
  it('returns the base config unchanged when no selection is stored (a migrated install stays routed exactly as before)', () => {
    const file = connectionsFile({
      connections: [record({ id: 'anthropic', state: 'connected' })],
    })

    expect(deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)).toEqual(baseConfig)
  })

  it('a base tier entry whose migrated record is revoked is dropped', () => {
    const file = connectionsFile({
      connections: [record({ id: 'anthropic', provider: 'anthropic', state: 'revoked' })],
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.tiers.reasoning.map((entry) => entry.provider)).toEqual(['openai', 'openrouter'])
    expect(derived.tiers.triage.map((entry) => entry.provider)).toEqual(['openai', 'openrouter'])
  })

  it('leaves a base tier entry alone when no migrated record exists for it at all (pure legacy)', () => {
    const file = connectionsFile({
      connections: [record({ id: 'openai', provider: 'openai', state: 'revoked' })],
    })

    // Only `openai` has a record; `anthropic`/`openrouter` have none and
    // must pass through untouched, regardless of `openai`'s state.
    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.tiers.reasoning.map((entry) => entry.provider)).toEqual([
      'anthropic',
      'openrouter',
    ])
  })

  it('puts the selected connection first and only connected, enabledForFallback connections after it', () => {
    const active = record({
      id: 'conn-active',
      provider: 'anthropic',
      state: 'connected',
      selectedModelId: 'claude-sonnet-5',
      secretRef: 'secret://vault/conn-active-api-key',
    })
    const fallback = record({
      id: 'conn-fallback',
      provider: 'openai',
      state: 'connected',
      enabledForFallback: true,
      selectedModelId: 'gpt-5.5',
      secretRef: 'secret://vault/conn-fallback-api-key',
    })
    const ignoredNotEnabled = record({
      id: 'conn-not-enabled',
      provider: 'openrouter',
      state: 'connected',
      enabledForFallback: false,
      selectedModelId: 'anthropic/claude-sonnet-5',
    })
    const file = connectionsFile({
      connections: [active, fallback, ignoredNotEnabled],
      selection: { connectionId: 'conn-active', modelId: 'claude-sonnet-5' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    const expectedEntries = [
      { provider: 'anthropic', modelId: 'claude-sonnet-5', connectionId: 'conn-active' },
      { provider: 'openai', modelId: 'gpt-5.5', connectionId: 'conn-fallback' },
    ]
    expect(derived.tiers.reasoning).toEqual(expectedEntries)
    expect(derived.tiers.triage).toEqual(expectedEntries)
  })

  it('omits connected methods excluded by primary-route policy from the active and fallback chain', () => {
    const unavailableActive = record({
      id: 'conn-unavailable',
      method: 'claude-subscription',
      provider: 'anthropic',
      state: 'connected',
      selectedModelId: 'claude-sonnet-5',
    })
    const eligibleFallback = record({
      id: 'conn-fallback',
      method: 'openai-api-key',
      provider: 'openai',
      state: 'connected',
      enabledForFallback: true,
      selectedModelId: 'gpt-5.5',
    })
    const unavailableFallback = record({
      id: 'conn-unavailable-fallback',
      method: 'claude-subscription',
      provider: 'anthropic',
      state: 'connected',
      enabledForFallback: true,
      selectedModelId: 'claude-opus-5',
    })
    const file = connectionsFile({
      connections: [unavailableActive, eligibleFallback, unavailableFallback],
      selection: { connectionId: unavailableActive.id, modelId: 'claude-sonnet-5' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, new Set(['openai-api-key']))

    expect(derived.tiers.reasoning).toEqual([
      { provider: 'openai', modelId: 'gpt-5.5', connectionId: 'conn-fallback' },
    ])
    expect(derived.tiers.triage).toEqual(derived.tiers.reasoning)
  })

  it('omits an expired active connection so the tier holds only fallbacks', () => {
    const active = record({
      id: 'conn-active',
      provider: 'anthropic',
      state: 'expired',
      selectedModelId: 'claude-sonnet-5',
    })
    const fallback = record({
      id: 'conn-fallback',
      provider: 'openai',
      state: 'connected',
      enabledForFallback: true,
      selectedModelId: 'gpt-5.5',
    })
    const file = connectionsFile({
      connections: [active, fallback],
      selection: { connectionId: 'conn-active', modelId: 'claude-sonnet-5' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.tiers.reasoning).toEqual([
      { provider: 'openai', modelId: 'gpt-5.5', connectionId: 'conn-fallback' },
    ])
  })

  it('omits a revoked active connection, leaving an empty tier when no fallback is enabled', () => {
    const active = record({
      id: 'conn-active',
      state: 'revoked',
      selectedModelId: 'claude-sonnet-5',
    })
    const file = connectionsFile({
      connections: [active],
      selection: { connectionId: 'conn-active', modelId: 'claude-sonnet-5' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.tiers.reasoning).toEqual([])
    expect(derived.tiers.triage).toEqual([])
    expect(() => RuntimeRoutingConfigSchema.parse(derived)).not.toThrow()
  })

  it('omits a connection with enabledForFallback false, so a subscription never falls back to metered BYOK implicitly', () => {
    const active = record({
      id: 'conn-subscription',
      provider: 'openai',
      state: 'connected',
      selectedModelId: 'gpt-5.5-codex',
    })
    const byok = record({
      id: 'conn-byok',
      provider: 'anthropic',
      state: 'connected',
      enabledForFallback: false,
      selectedModelId: 'claude-sonnet-5',
    })
    const file = connectionsFile({
      connections: [active, byok],
      selection: { connectionId: 'conn-subscription', modelId: 'gpt-5.5-codex' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.tiers.reasoning).toEqual([
      { provider: 'openai', modelId: 'gpt-5.5-codex', connectionId: 'conn-subscription' },
    ])
  })

  it('carries secret://env refs through connectionKeys', () => {
    const active = record({
      id: 'anthropic',
      provider: 'anthropic',
      state: 'connected',
      selectedModelId: 'claude-sonnet-5',
      secretRef: 'secret://env/ANTHROPIC_API_KEY',
    })
    const file = connectionsFile({
      connections: [active],
      selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.connectionKeys['anthropic']).toBe('secret://env/ANTHROPIC_API_KEY')
  })

  it('omits a keyless connection (Codex) from connectionKeys while still routing it', () => {
    const active = record({
      id: 'conn-codex',
      method: 'chatgpt-codex',
      provider: 'openai',
      state: 'connected',
      selectedModelId: 'gpt-5.5-codex',
    })
    const file = connectionsFile({
      connections: [active],
      selection: { connectionId: 'conn-codex', modelId: 'gpt-5.5-codex' },
    })

    const derived = deriveRoutingConfig(baseConfig, file, primaryRoutableMethods)

    expect(derived.connectionKeys['conn-codex']).toBeUndefined()
    expect(derived.tiers.reasoning).toEqual([
      { provider: 'openai', modelId: 'gpt-5.5-codex', connectionId: 'conn-codex' },
    ])
  })
})

describe('RoutingState', () => {
  it('current() reflects the most recent replace()', () => {
    const initial = RuntimeRoutingConfigSchema.parse(baseConfig)
    const state = new RoutingState(initial)
    expect(state.current()).toEqual(initial)

    const next = RuntimeRoutingConfigSchema.parse({
      ...baseConfig,
      tiers: { triage: [], reasoning: [] },
    })
    state.replace(next)

    expect(state.current()).toEqual(next)
  })
})

describe('egressProvidersFor', () => {
  it('maps a uuid connection id back onto its canonical provider through connections.json', () => {
    const file = connectionsFile({
      connections: [record({ id: 'uuid-1', provider: 'openai' })],
    })
    const config = RuntimeRoutingConfigSchema.parse({
      ...baseConfig,
      providerKeys: {},
      connectionKeys: { 'uuid-1': 'secret://vault/uuid-1-api-key' },
    })

    expect(egressProvidersFor(config, file)).toEqual(['openai'])
  })

  it('resolves a legacy providerKeys entry to itself when no connection record matches', () => {
    const config = RuntimeRoutingConfigSchema.parse(baseConfig)

    expect(egressProvidersFor(config, connectionsFile())).toEqual(
      Object.keys(baseConfig.providerKeys),
    )
  })

  it('ignores connection ids with no record, unlike the providerKeys fallback', () => {
    const config = RuntimeRoutingConfigSchema.parse({
      ...baseConfig,
      providerKeys: {},
      connectionKeys: { 'ghost-conn': 'secret://vault/ghost-conn-api-key' },
    })

    expect(egressProvidersFor(config, connectionsFile())).toEqual([])
  })
})

describe('pruneOrphanConnectionKeys', () => {
  it('drops entries with no connection record', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [record({ id: 'anthropic', provider: 'anthropic' })],
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      ...defaultRoutingConfig(),
      connectionKeys: {
        anthropic: 'secret://vault/anthropic-api-key',
        'ghost-conn': 'secret://vault/ghost-conn-api-key',
      },
    })

    const changed = pruneOrphanConnectionKeys(dir)

    expect(changed).toBe(true)
    expect(loadRoutingConfig(dir).connectionKeys).toEqual({
      anthropic: 'secret://vault/anthropic-api-key',
    })
  })

  it('returns false and writes nothing when every entry already matches a record', () => {
    const dir = freshRoot()
    saveConnectionsConfig(dir, {
      version: 1,
      connections: [record({ id: 'anthropic', provider: 'anthropic' })],
      mockEnabled: false,
    })
    saveRoutingConfig(dir, {
      ...defaultRoutingConfig(),
      connectionKeys: { anthropic: 'secret://vault/anthropic-api-key' },
    })

    expect(pruneOrphanConnectionKeys(dir)).toBe(false)
  })
})

describe('buildRuntimeRouting', () => {
  it('a failed selected connection routes to nothing rather than the mock on loopback', () => {
    const dir = freshRoot()
    const file: ConnectionsFile = connectionsFile({
      connections: [
        record({ id: 'conn-active', state: 'expired', selectedModelId: 'claude-sonnet-5' }),
      ],
      selection: { connectionId: 'conn-active', modelId: 'claude-sonnet-5' },
    })
    const noKeysResolve: SecretResolver = { resolve: () => undefined }

    const runtime = buildRuntimeRouting({
      rootDir: dir,
      file,
      secrets: noKeysResolve,
      profile: 'loopback',
      primaryRoutableMethods,
    })

    expect(runtime.tiers.reasoning).toEqual([])
    expect(runtime.tiers.reasoning.some((entry) => entry.provider === 'mock')).toBe(false)
  })

  it('appends the mock on loopback with no selection at all (unchanged legacy behavior)', () => {
    const dir = freshRoot()
    const noKeysResolve: SecretResolver = { resolve: () => undefined }

    const runtime = buildRuntimeRouting({
      rootDir: dir,
      file: connectionsFile(),
      secrets: noKeysResolve,
      profile: 'loopback',
      primaryRoutableMethods,
    })

    expect(runtime.tiers.reasoning.at(-1)).toEqual({ provider: 'mock', modelId: 'worker-mock' })
  })
})
