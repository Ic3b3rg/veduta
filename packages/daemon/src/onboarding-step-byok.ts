import { join } from 'node:path'
import type { ByokApplyRequest, ByokProvider } from '@veduta/protocol'
import { backupFile } from './config-backup.ts'
import { loadRoutingConfig, saveRoutingConfig } from './model-routing.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError, VaultUnavailableError } from './onboarding-status.ts'
import { defaultRedactor } from './redaction.ts'
import { VAULT_FILE_NAME, type SecretsVault } from './secrets-vault.ts'

interface ProviderEndpoint {
  url: string
  headers(key: string): Record<string, string>
}

/**
 * Provider contract for the deterministic key check (§7):
 * hit each provider's own models-listing endpoint with the submitted key.
 * No LLM turn, no `pi-agent-core` — status code only.
 */
const PROVIDER_ENDPOINTS: Record<ByokProvider, ProviderEndpoint> = {
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
    const response = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers(key),
      redirect: 'error',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (response.status >= 200 && response.status < 300) return 'valid'
    if (response.status === 401 || response.status === 403) return 'invalid'
    return 'unreachable'
  } catch {
    return 'unreachable'
  }
}

export interface ByokDeps {
  rootDir: string
  vault: SecretsVault | undefined
}

/**
 * Points `routing.json`'s `providerKeys[name]` at `secret://vault/<name>` , split out of
 * `storeProviderKey` so both places that can make a provider key "current" — actually storing a new
 * value, and `applyByok`'s keep-existing branch, where a key may already be sitting in the vault
 * (from an earlier submit, or placed there out-of-band via the vault CLI) with nothing yet pointing
 * `routing.json` at it — reconcile the pointer the same way. Before this split, only
 * `storeProviderKey` ever wrote the pointer, so a keep-existing submit against an out-of-band vault
 * entry completed the step while leaving `routing.json.providerKeys` untouched — exactly the drift
 * this function's doc comment on `storeProviderKey` claims never happens.
 */
function pointRoutingAtVault(rootDir: string, name: string): void {
  const routing = loadRoutingConfig(rootDir)
  saveRoutingConfig(rootDir, {
    ...routing,
    providerKeys: { ...routing.providerKeys, [name]: `secret://vault/${name}` },
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
  pointRoutingAtVault(deps.rootDir, name)
}

/**
 * `POST /api/onboarding/byok` (§4). Idempotent, side-effects-first: skip just records `skipped`;
 * otherwise a submitted key is registered with `defaultRedactor` immediately on receipt (even on
 * the `VaultUnavailableError` path below, so the key never survives into that thrown error), then
 * `storeProviderKey` stores it and points routing at it — only then is the step marked `completed`.
 * Omitting `key` means "keep the existing stored key" (the keep-existing sentinel): it requires a
 * key already be in the vault, or throws an `OnboardingStepError` that never echoes any key value.
 * This branch also calls `pointRoutingAtVault` itself,
 * since `storeProviderKey` (which used to be the only place that ran it) is never called here.
 */
export function applyByok(deps: ByokDeps, request: ByokApplyRequest): void {
  const config = loadOnboardingConfig(deps.rootDir)

  if ('skip' in request) {
    saveOnboardingConfig(deps.rootDir, {
      ...config,
      steps: { ...config.steps, byok: 'skipped' },
    })
    return
  }

  const { provider, key } = request
  if (key !== undefined) {
    defaultRedactor.register(key)
    if (!deps.vault) throw new VaultUnavailableError()
    storeProviderKey({ rootDir: deps.rootDir, vault: deps.vault }, provider, key)
  } else {
    if (!deps.vault?.has(provider)) {
      throw new OnboardingStepError(`no stored key for ${provider}; submit a key or skip`)
    }
    pointRoutingAtVault(deps.rootDir, provider)
  }

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, byok: 'completed' },
  })
}
