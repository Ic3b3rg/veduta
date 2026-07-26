import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'

/**
 * `POST /api/onboarding/migration` (`tasks/plan.md` §4): an honest deferral,
 * not a fake import. Recording `migrate-later` runs nothing — it only
 * persists the choice so the (future, issue 020) legacy-agent importer can
 * pick it up on its own terms. `manual` records that the user chose to set
 * things up from scratch instead. Neither branch ever prints or implies a
 * command that would actually perform a migration; that command does not
 * exist yet. Idempotent: re-recording the same (or a different) choice
 * simply overwrites the marker and re-marks the step completed.
 */
export function applyMigrationChoice(rootDir: string, choice: 'migrate-later' | 'manual'): void {
  const config = loadOnboardingConfig(rootDir)
  saveOnboardingConfig(rootDir, {
    ...config,
    migrationChoice: choice,
    steps: { ...config.steps, migration: 'completed' },
  })
}
