import { join, resolve, sep } from 'node:path'
import type { ImportItem, ImportOptions, ImportPlan, ImportSourceKind } from '@veduta/protocol'
import { ImportPlanSchema } from '@veduta/protocol'
import { isNeverArchived } from './import-archive.ts'
import {
  IMPORT_TARGETS,
  IMPORTED_SPACE_NAME,
  MAX_IMPORTED_FACTS,
  adaptSoul,
  extractMemoryEntries,
  readTargetState,
  sourceLabel,
  type TargetState,
} from './import-mapping.ts'
import type { SecretScan } from './import-secrets.ts'
import { MAX_NOTES, type LegacySourceSnapshot } from './import-source.ts'
import { findImport, loadImportState } from './import-state.ts'

/** What plan and apply must agree on for one run (`tasks/plan.md` decision 7: option parity). */
export interface BuildImportPlanInput {
  snapshot: LegacySourceSnapshot
  secrets: SecretScan
  target: TargetState
  options: { overwrite: boolean; secrets: boolean }
  /** Populated from `<root>/import.json` (decision 8's import marker) when this source was imported before. */
  alreadyImported?: { source: ImportSourceKind; at: string }
  /** Vault key material present — no key, no backup, no mutation (decision 8/10). */
  backupAvailable: boolean
}

const IDENTITY_BASENAMES = new Set(['SOUL.md', 'USER.md', 'MEMORY.md'])

function basenameOf(relPath: string): string {
  return relPath.split(/[\\/]/).pop() ?? relPath
}

/** Why a SOUL.md/USER.md slot has nothing to import — refused, oversize, or genuinely absent. */
function sourceSlotAbsentReason(
  snapshot: LegacySourceSnapshot,
  basename: 'SOUL.md' | 'USER.md',
): string {
  if (snapshot.refused.some((p) => basenameOf(p) === basename)) {
    return `${basename} was refused (symlink or not a regular file) and could not be read`
  }
  if (snapshot.oversize.some((p) => basenameOf(p) === basename)) {
    return `${basename} exceeds the size limit and could not be read`
  }
  return `${basename} is not present in the source install`
}

/** `<rootDir>/import-source/<kind>` — where the installer stages a detected legacy install (`tasks/plan.md` decision 16). */
function stagedSourceDir(rootDir: string, kind: ImportSourceKind): string {
  return join(rootDir, 'import-source', kind)
}

/**
 * True when the resolved source and target directories are the same path,
 * or one contains the other (`tasks/plan.md` decision 8/14): importing from
 * or into the daemon's own data directory could read or write things well
 * outside this issue's scope. Uses `resolve`, never `realpathSync` — this
 * module does no I/O, and `snapshot.dir`/`target.rootDir` are already
 * resolved by their respective readers.
 *
 * A1: exempts exactly the canonical staged path,
 * `<rootDir>/import-source/<kind>` — the installer stages a legacy install
 * *inside* the daemon's own data directory by design (`tasks/plan.md`
 * decision 16), so this is the one, and only the one, source/target overlap
 * that must never refuse. Every other overlap (the source pointed straight
 * at the data directory, or a parent/child relationship that is not this
 * exact staged path) still refuses.
 */
function pathsOverlap(snapshot: LegacySourceSnapshot, target: TargetState): boolean {
  const ra = resolve(snapshot.dir)
  const rb = resolve(target.rootDir)
  if (ra === resolve(stagedSourceDir(target.rootDir, snapshot.kind))) return false
  if (ra === rb) return true
  return ra.startsWith(rb + sep) || rb.startsWith(ra + sep)
}

/** The pieces of a plan one concern (SOUL, USER, the `Imported` Space, secrets) contributes — concatenated by `buildImportPlan` into the final `ImportPlan`. */
interface PlanFragment {
  items: ImportItem[]
  warnings: string[]
  blocked: string[]
  requiresOverwrite: boolean
}

