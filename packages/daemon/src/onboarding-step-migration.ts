import { rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ImportApplyRequest,
  ImportPlan,
  ImportPreviewRequest,
  ImportResult,
  ImportSourceKind,
} from '@veduta/protocol'
import { applyImport } from './import-apply.ts'
import { sourceLabel } from './import-mapping.ts'
import { planLegacyImport } from './import-plan.ts'
import { buildImportCommand } from './import-preview-text.ts'
import { scanLegacySecrets, type SecretScan } from './import-secrets.ts'
import {
  ImportSourceMissingError,
  readLegacySource,
  resolveLegacyDir,
  type LegacySourceSnapshot,
} from './import-source.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError, resolveLegacy } from './onboarding-status.ts'
import type { SecretsVault } from './secrets-vault.ts'

/**
 * `POST /api/onboarding/migration` (`tasks/plan.md` "Wire API"): an honest
 * deferral, not a fake import. Recording `migrate-later` runs nothing — it
 * only persists the choice so `previewLegacyImport`/`runLegacyImport` below
 * can be reached from the wizard's migration step on the user's own timeline.
 * `manual` records that the user chose to set things up from scratch
 * instead. Neither branch ever prints or implies a command that would
 * actually perform a migration. Idempotent: re-recording the same (or a
 * different) choice simply overwrites the marker and re-marks the step
 * completed.
 */
export function applyMigrationChoice(rootDir: string, choice: 'migrate-later' | 'manual'): void {
  const config = loadOnboardingConfig(rootDir)
  saveOnboardingConfig(rootDir, {
    ...config,
    migrationChoice: choice,
    steps: { ...config.steps, migration: 'completed' },
  })
}

/**
 * What `previewLegacyImport`/`runLegacyImport` need beyond the request body
 * (`tasks/plan.md` T7). `keyMaterial` is the vault key material `server.ts`'s
 * `openVaultAndSecrets` already resolves, threaded through (decision 10) so
 * the wizard's backup pre-check agrees with the CLI's.
 *
 * B9: no longer carries `spacesEngine` — it was threaded through only so a
 * caller *could* reach it, but neither `previewLegacyImport` nor
 * `runLegacyImport` ever read it (apply always constructs its own
 * `SpacesEngine` inside `applyImport`'s lock, decision 6, never a
 * caller-supplied one, since dry-run previewing must never touch it).
 * `onboarding-routes.ts` already has its own `spacesEngine` for refreshing
 * `GET /api/onboarding`'s status and does not need a second copy threaded
 * through here.
 */
export interface MigrationImportDeps {
  rootDir: string
  vault: SecretsVault | undefined
  keyMaterial: Buffer | undefined
  env: NodeJS.ProcessEnv
  /**
   * Removes the staged copy after a successful import. Injectable purely so
   * B4's "a failed cleanup never undoes a completed import" test can make it
   * throw: the obvious alternative — chmodding the staged directory
   * unwritable — also propagates into `createBackup`'s own recursive copy of
   * `rootDir` and breaks that step instead, which would test nothing.
   * Defaults to a recursive `rmSync`.
   */
  removeStagedCopy?: (dir: string) => void
}

/** Where the installer stages a detected legacy install (decision 16): `<rootDir>/import-source/<kind>/`. */
function stagedSourceDir(rootDir: string, kind: ImportSourceKind): string {
  return join(rootDir, 'import-source', kind)
}

/**
 * The exact CLI command every dead end in this module points at, built
 * through the one shared command-builder (`import-preview-text.ts`'s
 * `buildImportCommand`, B7 — closes the "three independent implementations"
 * duplication finding together with `import-cli.ts`'s own printer and
 * `deploy/README.md`). Always `sudo`-prefixed (the admin runs this from
 * their own shell, which needs root to read their home under
 * `ProtectHome=yes`) and always carries `--home` pointing at the admin's own
 * resolved home — omitting it (the bug this fixes, B7) would have this
 * `sudo`-run command search root's home instead of the admin's.
 */
function cliImportCommand(
  deps: MigrationImportDeps,
  kind: ImportSourceKind,
  extra: { secrets?: boolean } = {},
): string {
  const legacy = resolveLegacy(deps.rootDir, deps.env)
  const home = legacy.sourceHome ?? deps.env['VEDUTA_LEGACY_HOME'] ?? homedir()
  return buildImportCommand({
    kind,
    rootDir: deps.rootDir,
    home,
    apply: true,
    sudo: true,
    ...(extra.secrets === true ? { secrets: true } : {}),
  })
}

