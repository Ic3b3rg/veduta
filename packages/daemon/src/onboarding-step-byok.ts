import type { ByokApplyRequest } from '@veduta/protocol'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError, VaultUnavailableError } from './onboarding-status.ts'
import { pointRoutingAtVault, storeProviderKey } from './provider-api-key.ts'
import { defaultRedactor } from './redaction.ts'
import type { SecretsVault } from './secrets-vault.ts'

// `testProviderKey` and `storeProviderKey` moved to `provider-api-key.ts`
// (issue #47, keeping BYOK key mechanics next to the new Model connections
// code that generalizes them); re-exported here so every existing caller
// (`onboarding-routes.ts`, `import-apply.ts`, server and onboarding tests)
// keeps importing from this module unchanged.
export { storeProviderKey, testProviderKey } from './provider-api-key.ts'

export interface ByokDeps {
  rootDir: string
  vault: SecretsVault | undefined
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
    pointRoutingAtVault(deps.rootDir, provider, provider)
  }

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, byok: 'completed' },
  })
}