interface SoulPlanResult extends PlanFragment {
  /** The full adapted text, present only on the branch that writes `SOUL.md` — see `ImportPlanSchema.soulPreview`'s doc comment. */
  soulPreview: string | undefined
}

/**
 * `SOUL.md`'s plan item (`tasks/plan.md` decision 3/8): `skip` when the
 * source has none, a `blocked` refusal (no item) on a conflict
 * `--overwrite` was not given for, or an `import`/`overwrite` item carrying
 * the read-me-first warning and the adapted preview text.
 */
function planSoulItem(
  snapshot: LegacySourceSnapshot,
  target: TargetState,
  options: { overwrite: boolean },
): SoulPlanResult {
  const items: ImportItem[] = []
  const warnings: string[] = []
  const blocked: string[] = []
  let soulPreview: string | undefined

  const soulConflict = snapshot.soul !== undefined && target.soulExists && !target.soulIsDefault

  if (snapshot.soul === undefined) {
    items.push({
      action: 'skip',
      target: IMPORT_TARGETS.soul,
      detail: 'no SOUL.md found to import',
      reason: sourceSlotAbsentReason(snapshot, 'SOUL.md'),
    })
  } else if (soulConflict && !options.overwrite) {
    blocked.push(
      'SOUL.md already exists and differs from the default template; read the imported ' +
        'personality in full, then re-run with --overwrite to replace it.',
    )
  } else {
    const action = soulConflict ? 'overwrite' : 'import'
    items.push({
      action,
      target: IMPORT_TARGETS.soul,
      detail:
        `${action === 'overwrite' ? 'replaces' : 'writes'} SOUL.md with the adapted ` +
        `${sourceLabel(snapshot.kind)} personality (${snapshot.soul.bytes} bytes)`,
    })
    warnings.push(
      'SOUL.md will be written: read the adapted personality in full before applying — it directly shapes the Agent.',
    )
    // The mitigation itself (`tasks/plan.md` decision 3): the exact text that
    // will be written, computed with the same call `import-apply.ts` makes
    // (`adaptSoul(snapshot.soul.text, snapshot.kind)`), never a reformatted
    // copy, so preview and apply cannot silently diverge.
    soulPreview = adaptSoul(snapshot.soul.text, snapshot.kind)
  }

  return { items, warnings, blocked, requiresOverwrite: soulConflict, soulPreview }
}

/**
 * `USER.md`'s plan item (`tasks/plan.md` decision 2/8): `skip` when the
 * source has none, a `blocked` refusal (no item) on a conflict
 * `--overwrite` was not given for, or an `import`/`overwrite` item.
 */
function planUserItem(
  snapshot: LegacySourceSnapshot,
  target: TargetState,
  options: { overwrite: boolean },
): PlanFragment {
  const items: ImportItem[] = []
  const blocked: string[] = []
  const userConflict = snapshot.user !== undefined && target.userHasContent

  if (snapshot.user === undefined) {
    items.push({
      action: 'skip',
      target: IMPORT_TARGETS.user,
      detail: 'no USER.md found to import',
      reason: sourceSlotAbsentReason(snapshot, 'USER.md'),
    })
  } else if (userConflict && !options.overwrite) {
    blocked.push(
      'USER.md already has content beyond its heading; re-run with --overwrite to replace it ' +
        'with the imported, delimited profile.',
    )
  } else {
    const action = userConflict ? 'overwrite' : 'import'
    items.push({
      action,
      target: IMPORT_TARGETS.user,
      detail:
        `${action === 'overwrite' ? 'replaces' : 'writes'} USER.md with the delimited ` +
        `${sourceLabel(snapshot.kind)} profile (${snapshot.user.bytes} bytes)`,
    })
  }

  return { items, warnings: [], blocked, requiresOverwrite: userConflict }
}

