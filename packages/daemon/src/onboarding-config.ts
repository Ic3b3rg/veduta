import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'

/**
 * Onboarding wizard state (issue #19 AC2): `<rootDir>/onboarding.json` is
 * the authoritative, resumable record of the post-pairing setup wizard.
 * The installer may seed this file with a `legacy` detection result before
 * the daemon's first boot (installer legacy-detect stage); the
 * daemon itself never fabricates that field. Every step's `status` is
 * written to this file only AFTER that step's side effects have already
 * happened (vault write, routing/ingestion config write, Space creation):
 * a crash between the side effect and the status write leaves the step
 * `pending`, and re-applying it is idempotent by design (same vault value,
 * same config content, Space reconciled by slug) — so resuming after a
 * crash never re-does work observably or loses it. A corrupted file is
 * never silently discarded; `loadOnboardingConfig` throws instead of
 * resetting, so a hand-edited or truncated file surfaces as a clear error
 * rather than quietly restarting the wizard from scratch.
 */
export const ONBOARDING_FILE_NAME = 'onboarding.json'

const OnboardingStepIdSchema = z.enum([
  'migration',
  'domain',
  'byok',
  'models',
  'first-space',
  'integrations',
  'finish',
])

const OnboardingStepStatusSchema = z.enum(['pending', 'completed', 'skipped'])

export const OnboardingConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    steps: z.record(OnboardingStepIdSchema, OnboardingStepStatusSchema).default({}),
    migrationChoice: z.enum(['migrate-later', 'manual', 'imported']).optional(),
    legacy: z
      .object({
        openclaw: z.boolean(),
        hermes: z.boolean(),
        sourceHome: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    firstSpace: z
      .object({
        name: z.string(),
        slug: z.string(),
        /** The daemon's own `spc-<slug>` id, so callers never re-derive it (issue #19 code review fix). Optional for backward compat with a file written before this field existed. */
        spaceId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    completedAt: z.string().optional(),
  })
  .strict()

export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>

function onboardingPath(rootDir: string): string {
  return join(rootDir, ONBOARDING_FILE_NAME)
}

/** Absent file → freshly-started wizard (`OnboardingConfigSchema.parse({})`). */
export function loadOnboardingConfig(rootDir: string): OnboardingConfig {
  const path = onboardingPath(rootDir)
  if (!existsSync(path)) return OnboardingConfigSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `invalid JSON in onboarding config ${path}: ${error instanceof Error ? error.message : String(error)} — refusing to silently reset resumable wizard state`,
    )
  }
  return OnboardingConfigSchema.parse(raw)
}

/**
 * Validates `config`, backs up the existing `onboarding.json` (if any), then
 * writes the new state atomically. Callers apply side effects first and
 * call this last ("status is always written after side
 * effects").
 */
export function saveOnboardingConfig(rootDir: string, config: OnboardingConfig): void {
  const validated = OnboardingConfigSchema.parse(config)
  const path = onboardingPath(rootDir)
  backupFile(path)
  writeJsonAtomic(path, validated)
}
