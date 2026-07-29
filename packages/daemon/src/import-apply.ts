import {
  chmodSync,
  closeSync,
  existsSync,
  lchownSync,
  lstatSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  ImportFactCounts,
  ImportItem,
  ImportOptions,
  ImportPlan,
  ImportResult,
} from '@veduta/protocol'
import { ImportResultSchema } from '@veduta/protocol'
import { createBackup } from './backup.ts'
import { backupFile } from './config-backup.ts'
import type { CuratorOperation } from './facts.ts'
import { buildNotesMarkdown, writeImportArchive } from './import-archive.ts'
import {
  IMPORT_TARGETS,
  IMPORTED_SPACE_NAME,
  IMPORTED_SPACE_SLUG,
  MAX_IMPORTED_FACTS,
  adaptSoul,
  extractMemoryEntries,
  importedSpaceInstructions,
  wrapImportedUser,
} from './import-mapping.ts'
import { planLegacyImport } from './import-plan.ts'
import type { SecretScan } from './import-secrets.ts'
import type { LegacySourceSnapshot } from './import-source.ts'
import { loadImportState, saveImportState, type ImportStateEntry } from './import-state.ts'
import { VAULT_UNAVAILABLE_MESSAGE } from './onboarding-status.ts'
import { storeProviderKey } from './onboarding-step-byok.ts'
import { defaultRedactor } from './redaction.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { untrustedOrigin } from './taint.ts'
import type { SecretsVault } from './secrets-vault.ts'

/**
 * Thrown whenever apply must refuse rather than write anything ("conflicts refuse, never skip").
 * `blocked` always echoes every reason the refusal covers — the CLI/wizard use it verbatim, never
 * just the first line of `message`, so a multi-reason refusal is never silently truncated to one
 * item.
 */
export class ImportRefusedError extends Error {
  constructor(
    message: string,
    readonly blocked: string[],
  ) {
    super(message)
    this.name = 'ImportRefusedError'
  }
}

export interface ApplyImportDeps {
  rootDir: string
  vault?: SecretsVault
  keyMaterial?: Buffer
  now?: () => Date
}

/**
 * no longer carries a pre-built `plan` — `applyImportLocked` recomputes
 * it itself, as the first thing inside the lock, via `planLegacyImport`
 * (`import-plan.ts`). A plan built outside the lock (by a preview call, by
 * the CLI before the user confirms, by a wizard round trip) could be stale
 * by the time apply runs; recomputing it here, with the marker/conflict
 * checks evaluated only once the lock is held, is what stops two concurrent
 * applies of the same source from both observing "not previously imported".
 */
export interface ApplyImportInput {
  snapshot: LegacySourceSnapshot
  secrets: SecretScan
  options: ImportOptions
}

const LOCK_FILE = 'import.lock'

/**
 * Looks up the plan item for `target`, throwing rather than silently
 * treating "not found" as "nothing to do": `buildImportPlan` always
 * pushes exactly one item per `IMPORT_TARGETS` slot (as `skip`, `import`, or
 * `overwrite`), so a missing item here can only mean the target string
 * drifted between the plan builder and this lookup — previously a fail-open
 * bug (`items.find(...)` returning `undefined`, apply silently skipping the
 * write for that slot while still reporting success). Never called for
 * vault items, which are iterated directly off `secrets.importable` instead
 * of looked up by target (`vault:<name>` embeds a per-secret provider name).
 */
