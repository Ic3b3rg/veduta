import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BYOK_ADAPTERS, createByokAdapter } from './model-connection-byok.ts'
import { ModelConnectionError, type AdapterContext } from './model-connection-adapter.ts'
import { loadRoutingConfig, type SecretResolver } from './model-routing.ts'
import { VAULT_UNAVAILABLE_MESSAGE } from './onboarding-status.ts'
import { SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const CONNECTION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-byok-adapter-'))
  return rootDir
}

function contextFor(overrides: Partial<AdapterContext> = {}): AdapterContext {
  const dir = rootDir ?? freshRoot()
  const vault = SecretsVault.open(dir, KEY_MATERIAL)
  return fromPartial<AdapterContext>({
    connectionId: CONNECTION_ID,
    rootDir: dir,
    vault,
    secrets: vault,
    fetchImpl: vi.fn(),
    now: () => new Date('2026-08-09T10:00:00.000Z'),
    probe: vi.fn().mockResolvedValue(undefined),
    codexHome: join(dir, 'codex', CONNECTION_ID),
    ...overrides,
  })
}

function okModelsResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200 })
}

describe('createByokAdapter', () => {
  it('describes each provider correctly', () => {
    const anthropic = createByokAdapter('anthropic')
    expect(anthropic.methodId).toBe('anthropic-api-key')
    expect(anthropic.providerName).toBe('anthropic')
    expect(anthropic.providerDisplayName).toBe('Claude')
    expect(anthropic.methodDisplayName).toBe('API key')
    expect(anthropic.capabilities).toEqual({
      authorization: 'api-key',
      refresh: 'static',
      revocation: 'local-only',
      metered: true,
    })

    const openai = createByokAdapter('openai')
    expect(openai.methodId).toBe('openai-api-key')
    expect(openai.providerDisplayName).toBe('OpenAI')

    const openrouter = createByokAdapter('openrouter')
    expect(openrouter.methodId).toBe('openrouter-api-key')
    expect(openrouter.providerDisplayName).toBe('OpenRouter')
  })

  it('BYOK_ADAPTERS has exactly one adapter per BYOK provider', () => {
    expect(BYOK_ADAPTERS.map((adapter) => adapter.methodId).sort()).toEqual([
      'anthropic-api-key',
      'openai-api-key',
      'openrouter-api-key',
    ])
  })
})

describe('availability', () => {
  it('is unavailable with VAULT_UNAVAILABLE_MESSAGE when the vault is unavailable', async () => {
    const adapter = createByokAdapter('anthropic')
    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp', env: {}, vaultAvailable: false }),
    )
    expect(result).toEqual({ available: false, reason: VAULT_UNAVAILABLE_MESSAGE })
  })

  it('is available when the vault is available', async () => {
    const adapter = createByokAdapter('anthropic')
    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp', env: {}, vaultAvailable: true }),
    )
    expect(result).toEqual({ available: true })
  })
})

