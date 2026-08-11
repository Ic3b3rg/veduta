import type { FinishResponse } from '@veduta/protocol'
import type { SecretResolver } from './model-routing.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { assertModelConnectionReady } from './onboarding-step-model-connection.ts'
import {
  OnboardingStepError,
  resolveLegacy,
  visibleOnboardingStepIds,
} from './onboarding-status.ts'

export interface FinishDeps {
  rootDir: string
  profile: 'loopback' | 'local-vps' | 'vps'
  /** Injectable so tests can assert it fires without actually killing the process. */
  scheduleExit: () => void
  /** Feeds the same legacy-visibility resolution `buildOnboardingStatus` uses, so the completion gate below checks exactly the steps the wizard actually showed. */
  env: NodeJS.ProcessEnv
  /** Fed to `assertModelConnectionReady` (issue #47), the last check before completion — the same gate `applyModelConnectionStep` itself enforces, so finishing can never bypass it. */
  secrets: SecretResolver
  homeDir?: string
  now?: () => Date
}

/**
 * `POST /api/onboarding/finish` (§4): marks the wizard
 * `completed` and persists `completedAt` FIRST — durable before the process
 * might die — then, only on the VPS and Local VPS profiles, schedules the
 * graceful exit so the profile's supervisor (systemd on the VPS, the Local
 * VPS runner loop, issue 023) restarts the daemon with the now-current
 * boot-time-immutable routing/vault/ingestion config. Loopback never exits:
 * the response still carries `restartRequired: true` so the wizard can
 * honestly say the new config takes effect on the next daemon start.
 * Idempotent: re-applying after completion just re-saves the same
 * `completed` status (with a fresh `completedAt`) and, on the VPS/Local VPS
 * profiles, schedules the exit again.
 *
 * The completion gate refuses to finish before every other visible
 * step (`onboarding-status.ts`'s own migration-visibility rule, reused so
 * this never drifts from what the wizard actually showed) is `completed` or
 * `skipped` throws a clear `OnboardingStepError` naming the first missing
 * step, mapped by the route to 409 — a client that skips straight to finish
 * (or races two tabs) can never silently mark the wizard done with a step
 * still dangling.
 */
export function applyFinish(deps: FinishDeps): FinishResponse {
  const now = deps.now ?? (() => new Date())
  const config = loadOnboardingConfig(deps.rootDir)

  const legacy = resolveLegacy(deps.rootDir, deps.env, deps.homeDir)
  const missingStep = visibleOnboardingStepIds(legacy)
    .filter((id) => id !== 'finish')
    .find((id) => {
      const status = config.steps[id] ?? 'pending'
      return status !== 'completed' && status !== 'skipped'
    })
  if (missingStep) {
    throw new OnboardingStepError(
      `complete the "${missingStep}" step before finishing onboarding`,
      409,
    )
  }

  // The last check before completing (issue #47, ADR-0014 amendment): a
  // status only every OTHER step already being `completed`/`skipped` cannot
  // catch by itself — a hand-edited `onboarding.json` could mark
  // `model-connection` completed and then have its only connection revoked
  // out from under it. This is the exact same gate
  // `applyModelConnectionStep` enforces, so finishing can never bypass it.
  assertModelConnectionReady({
    rootDir: deps.rootDir,
    profile: deps.profile,
    secrets: deps.secrets,
  })

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, finish: 'completed' },
    completedAt: now().toISOString(),
  })

  if (deps.profile === 'vps' || deps.profile === 'local-vps') {
    deps.scheduleExit()
    return { restartRequired: true, restarting: true }
  }
  return { restartRequired: true, restarting: false }
}
