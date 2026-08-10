import type { ModelConnectionStepRequest } from '@veduta/protocol'
import type { ConnectionsFile } from './connections-config.ts'
import { loadConnectionsConfig, saveConnectionsConfig } from './connections-config.ts'
import { deriveRoutingConfig } from './model-connection-routing.ts'
import { loadRoutingConfig, secretRefForTierModel, type SecretResolver } from './model-routing.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'

/**
 * The `model-connection` onboarding step (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment) replacing
 * the old `byok` and `models` steps: one step now covers connecting a Model
 * connection AND picking a model. Every connect/authorize/verify/select
 * action itself happens through `/api/model-connections/*`
 * (`model-connection-routes.ts`) — this module only decides whether the
 * step (or `applyFinish`) may consider the wizard's Model connection
 * requirement satisfied.
 */
export interface ModelConnectionReadyDeps {
  rootDir: string
  profile: 'loopback' | 'local-vps' | 'vps'
  secrets: SecretResolver
}

/**
 * Whether an "effective selection" exists. Two disjoint cases, never
 * falling from the first into the second:
 *
 * - `file.selection !== undefined`: the user went through the Model
 *   connections wizard step and made an explicit choice — readiness is
 *   whatever `deriveRoutingConfig` (`model-connection-routing.ts`, the SAME
 *   derivation live routing actually uses) resolves the reasoning tier to.
 *   A selection whose active connection failed and has no opted-in fallback
 *   derives an EMPTY tier, which must block here exactly as it would block a
 *   real chat turn — falling through to the legacy `routing.json` check
 *   below would let a stale, pre-selection provider key paper over a
 *   selection the user can see is broken.
 * - `file.selection === undefined`: an install that never went through the
 *   Model connections wizard step at all (a legacy BYOK install migrated at
 *   boot, `docs/adr/0014-…`'s migration deliberately never sets a
 *   selection) — the head of `routing.json`'s reasoning tier resolving a
 *   real key through `providerKeys`/`connectionKeys` means a chat turn
 *   actually has somewhere to route to.
 */
function hasEffectiveSelection(
  rootDir: string,
  secrets: SecretResolver,
  file: ConnectionsFile,
): boolean {
  const routing = loadRoutingConfig(rootDir)
  if (file.selection !== undefined) {
    return deriveRoutingConfig(routing, file).tiers.reasoning.length > 0
  }

  const head = routing.tiers.reasoning[0]
  if (!head) return false
  const secretRef = secretRefForTierModel(head, routing)
  if (secretRef === undefined) return false
  return secrets.resolve(secretRef) !== undefined
}

/**
 * The VPS gate, derived from real state and never retroactive (ADR-0014
 * amendment): `loopback` always passes (the mock provider is
 * automatic there); `local-vps` passes when the explicit development mock
 * control is on, or when a connected connection has an effective selection;
 * `vps` requires the latter — there is no mock control on a real VPS.
 * Called by both `applyModelConnectionStep` (below) and
 * `onboarding-step-finish.ts`'s `applyFinish`, so the wizard step and the
 * finish-step completion gate can never disagree about what "ready" means.
 */
export function assertModelConnectionReady(deps: ModelConnectionReadyDeps): void {
  if (deps.profile === 'loopback') return

  const file = loadConnectionsConfig(deps.rootDir)
  if (deps.profile === 'local-vps' && file.mockEnabled) return
  if (hasEffectiveSelection(deps.rootDir, deps.secrets, file)) return

  throw new OnboardingStepError(
    'connect a Model connection and select a model before continuing',
    409,
  )
}

/**
 * `POST /api/onboarding/model-connection` (issue #47). Side effects first:
 * an explicit `useMock` request turns the Local VPS development mock
 * control on (409 on `vps`, a no-op on `loopback` since the mock is already
 * automatic there) BEFORE the readiness gate runs, so a request that both
 * enables the mock and completes the step either does both or neither.
 * Marks the step `completed` only once `assertModelConnectionReady` passes.
 */
export function applyModelConnectionStep(
  deps: ModelConnectionReadyDeps,
  request: ModelConnectionStepRequest,
): void {
  if (request.useMock) {
    if (deps.profile === 'vps') {
      throw new OnboardingStepError(
        'the development mock control is available only on the Local VPS profile',
        409,
      )
    }
    if (deps.profile === 'local-vps') {
      const file = loadConnectionsConfig(deps.rootDir)
      saveConnectionsConfig(deps.rootDir, { ...file, mockEnabled: true })
    }
    // loopback: no-op — the mock provider is already automatic there.
  }

  assertModelConnectionReady(deps)

  const config = loadOnboardingConfig(deps.rootDir)
  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, 'model-connection': 'completed' },
  })
}
