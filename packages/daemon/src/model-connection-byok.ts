import { ByokProviderSchema, type ByokProvider, type ModelCatalogEntry } from '@veduta/protocol'
import {
  ModelConnectionError,
  type AdapterContext,
  type AdapterEnv,
  type AdapterAvailability,
  type AuthorizeInput,
  type AuthorizeResult,
  type ModelConnectionAdapter,
  type RefreshResult,
} from './model-connection-adapter.ts'
import { VAULT_UNAVAILABLE_MESSAGE } from './onboarding-status.ts'
import { fetchProviderCatalog, storeConnectionApiKey, testProviderKey } from './provider-api-key.ts'

/**
 * The BYOK Model connection method (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment): one adapter
 * per provider, all three sharing the same state machine —
 * `authorize` runs `testProviderKey` and, on success, stores the key under
 * `<connectionId>-api-key` (`provider-api-key.ts`), so two accounts on the
 * same provider never collide. `refresh` and `catalog` resolve the stored
 * key through `ctx.secrets`/`ctx.secretRef` rather than reaching into the
 * vault directly, so a vault-backed and an env-backed key (a migrated
 * legacy install) work through the identical code path.
 */

/** Exported so `model-connection-migration.ts` builds the same label text for a migrated legacy connection, rather than keeping a second copy of this map (issue #47). */
export const PROVIDER_DISPLAY_NAMES: Record<ByokProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

const METHOD_DISPLAY_NAME = 'API key'

function methodIdFor(provider: ByokProvider): `${ByokProvider}-api-key` {
  return `${provider}-api-key`
}

async function availability(env: AdapterEnv): Promise<AdapterAvailability> {
  if (!env.vaultAvailable) return { available: false, reason: VAULT_UNAVAILABLE_MESSAGE }
  return { available: true }
}

async function authorize(
  provider: ByokProvider,
  ctx: AdapterContext,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  if (input.apiKey === undefined) {
    throw new ModelConnectionError('rejected', 'an API key is required for this connection method')
  }
  const verdict = await testProviderKey(provider, input.apiKey, ctx.fetchImpl)
  if (verdict === 'invalid') {
    throw new ModelConnectionError('unauthorized', 'the provider rejected this API key')
  }
  if (verdict === 'unreachable') {
    throw new ModelConnectionError(
      'unreachable',
      'could not reach the provider to verify this API key; check the daemon has network access and try again',
    )
  }
  if (ctx.vault === undefined) {
    // `availability` already gates this method on `env.vaultAvailable`, so
    // this only fires if a caller bypasses that check.
    throw new ModelConnectionError('unsupported', VAULT_UNAVAILABLE_MESSAGE)
  }
  storeConnectionApiKey({ rootDir: ctx.rootDir, vault: ctx.vault }, ctx.connectionId, input.apiKey)
  return { state: 'connected' }
}

/**
 * BYOK has no automatic refresh (`capabilities.refresh: 'static'`): the only
 * thing worth re-checking on a poll is whether the stored key is still
 * reachable through the connection's own `secretRef` — a vault entry
 * deleted out of band, or an env var unset since boot, both surface here
 * rather than silently keeping a `connected` connection nothing can use.
 */
async function refresh(ctx: AdapterContext): Promise<RefreshResult> {
  const key = ctx.secretRef === undefined ? undefined : ctx.secrets.resolve(ctx.secretRef)
  if (key === undefined) {
    return { state: 'failed', reason: 'the stored API key is gone from the vault' }
  }
  return { state: 'connected' }
}

async function catalog(provider: ByokProvider, ctx: AdapterContext): Promise<ModelCatalogEntry[]> {
  const key = ctx.secretRef === undefined ? undefined : ctx.secrets.resolve(ctx.secretRef)
  if (key === undefined) {
    throw new ModelConnectionError('unauthorized', 'no stored API key for this connection')
  }
  return fetchProviderCatalog(provider, key, ctx.fetchImpl)
}

async function verify(ctx: AdapterContext, modelId: string): Promise<void> {
  await ctx.probe(modelId)
}

/**
 * Deletes the vault entry only when `secretRef` is vault-backed (issue #47):
 * an env-backed key (`secret://env/…`, kept alive by a migrated legacy
 * install that never moved its key into the vault) is never Veduta's to
 * delete — the note tells the operator the environment variable is what
 * actually needs removing; `model-connection-registry.ts`'s `remove` reads
 * this same distinction to replace an env-backed connection with a tombstone
 * instead of deleting the record outright. A connection that was never
 * authorized (`secretRef` absent) has nothing to revoke and never throws.
 */
async function revoke(ctx: AdapterContext): Promise<{ providerRevoked: boolean; note?: string }> {
  if (ctx.secretRef === undefined) return { providerRevoked: false }
  const vaultMatch = /^secret:\/\/vault\/(.+)$/.exec(ctx.secretRef)
  if (vaultMatch?.[1] !== undefined) {
    ctx.vault?.delete(vaultMatch[1])
    return { providerRevoked: false }
  }
  return {
    providerRevoked: false,
    note: 'the key comes from the daemon environment and stays there; remove the environment variable to retire it',
  }
}

export function createByokAdapter(provider: ByokProvider): ModelConnectionAdapter {
  return {
    methodId: methodIdFor(provider),
    providerName: provider,
    providerDisplayName: PROVIDER_DISPLAY_NAMES[provider],
    methodDisplayName: METHOD_DISPLAY_NAME,
    capabilities: {
      authorization: 'api-key',
      refresh: 'static',
      revocation: 'local-only',
      metered: true,
    },
    availability,
    authorize: (ctx, input) => authorize(provider, ctx, input),
    refresh,
    catalog: (ctx) => catalog(provider, ctx),
    verify,
    revoke,
  }
}

/** One adapter per BYOK provider (issue #47) — derived from the protocol schema so a new provider only ever needs adding in one place. */
export const BYOK_ADAPTERS: readonly ModelConnectionAdapter[] =
  ByokProviderSchema.options.map(createByokAdapter)