describe('authorize', () => {
  it('rejects a missing API key with the exact reason', async () => {
    const adapter = createByokAdapter('anthropic')
    const error = await adapter.authorize(contextFor(), {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('rejected')
    expect((error as ModelConnectionError).message).toBe(
      'an API key is required for this connection method',
    )
  })

  it('throws unauthorized when the provider rejects the key', async () => {
    const adapter = createByokAdapter('anthropic')
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }))
    const error = await adapter
      .authorize(contextFor({ fetchImpl }), { apiKey: 'sk-bad' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unauthorized')
    expect((error as ModelConnectionError).message).toBe('the provider rejected this API key')
  })

  it('throws unreachable when the provider cannot be reached', async () => {
    const adapter = createByokAdapter('anthropic')
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const error = await adapter
      .authorize(contextFor({ fetchImpl }), { apiKey: 'sk-whatever' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unreachable')
  })

  it('stores the key under <id>-api-key and returns connected on a valid key', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const adapter = createByokAdapter('openai')
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    const result = await adapter.authorize(contextFor({ vault, fetchImpl }), {
      apiKey: 'sk-good-key',
    })

    expect(result).toEqual({ state: 'connected' })
    expect(vault.resolve(`secret://vault/${CONNECTION_ID}-api-key`)).toBe('sk-good-key')
    // `storeConnectionApiKey` no longer writes `routing.json` at all (issue
    // #47): `connections.json`'s own `record.secretRef` is authoritative,
    // and the runtime `connectionKeys` map is rebuilt live from it.
    expect(loadRoutingConfig(dir).connectionKeys[CONNECTION_ID]).toBeUndefined()
  })
})

describe('refresh', () => {
  it('reports connected when the secretRef still resolves', async () => {
    const adapter = createByokAdapter('anthropic')
    const secrets: SecretResolver = { resolve: () => 'sk-still-here' }
    const result = await adapter.refresh(
      contextFor({ secrets, secretRef: 'secret://vault/whatever' }),
    )
    expect(result).toEqual({ state: 'connected' })
  })

  it('reports failed with the exact reason when the secretRef no longer resolves', async () => {
    const adapter = createByokAdapter('anthropic')
    const secrets: SecretResolver = { resolve: () => undefined }
    const result = await adapter.refresh(contextFor({ secrets, secretRef: 'secret://vault/gone' }))
    expect(result).toEqual({ state: 'failed', reason: 'the stored API key is gone from the vault' })
  })

  it('reports failed when there is no secretRef at all', async () => {
    const adapter = createByokAdapter('anthropic')
    const result = await adapter.refresh(contextFor())
    expect(result.state).toBe('failed')
  })
})

describe('catalog', () => {
  it('throws unauthorized when there is no stored key', async () => {
    const adapter = createByokAdapter('openai')
    const secrets: SecretResolver = { resolve: () => undefined }
    const error = await adapter
      .catalog(contextFor({ secrets, secretRef: 'secret://vault/gone' }))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unauthorized')
    expect((error as ModelConnectionError).message).toBe('no stored API key for this connection')
  })

  it('fetches the catalog through the resolved key', async () => {
    const adapter = createByokAdapter('openai')
    const secrets: SecretResolver = { resolve: () => 'sk-resolved' }
    const fetchImpl = vi.fn().mockResolvedValue(okModelsResponse())
    const entries = await adapter.catalog(
      contextFor({ secrets, secretRef: 'secret://vault/x', fetchImpl }),
    )
    expect(entries).toEqual([{ id: 'gpt-5.5', label: 'gpt-5.5', routable: true }])
  })
})

describe('verify', () => {
  it('delegates to ctx.probe', async () => {
    const adapter = createByokAdapter('anthropic')
    const probe = vi.fn().mockResolvedValue(undefined)
    await adapter.verify(contextFor({ probe }), 'claude-sonnet-5')
    expect(probe).toHaveBeenCalledWith('claude-sonnet-5')
  })

  it('surfaces the probe failure text exactly', async () => {
    const adapter = createByokAdapter('anthropic')
    const probe = vi.fn().mockRejectedValue(new Error('the model rejected the request'))
    await expect(adapter.verify(contextFor({ probe }), 'bad-model')).rejects.toThrow(
      'the model rejected the request',
    )
  })
})

describe('revoke', () => {
  it('never throws for a connection that was never authorized', async () => {
    const adapter = createByokAdapter('anthropic')
    await expect(adapter.revoke(contextFor())).resolves.toEqual({
      providerRevoked: false,
    })
  })

  it('deletes the vault entry for a vault-backed key', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set(`${CONNECTION_ID}-api-key`, 'sk-to-delete')
    const adapter = createByokAdapter('anthropic')

    const result = await adapter.revoke(
      contextFor({ vault, secretRef: `secret://vault/${CONNECTION_ID}-api-key` }),
    )

    expect(result).toEqual({ providerRevoked: false })
    expect(vault.has(`${CONNECTION_ID}-api-key`)).toBe(false)
  })

  it('keeps an env-backed key and notes it in the response', async () => {
    const adapter = createByokAdapter('anthropic')
    const result = await adapter.revoke(contextFor({ secretRef: 'secret://env/ANTHROPIC_API_KEY' }))
    expect(result.providerRevoked).toBe(false)
    expect(result.note).toBe(
      'the key comes from the daemon environment and stays there; remove the environment variable to retire it',
    )
  })
})
