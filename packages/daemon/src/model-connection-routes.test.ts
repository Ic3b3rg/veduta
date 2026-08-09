import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConnectionsConfig } from './connections-config.ts'
import type { AuthorizeResult, ModelConnectionAdapter } from './model-connection-adapter.ts'
import { BYOK_ADAPTERS } from './model-connection-byok.ts'
import { claudeSubscriptionAdapter } from './model-connection-claude.ts'
import {
  ModelConnectionRegistry,
  type ModelConnectionRegistryOptions,
} from './model-connection-registry.ts'
import {
  registerModelConnectionRoutes,
  type ModelConnectionRoutesDeps,
} from './model-connection-routes.ts'
import { SecretsVault } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const NOW = () => new Date('2026-08-09T10:00:00.000Z')

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-model-connection-routes-'))
  return rootDir
}

/** A fetch fake shared by every route test: valid for exactly the keys in `validKeys`, matching both `x-api-key` (Anthropic) and `Authorization: Bearer` (OpenAI/OpenRouter) — the same two header shapes `provider-api-key.ts`'s `PROVIDER_ENDPOINTS` actually sends. */
function fakeFetch(validKeys: ReadonlySet<string>): typeof fetch {
  const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const bearer = headers['Authorization']?.replace(/^Bearer\s+/, '')
    const key = headers['x-api-key'] ?? bearer
    if (key !== undefined && validKeys.has(key)) {
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200,
      })
    }
    return new Response('nope', { status: 401 })
  })
  return impl as unknown as typeof fetch
}

/** A scripted device-code adapter (`chatgpt-codex` is a real protocol method id; the Codex implementation itself does not exist until a later slice) — only `authorize`'s method-discrimination check needs a real device-code capability shape here. */
function fakeDeviceAdapter(
  overrides: Partial<ModelConnectionAdapter> = {},
): ModelConnectionAdapter {
  return {
    methodId: 'chatgpt-codex',
    providerName: 'openai',
    providerDisplayName: 'OpenAI',
    methodDisplayName: 'ChatGPT subscription',
    capabilities: {
      authorization: 'device-code',
      refresh: 'automatic',
      revocation: 'provider',
      vedutaTools: false,
      metered: false,
    },
    availability: async () => ({ available: true }),
    authorize: async (): Promise<AuthorizeResult> => ({
      state: 'waiting-for-user',
      challenge: {
        loginId: 'login-1',
        verificationUrl: 'https://chatgpt.com/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-08-09T10:15:00.000Z',
        expirySource: 'provider',
      },
    }),
    refresh: async () => ({ state: 'waiting-for-user' }),
    catalog: async () => [],
    verify: async () => {},
    revoke: async () => ({ providerRevoked: false }),
    ...overrides,
  }
}

interface Harness {
  dir: string
  app: FastifyInstance
  registry: ModelConnectionRegistry
  probe: ReturnType<typeof vi.fn>
  onRoutingChanged: ReturnType<typeof vi.fn>
  fetchImpl: typeof fetch
}

/** Builds a real registry (the real BYOK adapters, a real vault, a fake fetch for the provider endpoints) plus the routes registered over it — the `freshRoot()`/`buildApp()` idiom `onboarding-routes.test.ts` already uses. */
function harness(
  overrides: {
    validKeys?: ReadonlySet<string>
    adapters?: readonly ModelConnectionAdapter[]
    profile?: ModelConnectionRoutesDeps['profile']
    registryOverrides?: Partial<ModelConnectionRegistryOptions>
  } = {},
): Harness {
  const dir = freshRoot()
  const vault = SecretsVault.open(dir, KEY_MATERIAL)
  const probe = vi.fn().mockResolvedValue(undefined)
  const onRoutingChanged = vi.fn()
  const fetchImpl = fakeFetch(overrides.validKeys ?? new Set(['sk-valid']))
  const registry = new ModelConnectionRegistry({
    rootDir: dir,
    adapters: overrides.adapters ?? [...BYOK_ADAPTERS, claudeSubscriptionAdapter],
    vault,
    secrets: vault,
    profile: overrides.profile ?? 'loopback',
    fetchImpl,
    now: NOW,
    probe,
    isRoutableModel: () => true,
    onRoutingChanged,
    env: {},
    ...overrides.registryOverrides,
  })
  const app = Fastify()
  registerModelConnectionRoutes(app, { registry, profile: overrides.profile ?? 'loopback', probe })
  return { dir, app, registry, probe, onRoutingChanged, fetchImpl }
}