/**
 * The `Imported` Space's FACTS + Event log items (`tasks/plan.md` decision
 * 18): the imported memory entries, budget-capped at `MAX_IMPORTED_FACTS`
 * with the overflow going to the Event log alongside the daily notes. Both
 * items refuse together on the same `imported`-Space conflict (`blocked`,
 * no items) when `--overwrite` was not given.
 */
function planSpaceItems(
  snapshot: LegacySourceSnapshot,
  target: TargetState,
  options: { overwrite: boolean },
): PlanFragment {
  const items: ImportItem[] = []
  const warnings: string[] = []
  const blocked: string[] = []

  const memoryEntries = extractMemoryEntries(snapshot.memory?.text ?? '')
  const factsCount = Math.min(memoryEntries.length, MAX_IMPORTED_FACTS)
  const overflowCount = memoryEntries.length - factsCount
  const eventsCount = overflowCount + snapshot.notes.length
  const spaceConflict = target.importedSpaceExists
  const hasSpaceContent = memoryEntries.length > 0 || snapshot.notes.length > 0
  const spaceBlocked = spaceConflict && hasSpaceContent && !options.overwrite
  if (spaceBlocked) {
    blocked.push(
      `The "${IMPORTED_SPACE_NAME}" Space already exists; re-run with --overwrite to append the ` +
        'imported facts and Event log entries to it.',
    )
  }

  if (memoryEntries.length === 0) {
    items.push({
      action: 'skip',
      target: IMPORT_TARGETS.facts,
      detail: 'no memory entries found to import',
      reason: 'no memory entries found in the source',
      count: 0,
    })
  } else if (!spaceBlocked) {
    items.push({
      action: spaceConflict ? 'overwrite' : 'import',
      target: IMPORT_TARGETS.facts,
      detail:
        `${factsCount} imported memory ${factsCount === 1 ? 'entry becomes' : 'entries become'} ` +
        `untrusted facts in "${IMPORTED_SPACE_NAME}" (from ${sourceLabel(snapshot.kind)})`,
      count: factsCount,
    })
    warnings.push(
      'Imported memory is stored as untrusted content and will keep gating outbound actions.',
    )
  }

  if (overflowCount > 0) {
    warnings.push(
      `${memoryEntries.length} memory entries were found; only the first ${MAX_IMPORTED_FACTS} ` +
        `became FACTS — the remaining ${overflowCount} were appended to the Event log instead.`,
    )
  }

  if (eventsCount === 0) {
    items.push({
      action: 'skip',
      target: IMPORT_TARGETS.log,
      detail: 'nothing to append to the Event log',
      reason: 'no notes or overflow memory entries found in the source',
      count: 0,
    })
  } else if (!spaceBlocked) {
    items.push({
      action: spaceConflict ? 'overwrite' : 'import',
      target: IMPORT_TARGETS.log,
      detail:
        `${eventsCount} Event log entries in "${IMPORTED_SPACE_NAME}" (${snapshot.notes.length} ` +
        `note(s), ${overflowCount} overflow fact(s) from ${sourceLabel(snapshot.kind)})`,
      count: eventsCount,
    })
  }

  return { items, warnings, blocked, requiresOverwrite: spaceConflict && hasSpaceContent }
}

/**
 * One item per allowlisted secret found in the source (`tasks/plan.md`
 * decision 12): `import` names the vault target and routing pointer once
 * `--secrets` is given, `skip` reports the key name and that `--secrets` is
 * needed — never a value either way. Never blocks and never sets
 * `requiresOverwrite`: a secret the user didn't ask to import is simply
 * skipped, not refused.
 */
function planSecretItems(secrets: SecretScan, options: { secrets: boolean }): ImportItem[] {
  return secrets.importable.map((secret) =>
    options.secrets
      ? {
          action: 'import',
          target: IMPORT_TARGETS.vault(secret.vaultName),
          detail: `${secret.sourceKey} (${secret.sourceFile}) → vault ${secret.vaultName}, routing pointed at it`,
        }
      : {
          action: 'skip',
          target: IMPORT_TARGETS.vault(secret.vaultName),
          detail: `${secret.sourceKey} found in ${secret.sourceFile}`,
          reason: 'secret, needs --secrets',
        },
  )
}