/** `statSync(dir).isDirectory()`, `false` (never throws) for anything missing, unreadable, or not a directory. */
function isReadableDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The one source-resolution helper preview and apply both call (`tasks/plan.md`
 * decision 16/17: "shared by both so preview and apply can never disagree").
 * Tries, in order: the installer-staged copy (what a real VPS install can
 * actually read, since the daemon runs under `ProtectHome=yes` and usually
 * cannot see `/home/<admin>/.hermes` at all); the legacy home this run
 * resolved (`onboarding.json.legacy` if the installer persisted it, else a
 * live scan — `resolveLegacy`'s own doc comment); `VEDUTA_LEGACY_HOME`; and
 * finally the daemon process's own `homedir()` (loopback/dev profile, where
 * the daemon and the user share a home). Returns `undefined`, never throws,
 * so the caller can turn "nothing readable" into a 409 with the CLI command
 * instead of crashing.
 *
 * B3: `resolveLegacyDir` only ever checks `existsSync` — a candidate that
 * exists but is a plain file, or a directory this process cannot actually
 * list, must not be accepted as "found" here, only to blow up later as an
 * uncaught `ImportSourceMissingError` past `sendStepError`'s specific
 * mappings (which land on a generic 500). `isReadableDirectory` is this
 * function's own readability gate; `buildPlanForRequest` below is the
 * second half of the fix, for the residual TOCTOU race between this check
 * and the actual read.
 */
function resolveMigrationSourceDir(
  deps: MigrationImportDeps,
  kind: ImportSourceKind,
): string | undefined {
  const staged = resolveLegacyDir({ kind, stagedDir: stagedSourceDir(deps.rootDir, kind) })
  if (staged !== undefined && isReadableDirectory(staged)) return staged

  const legacy = resolveLegacy(deps.rootDir, deps.env)
  const homeCandidates = [legacy.sourceHome, deps.env['VEDUTA_LEGACY_HOME'], homedir()]
  for (const home of homeCandidates) {
    if (home === undefined) continue
    const dir = resolveLegacyDir({ kind, home })
    if (dir !== undefined && isReadableDirectory(dir)) return dir
  }
  return undefined
}

/**
 * The wizard's one dead end for a source the daemon cannot read at all
 * (`tasks/plan.md` "Wire API": "Missing/unreadable source -> 409 with the CLI
 * command"). The message states why (the daemon usually cannot read the
 * admin's home under `ProtectHome=yes`) and gives the exact command to run
 * from a shell that can. Built as its own function (B3) so both
 * `requireReadableSource` (nothing was ever found) and `buildPlanForRequest`
 * (something was found but reading it raced into `ImportSourceMissingError`
 * anyway) throw the identical 409, rather than the latter falling through to
 * `sendStepError`'s generic 500 catch-all.
 */
function sourceMissingError(
  deps: MigrationImportDeps,
  kind: ImportSourceKind,
): OnboardingStepError {
  return new OnboardingStepError(
    [
      `no readable ${sourceLabel(kind)} install was found: this daemon runs under ProtectHome=yes ` +
        "and usually cannot read the admin's home directory, and no staged copy was found at " +
        `${stagedSourceDir(deps.rootDir, kind)}.`,
      'Run the import from a shell that can read it instead:',
      `  ${cliImportCommand(deps, kind)}`,
    ].join('\n'),
    409,
  )
}

/** Resolves the source directory or throws `sourceMissingError` (B3). */
function requireReadableSource(deps: MigrationImportDeps, kind: ImportSourceKind): string {
  const dir = resolveMigrationSourceDir(deps, kind)
  if (dir !== undefined) return dir
  throw sourceMissingError(deps, kind)
}

/**
 * `request.secrets === true` is rejected before anything else runs
 * (`tasks/plan.md` decision 13/16, "Wire API"): the installer never stages
 * secrets, so the wizard path is secret-free by construction, and the CLI's
 * own `--secrets` refuses to race the daemon-owned vault file from a second
 * process. Importing a secret is therefore CLI-only, never a wizard option —
 * this is a 400 (bad request), not a 409 (fixable dead end), since no state
 * change on the daemon's side would ever make this request valid.
 */
function rejectWizardSecrets(
  deps: MigrationImportDeps,
  request: { source: ImportSourceKind; secrets: boolean },
): void {
  if (!request.secrets) return
  throw new OnboardingStepError(
    [
      'secret import is CLI-only: the installer never stages secrets, and the daemon must not ' +
        'race its own vault file with a second writer.',
      'Import secrets from the CLI instead:',
      `  ${cliImportCommand(deps, request.source, { secrets: true })}`,
    ].join('\n'),
    400,
  )
}

/** Everything `buildImportPlan` needs, plus the resolved source directory apply reuses to decide whether to remove the staged copy. */
interface PlannedImport {
  dir: string
  snapshot: LegacySourceSnapshot
  secrets: SecretScan
  plan: ImportPlan
}