export function requirePlanItem(items: ImportItem[], target: string): ImportItem {
  const item = items.find((candidate) => candidate.target === target)
  if (item === undefined) {
    throw new Error(
      `internal error: no plan item for target "${target}" — refusing to silently skip it`,
    )
  }
  return item
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * The pure decision behind the ownership fix:
 * kept separate from the filesystem walk so it is testable without root.
 * Returns the uid to `lchown` the whole `rootDir` tree to, or `undefined`
 * when no fix is needed — which is every case except "this process is root
 * (`processUid === 0`) AND `rootDir` is owned by some OTHER uid". A
 * non-root process never touches ownership (it usually cannot anyway); a
 * root process whose target directory is already root-owned has nothing to
 * restore.
 */
export function ownershipTarget(input: {
  processUid?: number
  rootUid: number
}): number | undefined {
  if (input.processUid !== 0) return undefined
  return input.rootUid === 0 ? undefined : input.rootUid
}

/** `lchown`s `path` itself (never following a symlink) and, if it is a real directory, every descendant. */
function chownTreeRecursive(path: string, uid: number, gid: number): void {
  lchownSync(path, uid, gid)
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  for (const name of readdirSync(path)) {
    chownTreeRecursive(join(path, name), uid, gid)
  }
}

/**
 * Step 9: when this process runs as root against a `rootDir` some
 * other uid owns, every path apply (and `createBackup`, `SpacesEngine`, the vault) may have created
 * is fixed up in one pass, because none of those callers hand back a full path list. A non-root
 * process, or a `rootDir` root already owns, is a no-op.
 */
function fixOwnershipIfNeeded(rootDir: string): void {
  const processUid = process.getuid?.()
  if (processUid === undefined) return
  const rootStat = statSync(rootDir)
  const target = ownershipTarget({ processUid, rootUid: rootStat.uid })
  if (target === undefined) return
  chownTreeRecursive(rootDir, target, rootStat.gid)
}

/** Filesystem-safe ISO timestamp for the archive directory name, matching `backup.ts`'s convention. */
function isoForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}

function emptyFactCounts(): ImportFactCounts {
  return { added: 0, updated: 0, superseded: 0, noop: 0, overflow: 0 }
}

/**
 * `facts.ts`'s `CuratorOperation` ('add'/'update'/'supersede'/'noop'/'reactivate') and
 * `ImportFactCounts`'s field names ('added'/'updated'/'superseded'/'noop') are spelled
 * differently on purpose (one is a verb describing what the Curator just did, the other a
 * noun-count field in the wire schema) — this is the one place that bridges them, so a typo
 * here fails loudly rather than silently indexing a counts object with a key it does not
 * have. `ImportFactCounts` (`@veduta/protocol`) has no bucket of its own for `reactivate`
 * yet, so a memory entry that restates a dormant fact is counted as `added` here — it is,
 * after all, a fact that was not in the active set before this import run and is afterwards.
 * Giving `reactivate` its own reported count is a wire-protocol change, left to a follow-up.
 */
const FACT_COUNT_FIELD: Record<CuratorOperation, keyof ImportFactCounts> = {
  add: 'added',
  update: 'updated',
  supersede: 'superseded',
  noop: 'noop',
  reactivate: 'added',
}

interface IdentityWriteResult {
  soulUpdated: boolean
  userUpdated: boolean
}

/**
 * Step 4: writes SOUL.md/USER.md, each individually backed up first — only when the plan actually
 * has a non-skip item for that target (per-item conflicts already decided whether this run touches
 * them at all). written `0600` — the vault/config/archive convention — rather than left at
 * umask-derived permissions.
 */
function writeGlobalIdentityFiles(
  rootDir: string,
  now: () => Date,
  plan: ImportPlan,
  snapshot: LegacySourceSnapshot,
): IdentityWriteResult {
  let soulUpdated = false
  const soulItem = requirePlanItem(plan.items, IMPORT_TARGETS.soul)
  if (soulItem.action !== 'skip' && snapshot.soul) {
    const soulPath = join(rootDir, 'SOUL.md')
    backupFile(soulPath, now)
    const adaptedSoul = adaptSoul(snapshot.soul.text, snapshot.kind)
    // Anti-divergence guarantee (ADR-0010):
    // the text written here MUST be byte-identical to `plan.soulPreview` —
    // that is the whole point of the mitigation ("the full adapted text
    // appears in the preview before anything is written"). Unconditional,
    // not "check only when present" — if the plan writes SOUL, `soulPreview`
    // MUST be present and equal, never merely equal-when-present. Since the
    // plan is always built in-process right above, so an absent preview on a
    // writing plan can only be an internal bug, not a legitimate omission.
    if (plan.soulPreview === undefined || plan.soulPreview !== adaptedSoul) {
      throw new Error(
        'internal error: SOUL.md write is missing a matching soulPreview — this must never ' +
          'happen; refusing to write an unpreviewed SOUL.md',
      )
    }
    writeFileSync(soulPath, adaptedSoul, { mode: 0o600 })
    // `writeFileSync`'s `mode` only applies when it CREATES the file: overwriting an
    // existing SOUL.md keeps whatever permissions it already had. These two files carry
    // the user's identity and profile, so tighten them explicitly either way.
    chmodSync(soulPath, 0o600)
    soulUpdated = true
  }

  let userUpdated = false
  const userItem = requirePlanItem(plan.items, IMPORT_TARGETS.user)
  if (userItem.action !== 'skip' && snapshot.user) {
    const userPath = join(rootDir, 'USER.md')
    backupFile(userPath, now)
    writeFileSync(userPath, wrapImportedUser(snapshot.user.text, snapshot.kind), {
      mode: 0o600,
    })
    chmodSync(userPath, 0o600)
    userUpdated = true
  }

  return { soulUpdated, userUpdated }
}