/**
 * Builds the dry-run `ImportPlan` (`tasks/plan.md` T4): the same function
 * preview and apply both call, on the same options (decision 7), so the
 * preview always describes exactly the run apply performs. Parses its own
 * output through `ImportPlanSchema` before returning, so a shape bug is
 * caught here rather than at the HTTP boundary.
 *
 * Blocking (decision 8, issue AC2 — "conflicts refuse, never skip"):
 * - a prior import of this source without `--overwrite` (clearable);
 * - SOUL/USER/MEMORY oversize in the source (never clearable — a truncated
 *   identity or profile is a silent semantic change);
 * - no vault key material, so no backup, so nothing will be written (never
 *   clearable);
 * - a source/target directory overlap (never clearable);
 * - SOUL differs from the default template, USER has content beyond its
 *   heading, or the `imported` Space already exists — each clearable by
 *   `--overwrite`, at which point it becomes a listed `overwrite` item
 *   instead of a `blocked` entry.
 */
export function buildImportPlan(input: BuildImportPlanInput): ImportPlan {
  const { snapshot, secrets, target, options, alreadyImported, backupAvailable } = input
  const items: ImportItem[] = []
  const warnings: string[] = []
  const blocked: string[] = []
  let requiresOverwrite = false

  if (alreadyImported !== undefined) {
    requiresOverwrite = true
    if (!options.overwrite) {
      blocked.push(
        `${sourceLabel(alreadyImported.source)} was already imported on ${alreadyImported.at}; ` +
          're-run with --overwrite to import again after taking a fresh backup.',
      )
    }
  }

  if (!backupAvailable) {
    blocked.push(
      'No backup can be taken: no vault key material is available, so nothing will be written. ' +
        'Provision a vault keyfile first, then retry.',
    )
  }

  // A13, `tasks/plan.md` decision 14: "the target must be an existing
  // directory and never '/'" — never clearable by --overwrite.
  if (resolve(target.rootDir) === resolve('/')) {
    blocked.push('the target data directory cannot be "/"; refusing to import.')
  }
  if (!target.rootIsDirectory) {
    blocked.push(
      `the target data directory (${target.rootDir}) does not exist or is not a directory; refusing to import.`,
    )
  }

  if (pathsOverlap(snapshot, target)) {
    blocked.push(
      `The source directory (${snapshot.dir}) and the target data directory (${target.rootDir}) overlap; refusing to import.`,
    )
  }

  for (const relPath of snapshot.oversize) {
    if (IDENTITY_BASENAMES.has(basenameOf(relPath))) {
      blocked.push(
        `${relPath} in the source exceeds the size limit; importing a truncated identity or ` +
          'profile would be a silent semantic change, so this cannot be cleared with --overwrite.',
      )
    } else {
      warnings.push(`${relPath} exceeded the size limit and was not imported.`)
    }
  }

  for (const relPath of snapshot.refused) {
    warnings.push(`${relPath} was refused (symlink or not a regular file) and was not imported.`)
  }

  if (snapshot.notes.length >= MAX_NOTES) {
    warnings.push(
      `The source's memory notes hit the ${MAX_NOTES}-file cap; some may not have been imported — see NOTES.md.`,
    )
  }

  // One fragment per concern (SOUL, USER, the `Imported` Space, secrets —
  // each documented on its own planner above), concatenated in the same
  // order the plan used to build them in by hand.
  const soul = planSoulItem(snapshot, target, options)
  const user = planUserItem(snapshot, target, options)
  const space = planSpaceItems(snapshot, target, options)
  const secretItems = planSecretItems(secrets, options)

  items.push(...soul.items, ...user.items, ...space.items, ...secretItems)
  warnings.push(...soul.warnings, ...space.warnings)
  blocked.push(...soul.blocked, ...user.blocked, ...space.blocked)
  requiresOverwrite =
    requiresOverwrite || soul.requiresOverwrite || user.requiresOverwrite || space.requiresOverwrite
  const soulPreview = soul.soulPreview

  // A17: this count is a candidate count only, not a promise. The archive
  // walk (`import-archive.ts`) applies caps and filters (200 files, 1 MiB
  // each, text-only extensions, mapped-elsewhere exclusion, the
  // credential-name-pattern guard) this module has no way to reproduce
  // without duplicating the walk — the two disagreeing was exactly the bug.
  // No `count` field here: `ImportResult`'s real, post-apply archive/skip
  // list is what NOTES.md renders (`import-archive.ts`'s `buildNotesMarkdown`).
  const archivable = snapshot.notMigrated.filter((relPath) => !isNeverArchived(relPath))
  items.push(
    archivable.length > 0
      ? {
          action: 'import',
          target: IMPORT_TARGETS.archive,
          detail:
            `up to ${archivable.length} candidate file(s) may be archived (redacted text only) — ` +
            'the exact count depends on caps applied at apply time; see NOTES.md for what was actually archived',
        }
      : {
          action: 'skip',
          target: IMPORT_TARGETS.archive,
          detail: 'nothing to archive',
          reason: 'no archivable candidate files found in the source',
        },
  )

  const notMigrated = [
    ...snapshot.notMigrated,
    ...secrets.notImportable.map(
      (entry) => `${entry.sourceKey} (${entry.sourceFile}) — not importable, recreate by hand`,
    ),
    ...secrets.unsupported,
  ]

  return ImportPlanSchema.parse({
    source: snapshot.kind,
    sourceDir: snapshot.dir,
    options,
    items,
    warnings,
    notMigrated,
    blocked,
    requiresOverwrite,
    ...(alreadyImported === undefined ? {} : { alreadyImported }),
    ...(soulPreview === undefined ? {} : { soulPreview }),
  })
}

