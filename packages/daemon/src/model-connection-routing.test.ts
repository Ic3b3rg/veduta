import { describe, expect, it } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import type { ConnectionsFile, ModelConnectionRecord } from './connections-config.ts'
import {
  deriveRoutingConfig,
  egressProvidersFor,
  RoutingState,
} from './model-connection-routing.ts'
import {
  RuntimeRoutingConfigSchema,
  defaultRoutingConfig,
  type RoutingConfig,
} from './model-routing.ts'

const baseConfig: RoutingConfig = defaultRoutingConfig()

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

    expect(deriveRoutingConfig(baseConfig, file)).toEqual(baseConfig)
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

    const derived = deriveRoutingConfig(baseConfig, file)

    const expectedEntries = [
      { provider: 'anthropic', modelId: 'claude-sonnet-5', connectionId: 'conn-active' },
      { provider: 'openai', modelId: 'gpt-5.5', connectionId: 'conn-fallback' },
    ]
    expect(derived.tiers.reasoning).toEqual(expectedEntries)
    expect(derived.tiers.triage).toEqual(expectedEntries)
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

    const derived = deriveRoutingConfig(baseConfig, file)

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

    const derived = deriveRoutingConfig(baseConfig, file)

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

    const derived = deriveRoutingConfig(baseConfig, file)

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

    const derived = deriveRoutingConfig(baseConfig, file)

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

    const derived = deriveRoutingConfig(baseConfig, file)

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
})