interface SpacePopulationResult {
  spaceId: string | undefined
  factCounts: ImportFactCounts
  eventsAppended: number
}

/**
 * Steps 5-6: reconciles the `Imported` Space by slug — reusing
 * a non-archived Space already at that slug rather than letting
 * `createSpace`'s own `uniqueSlug` mint a second one — then, only when the
 * plan has facts or Event log work to do, writes the imported memory entries
 * and notes into it, all stamped untrusted. `extractMemoryEntries`
 * already redacted every entry, so no further redaction is
 * needed before `writeFact`; `appendEvent` redacts its own `text` again on
 * the way in (spaces-engine.ts), harmless idempotent double coverage for the
 * overflow/notes path.
 */
function populateImportedSpace(
  spacesEngine: SpacesEngine,
  plan: ImportPlan,
  snapshot: LegacySourceSnapshot,
): SpacePopulationResult {
  const factsItem = requirePlanItem(plan.items, IMPORT_TARGETS.facts)
  const logItem = requirePlanItem(plan.items, IMPORT_TARGETS.log)
  const hasSpaceWork = factsItem.action !== 'skip' || logItem.action !== 'skip'

  let spaceId: string | undefined
  let factCounts = emptyFactCounts()
  let eventsAppended = 0

  if (hasSpaceWork) {
    const existing = spacesEngine.listSpaces().find((space) => space.slug === IMPORTED_SPACE_SLUG)
    const space =
      existing ??
      spacesEngine.createSpace({
        name: IMPORTED_SPACE_NAME,
        slug: IMPORTED_SPACE_SLUG,
        // source-neutral — this same Space is reused when the *other*
        // source is imported later, so its instructions must
        // never commit to naming just the source of this particular run.
        instructions: importedSpaceInstructions(),
      })
    spaceId = space.id

    const origin = untrustedOrigin(snapshot.kind)
    const memoryEntries = extractMemoryEntries(snapshot.memory?.text ?? '')
    const factsToWrite = memoryEntries.slice(0, MAX_IMPORTED_FACTS)
    const overflowEntries = memoryEntries.slice(MAX_IMPORTED_FACTS)

    factCounts = { ...emptyFactCounts(), overflow: overflowEntries.length }
    for (const entry of factsToWrite) {
      // `writeFact` appends its own `fact.write` Event log entry — that is
      // NOT counted in `eventsAppended` below, which only counts events
      // THIS function appends directly (overflow memory + notes).
      const result = spacesEngine.writeFact(spaceId, entry, origin)
      factCounts[FACT_COUNT_FIELD[result.operation]] += 1
    }

    for (const entry of overflowEntries) {
      spacesEngine.appendEvent(spaceId, { type: 'import.memory', text: entry, origin })
      eventsAppended += 1
    }

    for (const note of snapshot.notes) {
      const at = note.date === undefined ? undefined : `${note.date}T00:00:00.000Z`
      spacesEngine.appendEvent(spaceId, {
        type: 'import.note',
        text: note.text,
        origin,
        ...(at === undefined ? {} : { at }),
      })
      eventsAppended += 1
    }
  }

  return { spaceId, factCounts, eventsAppended }
}

/**
 * Step 7: stores every allowlisted secret in the vault and points routing at
 * it, via the same `storeProviderKey` helper
 * `onboarding-step-byok.ts` uses. Only ever called when `plan.options.secrets`
 * is true; `vault` must be defined at that point (the pre-flight check in
 * `applyImportLocked` already refused otherwise) — re-checked here only for
 * type narrowing, since this runs after the `await createBackup` call above.
 */
