import type { OnboardingTiers } from '@veduta/protocol'
import { loadRoutingConfig, saveRoutingConfig } from './model-routing.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'

/**
 * `POST /api/onboarding/models` (`tasks/plan.md` §4): replaces
 * `routing.json`'s `tiers`, preserving `providerKeys`/`dailyCapUsd` as they
 * are. `saveRoutingConfig` validates the merged config against
 * `RoutingConfigSchema` before writing, so an invalid tier list never lands
 * on disk. Side effect (routing write) happens before the step is marked
 * completed. Idempotent: re-applying the same tiers is a no-op beyond
 * re-writing the same content.
 */
export function applyModels(rootDir: string, tiers: OnboardingTiers): void {
  const routing = loadRoutingConfig(rootDir)
  saveRoutingConfig(rootDir, { ...routing, tiers })

  const config = loadOnboardingConfig(rootDir)
  saveOnboardingConfig(rootDir, {
    ...config,
    steps: { ...config.steps, models: 'completed' },
  })
}