describe('GET /api/model-connections', () => {
  it('lists every method with the Claude method marked unavailable with its exact reason', async () => {
    const { app } = harness()
    const res = await app.inject({ method: 'GET', url: '/api/model-connections' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      methods: { id: string; available: boolean; unavailableReason?: string }[]
    }
    const claude = body.methods.find((m) => m.id === 'claude-subscription')
    expect(claude?.available).toBe(false)
    expect(claude?.unavailableReason).toBe(
      'Anthropic does not permit a third-party product to offer Claude.ai login or route subscription credentials without prior approval, so Veduta cannot ship this connection method yet. Anthropic API keys remain fully supported.',
    )
    const anthropicKey = body.methods.find((m) => m.id === 'anthropic-api-key')
    expect(anthropicKey?.available).toBe(true)
  })
})

describe('POST /api/model-connections', () => {
  it('with a valid key reaches connected and stores the key under <id>-api-key', async () => {
    const { app, dir } = harness({ validKeys: new Set(['sk-valid']) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { connections: { id: string; state: string }[] }
    expect(body.connections).toHaveLength(1)
    const connection = body.connections[0]
    expect(connection?.state).toBe('connected')

    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    expect(vault.resolve(`secret://vault/${connection?.id}-api-key`)).toBe('sk-valid')
  })

  it('with an invalid key never stores a vault entry and leaves the connection unusable', async () => {
    // The registry's own state machine (issue #47, `model-connection-registry.ts`'s
    // `create`) records a failed authorization attempt as a visible `failed`
    // connection rather than silently discarding it — the same "one state
    // machine, two authorizations" contract `POST /:id/authorize` uses, so a
    // user can see why it failed and retry. The route is a thin delegate
    // over that: it never throws for a bad key (only `create`'s own
    // `availability` check can), so the HTTP response is 200 with the
    // connection visibly `failed`, not a 400 with nothing persisted.
    const { app, dir } = harness({ validKeys: new Set(['sk-valid']) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-bad' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      connections: { id: string; state: string; stateReason?: string }[]
    }
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]?.state).toBe('failed')
    expect(body.connections[0]?.stateReason).toBe('the provider rejected this API key')

    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    expect(vault.resolve(`secret://vault/${body.connections[0]?.id}-api-key`)).toBeUndefined()
  })

  it('rejects an unsupported method with 409 and the exact Claude gate reason', async () => {
    const { app } = harness()
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'claude-subscription' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      error:
        'Anthropic does not permit a third-party product to offer Claude.ai login or route subscription credentials without prior approval, so Veduta cannot ship this connection method yet. Anthropic API keys remain fully supported.',
    })
  })

  it('rejects a body that fails schema validation with 400 and the zod issues', async () => {
    const { app } = harness()
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'not-a-real-method' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toHaveProperty('error')
  })

  it('two connections for the same provider coexist and neither overwrites the other', async () => {
    const { app, dir } = harness({ validKeys: new Set(['sk-first', 'sk-second']) })
    await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-first', label: 'Work' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-second', label: 'Personal' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/model-connections' })
    const body = res.json() as { connections: { id: string; state: string; label: string }[] }
    expect(body.connections).toHaveLength(2)
    expect(body.connections.every((c) => c.state === 'connected')).toBe(true)
    const [first, second] = body.connections
    expect(first?.id).not.toBe(second?.id)

    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    expect(vault.resolve(`secret://vault/${first?.id}-api-key`)).toBe('sk-first')
    expect(vault.resolve(`secret://vault/${second?.id}-api-key`)).toBe('sk-second')
  })
})

describe('GET/DELETE/PATCH /api/model-connections/:id', () => {
  it('GET on an unknown id returns 404 with the exact message', async () => {
    const { app } = harness()
    const res = await app.inject({ method: 'GET', url: '/api/model-connections/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'unknown Model connection' })
  })

  it('PATCH renames a connection and toggles enabledForFallback', async () => {
    const { app } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/model-connections/${id}`,
      payload: { label: 'Renamed', enabledForFallback: true },
    })
    expect(res.statusCode).toBe(200)
    const connection = (
      res.json() as { connections: { id: string; label: string; enabledForFallback: boolean }[] }
    ).connections.find((c) => c.id === id)
    expect(connection?.label).toBe('Renamed')
    expect(connection?.enabledForFallback).toBe(true)
  })

  it('DELETE removes the connection from the snapshot', async () => {
    const { app } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({ method: 'DELETE', url: `/api/model-connections/${id}` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { connections: unknown[] }).connections).toHaveLength(0)
  })
})

describe('POST /api/model-connections/:id/authorize', () => {
  it('rejects an empty body for an api-key connection', async () => {
    const { app } = harness()
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/authorize`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: 'this connection is an API-key connection: submit the replacement key',
    })
  })

  it('rejects an apiKey for a device-code connection', async () => {
    const { app } = harness({ adapters: [fakeDeviceAdapter()] })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'chatgpt-codex' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/authorize`,
      payload: { apiKey: 'sk-should-not-be-here' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error:
        "this connection re-authorizes through the provider's device code: submit an empty body",
    })
  })

  it('starts a device-code login and surfaces the challenge', async () => {
    const { app } = harness({ adapters: [fakeDeviceAdapter()] })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'chatgpt-codex' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/authorize`,
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      state: 'waiting-for-user',
      challenge: {
        loginId: 'login-1',
        verificationUrl: 'https://chatgpt.com/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-08-09T10:15:00.000Z',
        expirySource: 'provider',
      },
    })
  })
})