function importAllowlistedSecrets(
  rootDir: string,
  vault: SecretsVault | undefined,
  importable: SecretScan['importable'],
): string[] {
  if (!vault) {
    throw new ImportRefusedError(VAULT_UNAVAILABLE_MESSAGE, [VAULT_UNAVAILABLE_MESSAGE])
  }
  const secretsImported: string[] = []
  for (const secret of importable) {
    defaultRedactor.register(secret.value)
    storeProviderKey({ rootDir, vault }, secret.vaultName, secret.value)
    secretsImported.push(secret.vaultName)
  }
  return secretsImported
}

/**
 * `applyImport`'s body, run only once the exclusive lock is held
 * (`applyImport` acquires and releases it). Ordering below is the spec
 * (amended by) — do not rearrange it:
 * recompute the plan → refuse-if-blocked → backup → SOUL/USER → the
 * `Imported` Space → facts/events → secrets → archive → NOTES → marker →
 * ownership fix LAST. The marker moved before the ownership fix: a
 * root-run import that fixed ownership before writing `import.json` left
 * that marker (and its `.bak`) root-owned, which the next non-root daemon
 * boot could not rewrite.
 */
async function applyImportLocked(
  deps: ApplyImportDeps,
  input: ApplyImportInput,
): Promise<ImportResult> {
  const rootDir = deps.rootDir
  const now = deps.now ?? (() => new Date())

  // Step 1: recompute the plan INSIDE the lock — never trust one built
  // outside it. This is what stops two concurrent applies of the same
  // source from both observing "not previously imported".
  // `planLegacyImport` is the exact
  // readTargetState/loadImportState/buildImportPlan composition preview
  // call sites use, so preview and apply can never structurally disagree —
  // only the moment they run (before vs. inside the lock) differs.
  const plan = planLegacyImport({
    rootDir,
    snapshot: input.snapshot,
    secrets: input.secrets,
    options: input.options,
    backupAvailable: deps.keyMaterial !== undefined,
  })

  // Step 2: a blocked plan means a conflict `--overwrite` did not (or
  // cannot) clear, or an environmental refusal (no backup key material,
  // source/target overlap, oversize identity file, a bad target root) —
  // Nothing has been written yet.
  if (plan.blocked.length > 0) {
    throw new ImportRefusedError(
      `import refused:\n${plan.blocked.map((reason) => `- ${reason}`).join('\n')}`,
      plan.blocked,
    )
  }

  // Pre-flight for secrets: `--secrets` was requested but
  // this process has no vault. This check is hoisted BEFORE the backup
  // (rather than only at the literal "step 7" secrets stage) precisely
  // because "refuse before writing anything else" only holds if it runs
  // before step 3, not after SOUL/USER/facts/events already landed.
  if (plan.options.secrets && !deps.vault) {
    const reason =
      'secrets import requested (--secrets) but no vault is available in this process; ' +
      'the CLI refuses to race the daemon-owned vault file — stop the daemon first, or omit --secrets.'
    throw new ImportRefusedError(reason, [reason])
  }

  // Step 3: backup. No key material, no backup, no mutation.
  // (A blocked plan above would already have refused here — `buildImportPlan`
  // blocks whenever `backupAvailable` is false — so this check is now only
  // TypeScript narrowing of `deps.keyMaterial` before `createBackup`.)
  if (!deps.keyMaterial) {
    throw new ImportRefusedError(VAULT_UNAVAILABLE_MESSAGE, [VAULT_UNAVAILABLE_MESSAGE])
  }
  const backupPath = await createBackup({
    rootDir,
    outDir: join(rootDir, 'backups'),
    keyMaterial: deps.keyMaterial,
    now,
  })

  // Step 4: SOUL/USER (see `writeGlobalIdentityFiles`'s doc comment).
  const { soulUpdated, userUpdated } = writeGlobalIdentityFiles(rootDir, now, plan, input.snapshot)

  // Step 5-6: the `Imported` Space, plus facts/events — see
  // `populateImportedSpace`'s doc comment. Constructing `SpacesEngine` IS a
  // mutation (`ensureBaseLayout`), so it happens here and nowhere earlier in
  // the whole importer.
  const spacesEngine = new SpacesEngine({ rootDir, now })
  const { spaceId, factCounts, eventsAppended } = populateImportedSpace(
    spacesEngine,
    plan,
    input.snapshot,
  )

  // Step 7: secrets, only when requested (see `importAllowlistedSecrets`'s
  // doc comment). The pre-flight check above already guarantees `deps.vault`
  // is defined whenever `plan.options.secrets` is true; re-checked inside
  // the helper for type narrowing across the `await createBackup` call above.
  const secretsImported = plan.options.secrets
    ? importAllowlistedSecrets(rootDir, deps.vault, input.secrets.importable)
    : []

  // Step 8: archive + NOTES.md. `buildNotesMarkdown` now
  // renders the REAL `WriteImportArchiveResult` from the walk that just ran
  // (archived files and every skipped one with its reason), not the plan's
  // pre-apply candidate count — those two disagreeing (a directory counted
  // as one candidate, no mapped-elsewhere filter applied yet) was the bug.
  const archiveDir = join(
    rootDir,
    'import-archive',
    `${input.snapshot.kind}-${isoForFilename(now())}`,
  )
  const archiveResult = writeImportArchive({ sourceDir: input.snapshot.dir, archiveDir })
  const notesPath = join(archiveDir, 'NOTES.md')
  writeFileSync(
    notesPath,
    buildNotesMarkdown({ plan, rootDir, now: now().toISOString(), archiveResult }),
    { mode: 0o600 },
  )

  // Step 10: the marker (before the ownership fix, not after — see that
  // step's comment). A crash before this point leaves per-item conflicts
  // (SOUL/USER already there, `imported` Space already there) that make the
  // retry refuse with an actionable message on their own: intended behaviour.
  const priorState = loadImportState(rootDir)
  const entry: ImportStateEntry = {
    source: input.snapshot.kind,
    sourceDir: input.snapshot.dir,
    at: now().toISOString(),
    ...(spaceId === undefined ? {} : { spaceId }),
    factsWritten: factCounts.added + factCounts.updated + factCounts.superseded,
    eventsAppended,
  }
  saveImportState(rootDir, { version: 1, imports: [...priorState.imports, entry] })

  // Step 11: ownership fix LAST, after the marker — a root-run import
  // that fixed ownership before writing `import.json` left that marker (and
  // its `saveImportState`-created `.bak`) root-owned, since the chown walk
  // above would already have finished before those files existed. Running
  // it last means it walks a `rootDir` that already contains everything
  // this run wrote, marker included.
  fixOwnershipIfNeeded(rootDir)

  // Step 12.
  return ImportResultSchema.parse({
    plan,
    backupPath,
    archiveDir,
    notesPath,
    ...(spaceId === undefined ? {} : { spaceId }),
    facts: factCounts,
    eventsAppended,
    soulUpdated,
    userUpdated,
    secretsImported,
  })
}

/**
 * The importer's write path: the CLI and the wizard routes call this identically (no logic
 * duplicated between front ends). Everything up to and including the lock acquisition/release is
 * the "one writer at a time" rule; `applyImportLocked` is the ordered body the lock protects.
 * Any error — a thrown `ImportRefusedError` or anything else — still releases the lock: the
 * `finally` below runs regardless, so a refusal never leaves a stuck `import.lock` behind.
 */
export async function applyImport(
  deps: ApplyImportDeps,
  input: ApplyImportInput,
): Promise<ImportResult> {
  const lockPath = join(deps.rootDir, LOCK_FILE)
  let lockFd: number
  try {
    lockFd = openSync(lockPath, 'wx')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      throw new ImportRefusedError(
        `another import is already running (lock held at ${lockPath}). If this is stale ` +
          `(a crashed previous run), remove it and retry: rm '${lockPath}'`,
        [`import.lock is held at ${lockPath}`],
      )
    }
    throw error
  }

  try {
    return await applyImportLocked(deps, input)
  } finally {
    closeSync(lockFd)
    if (existsSync(lockPath)) unlinkSync(lockPath)
  }
}
