import { join } from 'node:path'
import type { ByokProvider, ModelCatalogEntry } from '@veduta/protocol'
import { z } from 'zod'
import { backupFile } from './config-backup.ts'
import { ModelConnectionError, connectionErrorFrom } from './model-connection-adapter.ts'
import { loadRoutingConfig, sanitizeErrorText, saveRoutingConfig } from './model-routing.ts'
import { defaultRedactor } from './redaction.ts'
import { VAULT_FILE_NAME, type SecretsVault } from './secrets-vault.ts'

interface ProviderEndpoint {
  url: string
  headers(key: string): Record<string, string>
}

/**
 * Provider contract for the deterministic key check (§7):
 * hit each provider's own models-listing endpoint with the submitted key.
 * No LLM turn, no `pi-agent-core` — status code only. Also the endpoint
 * `fetchProviderCatalog` reads a real body from, for the Model connections
 * catalog step (issue #47).
 */
export const PROVIDER_ENDPOINTS: Record<ByokProvider, ProviderEndpoint> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
}

const TEST_TIMEOUT_MS = 10_000

/** The GET every provider check shares — no redirect, bounded by `timeoutMs` — behind one place so `testProviderKey` and `fetchProviderCatalog` cannot drift on the request shape. */
function fetchModelsEndpoint(
  endpoint: ProviderEndpoint,
  key: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(endpoint.url, {
    method: 'GET',
    headers: endpoint.headers(key),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * `POST /api/onboarding/byok/test` (§7). Deterministic key
 * check: GETs the provider's models endpoint, follows no redirects, and
 * NEVER reads the response body — only the status code decides the
 * verdict (2xx `valid`; 401/403 `invalid`; anything else, a thrown fetch,
 * or a timeout is `unreachable`). The key is registered with
 * `defaultRedactor` before anything else runs, so it can never leak through
 * a thrown error or a log line downstream of this call.
 */
export async function testProviderKey(
  provider: ByokProvider,
  key: string,
  fetchImpl: typeof fetch,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  defaultRedactor.register(key)
  const endpoint = PROVIDER_ENDPOINTS[provider]
  try {
    const response = await fetchModelsEndpoint(endpoint, key, TEST_TIMEOUT_MS, fetchImpl)
    if (response.status >= 200 && response.status < 300) return 'valid'
    if (response.status === 401 || response.status === 403) return 'invalid'
    return 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/**
 * Points `routing.json`'s `providerKeys[routingKey]` at
 * `secret://vault/<vaultName>`, split out of `storeProviderKey` so both
 * places that can make a provider key "current" — actually storing a new
 * value, and `applyByok`'s keep-existing branch, where a key may already be
 * sitting in the vault (from an earlier submit, or placed there out-of-band
 * via the vault CLI) with nothing yet pointing `routing.json` at it —
 * reconcile the pointer the same way. `routingKey` and `vaultName` are taken
 * separately (issue #47) so a caller can point a routing key at a
 * differently-named vault entry; every current caller still passes the same
 * name for both.
 */
export function pointRoutingAtVault(rootDir: string, routingKey: string, vaultName: string): void {
  const routing = loadRoutingConfig(rootDir)
  saveRoutingConfig(rootDir, {
    ...routing,
    providerKeys: { ...routing.providerKeys, [routingKey]: `secret://vault/${vaultName}` },
  })
}

/**
 * Stores one provider key in the vault AND points `routing.json`'s
 * `providerKeys[name]` at the vault reference, as a single unit of work
 *: the two must never drift apart, since a
 * vault entry with nothing in `routing.json` pointing at it is invisible to
 * the router, and a `routing.json` pointer with nothing in the vault is a
 * dangling reference. Extracted out of `applyByok` (issue #19) so the
 * importer's secrets step (`import-apply.ts`) shares this exact
 * implementation instead of a second hand-rolled copy — `name` is a BYOK
 * provider id (`anthropic`/`openai`/`openrouter`) in both callers, but this
 * function does not itself constrain it, since the importer's allowlist
 * (`import-secrets.ts`) already guarantees only those three ever reach here.
 * `value` is registered with `defaultRedactor` before anything else, so it
 * can never survive into a log line or thrown error from this point on. The
 * vault file is backed up before the write (issue #15 discipline: every
 * mutation of a durable store gets a restorable backup first).
 */
export function storeProviderKey(
  deps: { rootDir: string; vault: SecretsVault },
  name: string,
  value: string,
): void {
  defaultRedactor.register(value)
  backupFile(join(deps.rootDir, VAULT_FILE_NAME))
  deps.vault.set(name, value)
  pointRoutingAtVault(deps.rootDir, name, name)
}

/**
 * Stores one Model connection's API key in the vault under
 * `<connectionId>-api-key` — keyed by the connection id rather than the bare
 * provider name `storeProviderKey` uses, so two independently named
 * connections for the same provider (issue #47's "Multiple accounts"
 * acceptance criterion) never overwrite each other's vault entry. `key` is
 * registered with `defaultRedactor` before anything else runs, and the vault
 * file is backed up before the write (issue #15 discipline).
 *
 * Deliberately never touches `routing.json` (issue #47): `connections.json`'s
 * own `record.secretRef` — set by `model-connection-registry.ts`'s
 * `runAuthorization`, the caller of the adapter method that calls this — is
 * the authoritative pointer for a Model connection's key, and the runtime
 * `connectionKeys` map the router actually reads is rebuilt live from it on
 * every mutation (`model-connection-routing.ts`'s `deriveRoutingConfig`).
 * A second, persisted copy in `routing.json` would be redundant at best and
 * a stale, unresolvable pointer at worst the moment the connection is
 * removed or reauthorized elsewhere.
 */
export function storeConnectionApiKey(
  deps: { rootDir: string; vault: SecretsVault },
  connectionId: string,
  key: string,
): void {
  defaultRedactor.register(key)
  const secretName = `${connectionId}-api-key`
  backupFile(join(deps.rootDir, VAULT_FILE_NAME))
  deps.vault.set(secretName, key)
}

/** GETs the provider's models endpoint above `TEST_TIMEOUT_MS`; `fetchProviderCatalog` uses a longer, catalog-sized budget instead. */
export const CATALOG_TIMEOUT_MS = 15_000
/** A catalog body over this size is refused before it is fully buffered. */
export const MAX_CATALOG_BYTES = 1_048_576
/** The parsed catalog is truncated — never errored — at this many entries. */
export const MAX_CATALOG_ENTRIES = 500

const AnthropicCatalogEntrySchema = z
  .object({ id: z.string().min(1), display_name: z.string().optional() })
  .passthrough()
const AnthropicCatalogResponseSchema = z.object({ data: z.array(AnthropicCatalogEntrySchema) })

/** OpenAI and OpenRouter both serve `{ data: [{ id, ... }] }` from their models-listing endpoint. */
const OpenAiShapedCatalogEntrySchema = z.object({ id: z.string().min(1) }).passthrough()
const OpenAiShapedCatalogResponseSchema = z.object({
  data: z.array(OpenAiShapedCatalogEntrySchema),
})

/**
 * Reads `response`'s body through a byte-counted stream, refusing anything
 * over `MAX_CATALOG_BYTES` before it is fully buffered — a provider that
 * returns an unexpectedly huge catalog is refused up front rather than
 * exhausting memory reading it. Falls back to `response.text()` when the
 * response carries no readable stream (a bare test double never shaped like
 * a real fetch `Response`).
 */
async function readCappedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_CATALOG_BYTES) {
        throw new ModelConnectionError(
          'unreachable',
          "the provider's model list was larger than 1 MiB; refusing to read it",
        )
      }
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/** Maps a provider's raw, schema-validated catalog body onto the protocol's `ModelCatalogEntry` shape. `routable` is left `true` — the registry recomputes it against this build's actual routable models. */
function mapCatalogEntries(provider: ByokProvider, raw: unknown): ModelCatalogEntry[] {
  if (provider === 'anthropic') {
    const parsed = AnthropicCatalogResponseSchema.parse(raw)
    return parsed.data.map((entry) => ({
      id: entry.id,
      label: entry.display_name ?? entry.id,
      routable: true,
    }))
  }
  const parsed = OpenAiShapedCatalogResponseSchema.parse(raw)
  return parsed.data.map((entry) => ({ id: entry.id, label: entry.id, routable: true }))
}

async function sanitizedResponseText(response: Response): Promise<string> {
  try {
    return sanitizeErrorText(await response.text())
  } catch {
    return sanitizeErrorText(`HTTP ${response.status}`)
  }
}

/**
 * Fetches `provider`'s model catalog with an already-verified API key
 * (issue #47's catalog fetch hardening): no redirect is followed, the
 * request is bounded to `CATALOG_TIMEOUT_MS`, the body is read through a
 * byte-counted stream capped at `MAX_CATALOG_BYTES`, the parsed result is
 * sorted by id and truncated at `MAX_CATALOG_ENTRIES`, and `key` is
 * registered with `defaultRedactor` before the request goes out. A 401/403
 * throws `ModelConnectionError('unauthorized', …)`; any other non-2xx or a
 * thrown fetch throws `'unreachable'`; every thrown message is sanitized.
 */
export async function fetchProviderCatalog(
  provider: ByokProvider,
  key: string,
  fetchImpl: typeof fetch,
): Promise<ModelCatalogEntry[]> {
  defaultRedactor.register(key)
  const endpoint = PROVIDER_ENDPOINTS[provider]

  let response: Response
  try {
    response = await fetchModelsEndpoint(endpoint, key, CATALOG_TIMEOUT_MS, fetchImpl)
  } catch (error) {
    throw connectionErrorFrom(error)
  }

  if (response.status === 401 || response.status === 403) {
    throw new ModelConnectionError('unauthorized', await sanitizedResponseText(response))
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ModelConnectionError('unreachable', await sanitizedResponseText(response))
  }

  const body = await readCappedBody(response)
  let entries: ModelCatalogEntry[]
  try {
    entries = mapCatalogEntries(provider, JSON.parse(body))
  } catch (error) {
    throw connectionErrorFrom(error)
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_CATALOG_ENTRIES)
}
