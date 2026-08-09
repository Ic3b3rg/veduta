import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { ConnectionLifecycleStateSchema, ModelCatalogEntrySchema } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelConnectionError,
  type AdapterContext,
  type ModelConnectionAdapter,
  type ModelConnectionErrorCode,
} from './model-connection-adapter.ts'
import { claudeSubscriptionAdapter } from './model-connection-claude.ts'
import { BYOK_ADAPTERS } from './model-connection-byok.ts'
import type { SecretResolver } from './model-routing.ts'
import { SecretsVault } from './secrets-vault.ts'

/**
 * Every `ModelConnectionAdapter` — BYOK's three providers plus the
 * permanently-unavailable Claude subscription gate — is exercised against
 * the same five contract assertions (issue #47's adapter contract suite),
 * so a future adapter (Codex) inherits the same guarantees just by joining
 * this `describe.each` table.
 */

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000000'
const VALID_ERROR_CODES: ModelConnectionErrorCode[] = [
  'unauthorized',
  'expired',
  'rejected',
  'unreachable',
  'unsupported',
  'internal',
]

interface AdapterCase {
  name: string
  adapter: ModelConnectionAdapter
  available: boolean
  buildContext: (rootDir: string) => AdapterContext
}

function fetchImplFor(status: number, body: unknown): typeof fetch {
  return vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

function byokCase(adapter: ModelConnectionAdapter): AdapterCase {
  return {
    name: adapter.methodId,
    adapter,
    available: true,
    buildContext: (rootDir: string): AdapterContext => {
      const vault = SecretsVault.open(rootDir, KEY_MATERIAL)
      vault.set(`${CONNECTION_ID}-api-key`, 'sk-contract-test')
      return fromPartial<AdapterContext>({
        connectionId: CONNECTION_ID,
        rootDir,
        vault,
        secrets: vault,
        secretRef: `secret://vault/${CONNECTION_ID}-api-key`,
        fetchImpl: fetchImplFor(200, { data: [{ id: 'model-a' }] }),
        now: () => new Date('2026-08-09T10:00:00.000Z'),
        probe: vi.fn().mockResolvedValue(undefined),
        codexHome: join(rootDir, 'codex', CONNECTION_ID),
      })
    },
  }
}

const CLAUDE_CASE: AdapterCase = {
  name: claudeSubscriptionAdapter.methodId,
  adapter: claudeSubscriptionAdapter,
  available: false,
  buildContext: (rootDir: string): AdapterContext =>
    fromPartial<AdapterContext>({
      connectionId: CONNECTION_ID,
      rootDir,
      vault: undefined,
      secrets: fromPartial<SecretResolver>({ resolve: () => undefined }),
      fetchImpl: vi.fn(),
      now: () => new Date('2026-08-09T10:00:00.000Z'),
      probe: vi.fn().mockResolvedValue(undefined),
      codexHome: join(rootDir, 'codex', CONNECTION_ID),
    }),
}

const CASES: AdapterCase[] = [...BYOK_ADAPTERS.map(byokCase), CLAUDE_CASE]

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-adapter-contract-'))
  return rootDir
}

describe.each(CASES)('adapter contract: $name', ({ adapter, available, buildContext }) => {
  it('authorize returns a lifecycle state the protocol enum contains, or throws a typed ModelConnectionError', async () => {
    const ctx = buildContext(freshRoot())
    try {
      const result = await adapter.authorize(ctx, { apiKey: 'sk-contract-test' })
      expect(ConnectionLifecycleStateSchema.safeParse(result.state).success).toBe(true)
    } catch (error) {
      expect(error).toBeInstanceOf(ModelConnectionError)
      expect(VALID_ERROR_CODES).toContain((error as ModelConnectionError).code)
    }
  })

  it('catalog returns entries the protocol schema parses when available, else throws unsupported', async () => {
    const ctx = buildContext(freshRoot())
    if (!available) {
      const error = await adapter.catalog(ctx).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ModelConnectionError)
      expect((error as ModelConnectionError).code).toBe('unsupported')
      return
    }
    const entries = await adapter.catalog(ctx)
    for (const entry of entries) {
      expect(ModelCatalogEntrySchema.safeParse(entry).success).toBe(true)
    }
  })

  it("verify surfaces the probe's exact failure text when available, else throws unsupported without ever calling it", async () => {
    const probe = vi.fn().mockRejectedValue(new Error('contract-test probe failure'))
    const ctx: AdapterContext = { ...buildContext(freshRoot()), probe }
    const error = await adapter.verify(ctx, 'some-model').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    if (!available) {
      expect((error as ModelConnectionError).code).toBe('unsupported')
      expect(probe).not.toHaveBeenCalled()
      return
    }
    expect((error as Error).message).toContain('contract-test probe failure')
  })

  it('revoke never throws for a connection that was never authorized', async () => {
    // A never-authorized connection has no `secretRef` at all — dropping the
    // key (rather than setting it to `undefined`) is what `contextFor`
    // itself does for a fresh connection.
    const { secretRef: _droppedSecretRef, ...rest } = buildContext(freshRoot())
    const ctx: AdapterContext = rest
    if (!available) {
      await expect(adapter.revoke(ctx)).rejects.toBeInstanceOf(ModelConnectionError)
      return
    }
    await expect(adapter.revoke(ctx)).resolves.toBeDefined()
  })

  it('an unavailable adapter throws unsupported from every verb', async () => {
    if (available) return
    const ctx = buildContext(freshRoot())
    const verbs: Array<() => Promise<unknown>> = [
      () => adapter.authorize(ctx, {}),
      () => adapter.refresh(ctx),
      () => adapter.catalog(ctx),
      () => adapter.verify(ctx, 'model'),
      () => adapter.revoke(ctx),
    ]
    for (const verb of verbs) {
      const error = await verb().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ModelConnectionError)
      expect((error as ModelConnectionError).code).toBe('unsupported')
    }
  })
})
