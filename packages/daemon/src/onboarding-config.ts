import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OnboardingStepIdSchema } from '@veduta/protocol'
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

// The step enum comes from the protocol (issue #47) rather than a second,
// independently-maintained copy: a new step id only ever needs adding in
// `@veduta/protocol`'s `OnboardingStepIdSchema`, and this schema picks it up
// automatically.
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

/**
 * Rewrites a legacy `onboarding.json`'s `byok`/`models` step entries onto
 * `model-connection` (issue #47, `docs/adr/0014-subscription-inference-boundary.md`
 * amendment) before the file ever reaches `OnboardingConfigSchema.parse` —
 * that schema's step enum comes straight from the protocol, so a file still
 * carrying either legacy key would otherwise throw and strand the wizard.
 * The rule:
 *
 * - `model-connection` becomes `'completed'` when `steps.byok === 'completed'`,
 *   or `'skipped'` when `steps.byok === 'skipped'` — a legacy install that
 *   had a working key (or explicitly deferred one) is not asked to redo that
 *   choice.
 * - Otherwise `model-connection` is left absent (the same as `'pending'`,
 *   `onboarding-status.ts`'s own default for a missing step).
 * - `steps.models` is dropped outright: the tier assignments it used to write
 *   live in `routing.json`, untouched by this migration.
 * - An existing `steps['model-connection']` always wins over anything this
 *   function would otherwise compute.
 * - Both legacy keys are deleted from the returned `steps`, so the very next
 *   `saveOnboardingConfig` call writes a clean file with no legacy leftover.
 *
 * Anything not shaped like `{ steps: {...} }` — including a raw value that
 * will fail `OnboardingConfigSchema.parse` anyway — passes through
 * unchanged; this function only ever migrates, never validates.
 */
export function migrateLegacyStepIds(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const steps = record['steps']
  if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) return raw

  const stepsRecord = steps as Record<string, unknown>
  if (!('byok' in stepsRecord) && !('models' in stepsRecord)) return raw

  const { byok, models: _droppedModels, ...rest } = stepsRecord
  const migratedSteps: Record<string, unknown> = { ...rest }
  if (!('model-connection' in stepsRecord)) {
    if (byok === 'completed') migratedSteps['model-connection'] = 'completed'
    else if (byok === 'skipped') migratedSteps['model-connection'] = 'skipped'
  }

  return { ...record, steps: migratedSteps }
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
  return OnboardingConfigSchema.parse(migrateLegacyStepIds(raw))
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