/** What `planLegacyImport` needs beyond the request options: the resolved target root and the (already-read) source/secret scan. */
export interface PlanLegacyImportInput {
  rootDir: string
  snapshot: LegacySourceSnapshot
  secrets: SecretScan
  options: ImportOptions
  backupAvailable: boolean
}

/**
 * The `readTargetState` + "was this source already imported" + `buildImportPlan`
 * composition (A2, `tasks/plan.md` decision 7). Exported so every call site
 * that needs "what would a run of this source look like right now" —
 * preview endpoints/the CLI's dry-run print, and `applyImportLocked`
 * (`import-apply.ts`) itself — shares exactly one implementation, instead of
 * each reassembling `readTargetState`/`loadImportState`/`findImport`/
 * `buildImportPlan` by hand. `applyImportLocked` calls this again **inside
 * its lock**, rather than trusting a plan built earlier outside it: that is
 * what makes two concurrent applies of the same source unable to both
 * observe "not previously imported" (the bug A2 closes — recomputing the
 * plan inside the lock is exactly what `tasks/plan.md`'s reconciliation item
 * 2 says apply already did, which it did not). A caller that only wants a
 * preview (no lock, no mutation) calls this directly; `readTargetState` and
 * `loadImportState` are both plain `fs` reads, so calling this function
 * itself never writes anything.
 */
export function planLegacyImport(input: PlanLegacyImportInput): ImportPlan {
  const target = readTargetState(input.rootDir)
  const alreadyImported = findImport(loadImportState(input.rootDir), input.snapshot.kind)
  return buildImportPlan({
    snapshot: input.snapshot,
    secrets: input.secrets,
    target,
    options: input.options,
    backupAvailable: input.backupAvailable,
    ...(alreadyImported === undefined ? {} : { alreadyImported }),
  })
}
