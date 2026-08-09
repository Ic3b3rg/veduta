import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionError } from './model-connection-adapter.ts'
import { loadRoutingConfig } from './model-routing.ts'
import {
  MAX_CATALOG_BYTES,
  fetchProviderCatalog,
  storeConnectionApiKey,
  storeProviderKey,
  testProviderKey,
} from './provider-api-key.ts'
import { SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const DISTINCTIVE_KEY = 'sk-test-distinctive-marker-should-never-leak-987654321'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-provider-api-key-'))
  return rootDir
}

function okResponse(status: number): Response {
  return fromPartial<Response>({
    status,
    json: () => {
      throw new Error('response body must never be read')
    },
    text: () => {
      throw new Error('response body must never be read')
    },
  })
}

describe('testProviderKey', () => {
  it('anthropic: GETs the models endpoint with x-api-key + anthropic-version headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200))
    const result = await testProviderKey('anthropic', DISTINCTIVE_KEY, fetchImpl)
    expect(result).toBe('valid')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'x-api-key': DISTINCTIVE_KEY, 'anthropic-version': '2023-06-01' },
      }),
    )
  })

  it('openai: GETs the models endpoint with a Bearer Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200))
    const result = await testProviderKey('openai', DISTINCTIVE_KEY, fetchImpl)
    expect(result).toBe('valid')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ headers: { Authorization: `Bearer ${DISTINCTIVE_KEY}` } }),
    )
  })

  it('openrouter: GETs the models endpoint with a Bearer Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200))
    const result = await testProviderKey('openrouter', DISTINCTIVE_KEY, fetchImpl)
    expect(result).toBe('valid')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: { Authorization: `Bearer ${DISTINCTIVE_KEY}` } }),
    )
  })

  it('401 -> invalid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(401))
    expect(await testProviderKey('anthropic', DISTINCTIVE_KEY, fetchImpl)).toBe('invalid')
  })

  it('403 -> invalid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(403))
    expect(await testProviderKey('openai', DISTINCTIVE_KEY, fetchImpl)).toBe('invalid')
  })

  it('any other status -> unreachable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(500))
    expect(await testProviderKey('openrouter', DISTINCTIVE_KEY, fetchImpl)).toBe('unreachable')
  })

  it('a thrown network error -> unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    expect(await testProviderKey('anthropic', DISTINCTIVE_KEY, fetchImpl)).toBe('unreachable')
  })

  it('a timeout (AbortError) -> unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))
    expect(await testProviderKey('anthropic', DISTINCTIVE_KEY, fetchImpl)).toBe('unreachable')
  })

  it('never surfaces the key in a thrown/returned value beyond the verdict string', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error(`upstream said no for ${DISTINCTIVE_KEY}`))
    const result = await testProviderKey('anthropic', DISTINCTIVE_KEY, fetchImpl)
    expect(result).toBe('unreachable')
  })
})

describe('fetchProviderCatalog', () => {
  it('maps an OpenAI models response onto catalog entries', async () => {
    const body = JSON.stringify({ data: [{ id: 'gpt-5.5-mini' }, { id: 'gpt-5.5' }] })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))

    const entries = await fetchProviderCatalog('openai', DISTINCTIVE_KEY, fetchImpl)

    expect(entries).toEqual([
      { id: 'gpt-5.5', label: 'gpt-5.5', routable: true },
      { id: 'gpt-5.5-mini', label: 'gpt-5.5-mini', routable: true },
    ])
  })

  it('maps an Anthropic models response, preferring display_name over id for the label', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
        { id: 'claude-haiku-4-5' },
      ],
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))

    const entries = await fetchProviderCatalog('anthropic', DISTINCTIVE_KEY, fetchImpl)

    expect(entries).toEqual([
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', routable: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', routable: true },
    ])
  })

  it('refuses to follow a redirect', async () => {
    const body = JSON.stringify({ data: [{ id: 'gpt-5.5' }] })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))

    await fetchProviderCatalog('openai', DISTINCTIVE_KEY, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('aborts on the timeout', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'))

    const error = await fetchProviderCatalog('openai', DISTINCTIVE_KEY, fetchImpl).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unreachable')
  })

  it('refuses a body larger than 1 MiB', async () => {
    const oversized = 'x'.repeat(MAX_CATALOG_BYTES + 1024)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(oversized, { status: 200 }))

    const error = await fetchProviderCatalog('openai', DISTINCTIVE_KEY, fetchImpl).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unreachable')
    expect((error as ModelConnectionError).message).toContain('larger than 1 MiB')
  })

  it("throws ModelConnectionError('unauthorized') on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 }))

    const error = await fetchProviderCatalog('anthropic', DISTINCTIVE_KEY, fetchImpl).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unauthorized')
  })

  it("throws ModelConnectionError('unreachable') when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const error = await fetchProviderCatalog('openrouter', DISTINCTIVE_KEY, fetchImpl).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ModelConnectionError)
    expect((error as ModelConnectionError).code).toBe('unreachable')
  })
})

describe('storeConnectionApiKey', () => {
  it("stores under <id>-api-key and points routing.json's connectionKeys at it", () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const connectionId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

    storeConnectionApiKey({ rootDir: dir, vault }, connectionId, DISTINCTIVE_KEY)

    expect(vault.resolve(`secret://vault/${connectionId}-api-key`)).toBe(DISTINCTIVE_KEY)
    expect(loadRoutingConfig(dir).connectionKeys[connectionId]).toBe(
      `secret://vault/${connectionId}-api-key`,
    )
  })
})

describe('storeProviderKey', () => {
  it('keeps the legacy bare-provider vault name and providerKeys entry', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    storeProviderKey({ rootDir: dir, vault }, 'anthropic', DISTINCTIVE_KEY)

    expect(vault.resolve('secret://vault/anthropic')).toBe(DISTINCTIVE_KEY)
    expect(loadRoutingConfig(dir).providerKeys.anthropic).toBe('secret://vault/anthropic')
  })
})