describe('POST /api/model-connections/:id/catalog', () => {
  it('marks a made-up model id as not routable when isRoutableModel says false', async () => {
    const { app } = harness({
      validKeys: new Set(['sk-valid']),
      registryOverrides: { isRoutableModel: (_provider, modelId) => modelId !== 'model-b' },
    })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/catalog`,
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const models = (res.json() as { models: { id: string; routable: boolean }[] }).models
    expect(models.find((m) => m.id === 'model-a')?.routable).toBe(true)
    expect(models.find((m) => m.id === 'model-b')?.routable).toBe(false)

    const snapshot = await app.inject({ method: 'GET', url: '/api/model-connections' })
    const snapshotBody = snapshot.json() as {
      connections: { id: string; catalog?: { id: string; routable: boolean }[] }[]
    }
    const catalog = snapshotBody.connections.find((c) => c.id === id)?.catalog
    expect(catalog?.find((m) => m.id === 'model-b')?.routable).toBe(false)
  })
})

describe('POST /api/model-connections/:id/verify', () => {
  it('returns ok when the probe succeeds', async () => {
    const { app, probe } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')
    probe.mockResolvedValueOnce(undefined)

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/verify`,
      payload: { modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: 'ok' })
  })

  it('returns a failed result with the provider exact reason (never an HTTP error)', async () => {
    const { app, probe } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')
    probe.mockRejectedValueOnce(new Error('the model rejected this request'))

    const res = await app.inject({
      method: 'POST',
      url: `/api/model-connections/${id}/verify`,
      payload: { modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: 'failed', reason: 'the model rejected this request' })
  })
})

describe('POST /api/model-connections/selection', () => {
  it('leaves the stored selection and the live routing untouched when the probe fails, and returns the exact failure', async () => {
    const { app, dir, probe, onRoutingChanged } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    onRoutingChanged.mockClear()
    probe.mockRejectedValueOnce(new Error('the provider refused this model'))

    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/selection',
      payload: { connectionId: id, modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'the provider refused this model' })
    expect(onRoutingChanged).not.toHaveBeenCalled()
    expect(loadConnectionsConfig(dir).selection).toBeUndefined()
  })

  it('commits the selection and the router only after the probe succeeds', async () => {
    const { app, dir, probe, onRoutingChanged } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    onRoutingChanged.mockClear()
    probe.mockResolvedValueOnce(undefined)

    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/selection',
      payload: { connectionId: id, modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { selection: { connectionId: string; modelId: string } | null }
    expect(body.selection).toEqual({ connectionId: id, modelId: 'model-a' })
    expect(onRoutingChanged).toHaveBeenCalledTimes(1)
    expect(loadConnectionsConfig(dir).selection).toEqual({ connectionId: id, modelId: 'model-a' })
  })

  it('returns the try-again reason when a connection mutation lands between prepare and commit', async () => {
    const { app, registry, probe } = harness({ validKeys: new Set(['sk-valid']) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: 'sk-valid' },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    probe.mockImplementationOnce(async () => {
      await registry.update(id, { label: 'mutated mid-probe' })
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/selection',
      payload: { connectionId: id, modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'the Model connections changed while the model test was running; try again',
    })
  })

  it('returns 404 for an unknown connection id', async () => {
    const { app } = harness()
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/selection',
      payload: { connectionId: '00000000-0000-0000-0000-000000000000', modelId: 'model-a' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/model-connections/mock', () => {
  it('returns 409 on the vps profile', async () => {
    const { app } = harness({ profile: 'vps' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/mock',
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'mock provider control is available only on the Local VPS profile',
    })
  })

  it('enables the mock control on the local-vps profile', async () => {
    const { app } = harness({ profile: 'local-vps' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-connections/mock',
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { mockEnabled: boolean }).mockEnabled).toBe(true)
  })
})

describe('secret hygiene', () => {
  it('never includes the stored API key in any response body', async () => {
    const distinctiveKey = 'sk-distinctive-secret-value-should-never-leak'
    const { app } = harness({ validKeys: new Set([distinctiveKey]) })
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-connections',
      payload: { method: 'anthropic-api-key', apiKey: distinctiveKey },
    })
    const id = (created.json() as { connections: { id: string }[] }).connections[0]?.id
    if (!id) throw new Error('test setup failed: no connection created')

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/model-connections' }),
      app.inject({ method: 'GET', url: `/api/model-connections/${id}` }),
      app.inject({ method: 'POST', url: `/api/model-connections/${id}/catalog`, payload: {} }),
    ])

    expect(JSON.stringify(created.json())).not.toContain(distinctiveKey)
    for (const response of responses) {
      expect(JSON.stringify(response.json())).not.toContain(distinctiveKey)
    }
  })
})
