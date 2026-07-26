import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'

/**
 * `POST /api/onboarding/domain` (`tasks/plan.md` §4): read-mostly — this
 * step confirms the domain/TLS state the daemon already detected at boot
 * (`server.ts`), it never accepts or writes a domain value. Changing the
 * public domain is a systemd drop-in edit (out of band); this step just
 * records that the operator has seen and confirmed the current value.
 * Idempotent: re-confirming is a no-op beyond re-writing the same status.
 */
export function confirmDomain(rootDir: string): void {
  const config = loadOnboardingConfig(rootDir)
  saveOnboardingConfig(rootDir, {
    ...config,
    steps: { ...config.steps, domain: 'completed' },
  })
}
