import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImportSourceKindSchema, type ImportSourceKind } from '@veduta/protocol'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'

/**
 * The import marker: `<rootDir>/import.json`
 * is apply's own record of every completed import, mirroring
 * `onboarding-config.ts`'s discipline exactly (strict schema, absent file →
 * empty state, corrupt file → throw rather than silently reset). This is
 * the file `buildImportPlan`'s `alreadyImported` conflict check reads
 * (issue AC2 "conflicts refuse, never skip"): a second apply
 * of the same source without `--overwrite` must name the previous run and
 * its date instead of quietly repeating it. It is written LAST inside
 * apply's lock — a crash before this write leaves per-item
 * conflicts (SOUL/USER/`imported` Space already there) that make the retry
 * refuse with an actionable message on their own, which is why this marker
 * never needs a "partial import" state of its own.
 */
export const IMPORT_STATE_FILE = 'import.json'

const ImportStateEntrySchema = z
  .object({
    source: ImportSourceKindSchema,
    sourceDir: z.string().min(1),
    at: z.string().datetime(),
    spaceId: z.string().min(1).optional(),
    factsWritten: z.number().int().nonnegative(),
    eventsAppended: z.number().int().nonnegative(),
  })
  .strict()

export const ImportStateSchema = z
  .object({
    version: z.literal(1).default(1),
    imports: z.array(ImportStateEntrySchema).default([]),
  })
  .strict()

export type ImportStateEntry = z.infer<typeof ImportStateEntrySchema>
export type ImportState = z.infer<typeof ImportStateSchema>

function importStatePath(rootDir: string): string {
  return join(rootDir, IMPORT_STATE_FILE)
}

/**
 * Absent file → freshly-started state (`ImportStateSchema.parse({})`),
 * matching `loadOnboardingConfig`'s convention exactly. A corrupted file is
 * never silently discarded: a hand-edited or truncated `import.json` throws
 * a clear error instead of quietly reporting "never imported before", which
 * would let a second apply silently re-run over a completed import.
 */
export function loadImportState(rootDir: string): ImportState {
  const path = importStatePath(rootDir)
  if (!existsSync(path)) return ImportStateSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `invalid JSON in import state ${path}: ${error instanceof Error ? error.message : String(error)} — refusing to silently reset the import record`,
    )
  }
  return ImportStateSchema.parse(raw)
}

/**
 * Validates `state`, backs up the existing `import.json` (if any), then
 * writes the new state atomically — the same backup-then-write discipline
 * `saveOnboardingConfig` uses. Called once, last, inside apply's lock
 * (`import-apply.ts` step 10): every side effect of the run
 * has already happened by the time this is called.
 */
export function saveImportState(rootDir: string, state: ImportState): void {
  const validated = ImportStateSchema.parse(state)
  const path = importStatePath(rootDir)
  backupFile(path)
  writeJsonAtomic(path, validated)
}

/**
 * The most recent completed import of `source`, or `undefined` when none
 * exists — what `buildImportPlan` needs for its `alreadyImported` conflict
 * check and what `applyImport` needs to decide whether this
 * run is a first import or a `--overwrite` re-run. "Most recent" is decided
 * by `at` (ISO-8601, so a plain string comparison is also a chronological
 * one) rather than array order, so a hand-reordered or merged `import.json`
 * still resolves correctly.
 */
export function findImport(
  state: ImportState,
  source: ImportSourceKind,
): ImportStateEntry | undefined {
  return state.imports
    .filter((entry) => entry.source === source)
    .reduce<ImportStateEntry | undefined>((latest, entry) => {
      if (latest === undefined || entry.at > latest.at) return entry
      return latest
    }, undefined)
}
