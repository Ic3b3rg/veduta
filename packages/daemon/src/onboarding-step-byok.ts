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
 * Provider contract for the deterministic key check (`tasks/plan.md` §7):
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
 * `POST /api/onboarding/byok/test` (`tasks/plan.md` §7). Deterministic key
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
 * `POST /api/onboarding/byok` (`tasks/plan.md` §4, decision 4/9). Idempotent,
 * side-effects-first: skip just records `skipped`; otherwise a submitted key
 * is registered with `defaultRedactor` immediately on receipt, the vault is
 * backed up before the write, then the key is stored and `routing.json`'s
 * `providerKeys[provider]` is pointed at the vault reference — only then is
 * the step marked `completed`. Omitting `key` means "keep the existing
 * stored key" (the keep-existing sentinel): it requires a key already be in
 * the vault, or throws an `OnboardingStepError` that never echoes any key value.
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
    backupFile(join(deps.rootDir, VAULT_FILE_NAME))
    deps.vault.set(provider, key)
  } else if (!deps.vault?.has(provider)) {
    throw new OnboardingStepError(`no stored key for ${provider}; submit a key or skip`)
  }

  const routing = loadRoutingConfig(deps.rootDir)
  saveRoutingConfig(deps.rootDir, {
    ...routing,
    providerKeys: { ...routing.providerKeys, [provider]: `secret://vault/${provider}` },
  })

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, byok: 'completed' },
  })
}