/**
 * Builds the plan for one request exactly once (`tasks/plan.md` decision 7:
 * "preview and apply take the same options... toggling an option in the
 * wizard re-previews"). `previewLegacyImport` returns just the `plan`;
 * `runLegacyImport` recomputes this same plan inside `applyImport` rather
 * than trusting a client-supplied one (decision 7's own "recomputing it,
 * never trusting a client-supplied plan" — a stale or tampered preview must
 * never be what actually gets applied). Uses `planLegacyImport`
 * (`import-plan.ts`) — the exact `readTargetState`/`loadImportState`/
 * `buildImportPlan` composition the CLI's own dry-run print and
 * `applyImportLocked` share — instead of reassembling it by hand a third
 * time.
 */
function buildPlanForRequest(
  deps: MigrationImportDeps,
  request: { source: ImportSourceKind; overwrite: boolean; secrets: boolean },
): PlannedImport {
  const dir = requireReadableSource(deps, request.source)
  let snapshot: LegacySourceSnapshot
  try {
    snapshot = readLegacySource(dir, request.source)
  } catch (error) {
    // B3: `resolveMigrationSourceDir`'s readability check is a point-in-time
    // check, not a guarantee — a source removed or made unreadable between
    // that check and this read must still surface as the same actionable
    // 409, never `sendStepError`'s generic 500 catch-all.
    if (error instanceof ImportSourceMissingError) throw sourceMissingError(deps, request.source)
    throw error
  }
  const secrets = scanLegacySecrets({ kind: request.source, dir })
  const plan = planLegacyImport({
    rootDir: deps.rootDir,
    snapshot,
    secrets,
    options: { overwrite: request.overwrite, secrets: request.secrets },
    backupAvailable: deps.keyMaterial !== undefined,
  })
  return { dir, snapshot, secrets, plan }
}

/**
 * `POST /api/onboarding/migration/preview` (`tasks/plan.md` T7). Pure
 * dry-run: `planLegacyImport`'s `readTargetState`/`loadImportState` reads are
 * both plain `fs` reads (decision 6), and this function never calls
 * `applyImport` or constructs a `SpacesEngine` — so calling it twice in a
 * row, or after toggling `overwrite`, writes nothing to either the source or
 * the target.
 */
export function previewLegacyImport(
  deps: MigrationImportDeps,
  request: ImportPreviewRequest,
): ImportPlan {
  rejectWizardSecrets(deps, request)
  return buildPlanForRequest(deps, request).plan
}

/**
 * `POST /api/onboarding/migration/import` (`tasks/plan.md` T7). Recomputes
 * the plan (never trusts a client-supplied one — decision 7; `applyImport`
 * itself recomputes it again a second time, inside its lock — A2), delegates
 * the actual write to `applyImport` (decision 17: "the CLI is the engine;
 * routes are a second front end" — no logic duplicated; the `snapshot`,
 * `secrets` and `options` triple is `applyImport`'s current signature, not a
 * pre-built `plan`, so the recomputation inside the lock is the only plan
 * that ever actually gets applied). `applyImport` itself throws
 * `ImportRefusedError` for a blocked plan (a conflict `--overwrite` did not
 * clear, no vault key material, a held lock) — `onboarding-routes.ts` maps
 * that to a 409, same as `VaultUnavailableError`.
 *
 * B4: the onboarding config is saved BEFORE the staged copy is removed, not
 * after. `applyImport` having already returned means the import itself
 * fully happened (backup, writes, archive, marker — all already durable);
 * removing the staged directory afterwards is pure best-effort cleanup of a
 * now-redundant second copy, so a thrown `rmSync` must never make a
 * completed import look like a failure, and must never leave
 * `migrationChoice`/`steps.migration` unset while the only readable source
 * is also gone.
 */
export async function runLegacyImport(
  deps: MigrationImportDeps,
  request: ImportApplyRequest,
): Promise<ImportResult> {
  rejectWizardSecrets(deps, request)
  const { dir, snapshot, secrets } = buildPlanForRequest(deps, request)

  const result = await applyImport(
    {
      rootDir: deps.rootDir,
      ...(deps.vault === undefined ? {} : { vault: deps.vault }),
      ...(deps.keyMaterial === undefined ? {} : { keyMaterial: deps.keyMaterial }),
    },
    { snapshot, secrets, options: { overwrite: request.overwrite, secrets: request.secrets } },
  )

  const config = loadOnboardingConfig(deps.rootDir)
  saveOnboardingConfig(deps.rootDir, {
    ...config,
    migrationChoice: 'imported',
    steps: { ...config.steps, migration: 'completed' },
  })

  const staged = stagedSourceDir(deps.rootDir, request.source)
  if (dir === staged) {
    const remove =
      deps.removeStagedCopy ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
    try {
      remove(staged)
    } catch {
      // Best-effort only (B4) — see the doc comment above. The import is
      // already durably recorded by this point; a failure here just leaves
      // a harmless, redundant staged copy behind for a later cleanup.
    }
  }

  return result
}
