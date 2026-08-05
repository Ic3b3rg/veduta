import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { ReleaseMetadataSchema, UpdateProgressSchema, UpdateResultSchema } from '@veduta/protocol'
import type {
  ReleaseMetadata,
  UpdateMarker,
  UpdatePinning,
  UpdateProgress,
  UpdateResult,
  UpdateStageStatus,
} from '@veduta/protocol'
import { z } from 'zod'
import { createBackup, restoreBackup } from '../backup.ts'
import { checkMonotonic, verifyReleaseChain } from './minisign.ts'
import { extractVerifiedArchive } from './tar-reader.ts'
import { isoForFilename, writeJsonAtomic, writeJsonAtomicBestEffort } from './update-atomic.ts'
import { checkDiskGuardrail } from './update-guardrail.ts'
import { runSuccessHousekeeping } from './update-housekeeping.ts'
import { fetchChecked } from './update-ports.ts'
import type { Ports } from './update-ports.ts'
import { computeRuntimeDirName, ensureRuntime } from './update-runtime.ts'

/**
 * The recoverable update transaction (issue #43,
 * `docs/adr/0013-signed-self-update.md` and its "Amendments" section): the
 * on-disk state machine `deploy/veduta-run` (via `update-cli.ts`) drives to
 * take a verified release from "offered" to "serving", with a journaled
 * rollback path so a crash at any point is resumed or reverted on the next
 * start rather than ever leaving old code running against migrated data.
 *
 * Scope: this module owns the transaction itself — the journal/rollback
 * state machine, verify, download, stage, backup, migrate, flip, and stage-1
 * (hermetic) health — plus the uniform terminal-publication sequence
 * (`result.json`, success housekeeping, journal archive) shared by every
 * outcome. Everything else it leans on is a separate, independently testable
 * module: `update-ports.ts` (injected network/exec/disk ports plus the
 * shared host/https fetch discipline), `update-runtime.ts` (ensuring and
 * verifying the Node runtime, AC6), `update-guardrail.ts` (the free-disk
 * check, AC8), `update-atomic.ts` (the one durable tmp-then-rename write
 * primitive), and `update-housekeeping.ts` (success-only pruning and the
 * wrapper self-update). Stage 2 (starting the real daemon and waiting for it
 * to actually serve) is `deploy/veduta-run`'s job: this module exposes
 * `finalizeUpdate` and `rollbackUpdate` for it to call once it has made its
 * own judgment about stage 2.
 */

// Re-exported so `update-cli.ts` and every test keep a single import surface
// for the whole update system, unaffected by which file actually implements
// the injected ports.
export { defaultPorts } from './update-ports.ts'
export type {
  ExecFileOptions,
  ExecFileResult,
  FetchBytesOptions,
  FetchBytesResult,
  Ports,
  StatfsResult,
} from './update-ports.ts'

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface UpdateHome {
  root: string
  releasesDir: string
  currentSymlink: string
  runtimesDir: string
  binDir: string
  stateDir: string
  historyDir: string
  logsDir: string
  backupsDir: string
  tmpDir: string
}

/** Resolves the typed absolute paths of an update home (e.g. `/var/lib/veduta/updates` on a real install, or a throwaway directory in tests). Pure — does not touch the filesystem. */
export function resolveUpdateHome(root: string): UpdateHome {
  const absoluteRoot = resolve(root)
  const releasesDir = join(absoluteRoot, 'releases')
  const stateDir = join(absoluteRoot, 'state')
  return {
    root: absoluteRoot,
    releasesDir,
    currentSymlink: join(releasesDir, 'current'),
    runtimesDir: join(absoluteRoot, 'runtimes'),
    binDir: join(absoluteRoot, 'bin'),
    stateDir,
    historyDir: join(stateDir, 'history'),
    logsDir: join(stateDir, 'logs'),
    backupsDir: join(absoluteRoot, 'backups'),
    tmpDir: join(absoluteRoot, 'tmp'),
  }
}

/** Creates every directory an update home needs, mode 0700 where newly created. Safe to call on every transaction start — `mkdirSync(..., {recursive: true})` is a no-op on an existing directory. */
export function ensureUpdateHomeLayout(home: UpdateHome): void {
  for (const dir of [
    home.releasesDir,
    home.runtimesDir,
    home.binDir,
    home.stateDir,
    home.historyDir,
    home.logsDir,
    home.backupsDir,
    home.tmpDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const PHASE_ORDER = [
  'started',
  'downloaded',
  'verified',
  'staged',
  'backup-done',
  'migrating',
  'migrated',
  'switched',
  'serving-check',
] as const

export type Phase = (typeof PHASE_ORDER)[number]

const ROLLBACK_SUBSTATE_ORDER = ['data-moved-aside', 'restored', 'flipped-back', 'done'] as const
const RollbackSubstateSchema = z.enum(ROLLBACK_SUBSTATE_ORDER)
export type RollbackSubstate = z.infer<typeof RollbackSubstateSchema>

const JournalSchema = z.object({
  phase: z.enum(PHASE_ORDER),
  toVersion: z.string().min(1),
  fromVersion: z.string().min(1),
  /**
   * Absolute path of the release currently running this transaction — where
   * `deploy/veduta-run` execs `update-cli.ts` from if it needs to resume,
   * never the new release. Never empty: when `releases/current` does not
   * exist yet (the very first update), this is the legacy checkout path
   * (`UpdateTransactionOptions.legacyRoot`) instead — a real, resumable
   * executor location, not the empty string a missing symlink used to
   * produce (issue #43 review follow-up). See `hadPriorRelease` for what
   * this path actually means to rollback.
   */
  executorRelease: z.string(),
  /**
   * Whether `releases/current` already pointed at a previous release when
   * this transaction started (issue #43 review follow-up). `true` means
   * `executorRelease` above is a real `releases/vX.Y.Z` directory and
   * rollback's flip-back substate restores `current` to point at it; `false`
   * means this is a first update with no prior release at all —
   * `executorRelease` is only the legacy checkout for crash-recovery
   * logging, and rollback must instead remove the `current` symlink
   * entirely, falling back to the legacy checkout the same way the system
   * ran before this transaction started. Defaults to `true` for any journal
   * written before this field existed, preserving the old always-flip-back
   * behavior for a journal that already recorded a real `executorRelease`.
   */
  hadPriorRelease: z.boolean().default(true),
  release: ReleaseMetadataSchema,
  /**
   * The verbatim marker this transaction was started from — kept in the
   * journal (not just the caller's in-memory options) because the marker
   * file itself is consumed at `started`
   * (`docs/adr/0013-signed-self-update.md`'s self-update amendments: no
   * marker replay once a transaction is under way), so a resumed transaction
   * has nowhere else to read the signed release bytes/signatures from.
   */
  marker: z.object({
    requestedAt: z.string(),
    release: z.string(),
    releaseSig: z.string(),
    signingKey: z.object({ pub: z.string(), rootSig: z.string(), keyId: z.string() }),
    artifactUrl: z.string(),
  }),
  startedAt: z.string(),
  releaseDir: z.string().optional(),
  runtimeDirName: z.string().optional(),
  backupFile: z.string().optional(),
  rollback: z
    .object({ substate: RollbackSubstateSchema, failedDataDir: z.string().optional() })
    .optional(),
})

type Journal = z.infer<typeof JournalSchema>

function phaseIndex(phase: Phase): number {
  return PHASE_ORDER.indexOf(phase)
}

function rollbackSubstateIndex(substate: RollbackSubstate): number {
  return ROLLBACK_SUBSTATE_ORDER.indexOf(substate)
}

function journalPath(home: UpdateHome): string {
  return join(home.stateDir, 'update-state.json')
}

function resultPath(home: UpdateHome): string {
  return join(home.stateDir, 'result.json')
}

function readJournal(home: UpdateHome): Journal | undefined {
  const path = journalPath(home)
  if (!existsSync(path)) return undefined
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const parsed = JournalSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`corrupt update journal at ${path}: ${parsed.error.message}`)
  }
  return parsed.data
}

function writeJournal(home: UpdateHome, journal: Journal): Journal {
  writeJsonAtomic(journalPath(home), journal)
  return journal
}

/** The terminal commit point (`docs/adr/0013-signed-self-update.md`): a single rename retires the live journal for every outcome — success, refused, and rolled-back alike. Idempotent: a re-entry after the journal is already archived is a no-op. */
function archiveJournal(home: UpdateHome, toVersion: string, now: Date): void {
  const path = journalPath(home)
  if (!existsSync(path)) return
  mkdirSync(home.historyDir, { recursive: true })
  const dest = join(home.historyDir, `${isoForFilename(now)}-${toVersion}.json`)
  renameSync(path, dest)
}

function markerPath(home: UpdateHome): string {
  return join(home.stateDir, 'marker.json')
}

/** Consumes `state/marker.json` if present — so no crash or retry can ever re-read the same marker twice. The marker file itself is written by the daemon's update Surface "Apply" action (`update-manager.ts`); this module tolerates its absence, since the marker's content is already handed in as `options.marker` regardless (a caller that already parsed it, or a test fixture, never has to write one to disk at all). */
function consumeMarkerFileIfPresent(home: UpdateHome, now: Date): void {
  const path = markerPath(home)
  if (!existsSync(path)) return
  renameSync(path, join(home.stateDir, `.marker-consumed-${isoForFilename(now)}.json`))
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// ---------------------------------------------------------------------------
// Test-only stop knob (AC4-shape: cooperative interruption at any phase boundary)
// ---------------------------------------------------------------------------

/**
 * Thrown by the cooperative test-stop knob below — simulates the process
 * being killed at an exact, named checkpoint, for `issues/043-self-update.md`
 * AC4 harness coverage. Deliberately distinct from every other error this
 * module throws: the orchestration below must never treat it as a real
 * failure (which would refuse or roll back) — it re-throws unchanged so the
 * test can then call `resumeUpdateTransaction` and assert the resume rules.
 */
export class UpdateTransactionStoppedError extends Error {
  readonly checkpoint: string
  constructor(checkpoint: string) {
    super(`test knob: stopped after checkpoint '${checkpoint}'`)
    this.name = 'UpdateTransactionStoppedError'
    this.checkpoint = checkpoint
  }
}

/**
 * Harness-only failure/interruption injection for `issues/043-self-update.md`
 * AC4, doubly guarded the same way `self-check.ts`'s test knob is: a stray
 * `VEDUTA_TEST_STOP_AFTER_PHASE` left set in an operator's environment must
 * never interrupt a real update, so both this AND the harness-wide
 * `VEDUTA_UPDATE_TEST_KNOBS` opt-in have to be present.
 */
function maybeTestStop(checkpoint: string, env: NodeJS.ProcessEnv): void {
  if (
    env['VEDUTA_UPDATE_TEST_KNOBS'] === '1' &&
    env['VEDUTA_TEST_STOP_AFTER_PHASE'] === checkpoint
  ) {
    throw new UpdateTransactionStoppedError(checkpoint)
  }
}

// ---------------------------------------------------------------------------
// Progress reporting (best-effort, post-hoc — docs/adr/0013-signed-self-update.md)
// ---------------------------------------------------------------------------

const PROGRESS_STAGE_TITLES: Record<string, string> = {
  guardrail: 'Check free disk space',
  download: 'Download the release artifact',
  verify: 'Verify the downloaded artifact',
  stage: 'Extract the release',
  runtime: 'Ensure the required Node runtime',
  backup: 'Back up your data',
  migrate: 'Migrate your data',
  switch: 'Switch to the new release',
  health: 'Run the health check',
  finalize: 'Finish up',
}

function progressPath(home: UpdateHome): string {
  return join(home.stateDir, 'progress.json')
}

function freshProgress(): UpdateProgress {
  return {
    protocol_version: 1,
    stages: Object.keys(PROGRESS_STAGE_TITLES).map((id) => ({
      id,
      title: PROGRESS_STAGE_TITLES[id] ?? id,
      status: 'pending',
    })),
  }
}

/** Overwrites `progress.json` with every stage reset to `pending` (issue #43 review follow-up): called once, at the very start of a brand-new transaction — never on resume — so a new run never inherits a previous run's terminal stage statuses (all `done`) and reports an early failure honestly instead of appearing to have gotten further than it did. */
function resetProgress(home: UpdateHome): void {
  writeJsonAtomicBestEffort(progressPath(home), freshProgress())
}

function readOrInitProgress(home: UpdateHome): UpdateProgress {
  const path = progressPath(home)
  if (existsSync(path)) {
    const parsed = UpdateProgressSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
  }
  return freshProgress()
}

function markProgress(ctx: Ctx, id: string, status: UpdateStageStatus): void {
  const progress = readOrInitProgress(ctx.home)
  const updated: UpdateProgress = {
    ...progress,
    stages: progress.stages.map((stage) => (stage.id === id ? { ...stage, status } : stage)),
  }
  writeJsonAtomicBestEffort(progressPath(ctx.home), updated)
}

// ---------------------------------------------------------------------------
// Logging (tee into state/logs/<version>.log, per docs/adr/0013-signed-self-update.md)
// ---------------------------------------------------------------------------

function makeLogger(home: UpdateHome, version: string, ports: Ports): (line: string) => void {
  mkdirSync(home.logsDir, { recursive: true })
  const logPath = join(home.logsDir, `${version}.log`)
  return (line: string) => {
    try {
      const fd = openSync(logPath, 'a', 0o600)
      try {
        writeSync(fd, `${line}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // Logging must never fail the transaction it is describing.
    }
    ports.log(line)
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UpdateTransactionOptions {
  home: UpdateHome
  dataRootDir: string
  pinning: UpdatePinning
  marker: UpdateMarker
  installedVersion: string
  installedDataVersion: number
  /** Vault keyfile bytes, passed straight through to `createBackup`/`restoreBackup`. */
  keyMaterial: Buffer
  ports: Ports
  env?: NodeJS.ProcessEnv
  /**
   * Absolute path of the legacy (pre-`releases/`) checkout — the code the
   * installer originally deployed, and what still serves as `current`'s
   * de facto executor until the very first successful update ever creates
   * `releases/current` (`docs/adr/0013-signed-self-update.md`'s Amendments,
   * layout note 3). Required only when `runUpdateTransaction` finds no
   * `releases/current` symlink yet: without it, there would be nothing safe
   * to journal as `executorRelease` for a first update, and a crash after
   * the symlink flip would have nowhere trustworthy to resume from except
   * the very candidate release being installed — exactly what this option
   * exists to rule out (issue #43 review follow-up). Ignored once
   * `releases/current` already exists. `update-cli.ts` is expected to pass
   * this from an environment variable such as `VEDUTA_LEGACY_ROOT`.
   */
  legacyRoot?: string
}

/** Shared by `resumeUpdateTransaction`, `finalizeUpdate`, and `rollbackUpdate` — none of them need `marker`, since a live journal already carries its own copy once a transaction has started. */
export type ResumeOptions = Omit<UpdateTransactionOptions, 'marker'>

interface Ctx {
  home: UpdateHome
  dataRootDir: string
  pinning: UpdatePinning
  installedVersion: string
  installedDataVersion: number
  keyMaterial: Buffer
  ports: Ports
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}

function contextFrom(options: ResumeOptions, log: (line: string) => void): Ctx {
  return {
    home: options.home,
    dataRootDir: options.dataRootDir,
    pinning: options.pinning,
    installedVersion: options.installedVersion,
    installedDataVersion: options.installedDataVersion,
    keyMaterial: options.keyMaterial,
    ports: options.ports,
    env: options.env ?? process.env,
    log,
  }
}

export type TransactionOutcome =
  { status: 'terminal'; result: UpdateResult } | { status: 'awaiting-stage-2'; releaseDir: string }

export type ResumeOutcome = TransactionOutcome | { status: 'nothing-to-resume' }

// ---------------------------------------------------------------------------
// Stage: download + verify + extract the release artifact
// ---------------------------------------------------------------------------

/**
 * Clears a leftover `releases/vX.Y.Z` directory before extraction (issue #43
 * review follow-up): `extractVerifiedArchive` refuses an existing `destDir`
 * by design (`tar-reader.ts`'s TOCTOU guard — correct, since a symlink or
 * file could otherwise race into the destination between preflight and
 * extraction), but that means a leftover directory from a crash between
 * extraction and the `staged` journal write, or from a rolled-back release
 * whose tree is deliberately kept for forensics
 * (`docs/adr/0013-signed-self-update.md`), would wedge every future retry of
 * that exact version forever — exactly the SSH-required failure mode
 * `issues/043-self-update.md`'s Goal rules out. Refuses to clear the
 * directory if it is the resolved target of `releases/current`: that would
 * mean deleting the release actually running right now, which should never
 * happen given `checkMonotonic`'s guard, but is cheap to assert defensively.
 */
function clearStaleReleaseDir(home: UpdateHome, releaseDir: string): void {
  if (!existsSync(releaseDir)) return
  const currentTarget = existsSync(home.currentSymlink)
    ? realpathSync(home.currentSymlink)
    : undefined
  if (currentTarget !== undefined && resolve(releaseDir) === currentTarget) {
    throw new Error(
      `refusing to clear release directory ${releaseDir}: it is the currently running release`,
    )
  }
  rmSync(releaseDir, { recursive: true, force: true })
}

async function stageRelease(
  ctx: Ctx,
  journal: Journal,
): Promise<{ releaseDir: string; runtimeDirName: string }> {
  const { release, marker } = journal
  const feedHost = new URL(ctx.pinning.feedUrl).hostname

  markProgress(ctx, 'download', 'running')
  const artifactBytes = await fetchChecked(
    ctx.ports,
    marker.artifactUrl,
    feedHost,
    release.artifactSize,
    'release artifact',
  )
  markProgress(ctx, 'download', 'done')
  writeJournal(ctx.home, { ...journal, phase: 'downloaded' })
  ctx.log(`artifact downloaded (${artifactBytes.length} bytes)`)
  maybeTestStop('downloaded', ctx.env)

  markProgress(ctx, 'verify', 'running')
  const actualHash = createHash('sha256').update(artifactBytes).digest('hex')
  if (actualHash !== release.sha256) {
    throw new Error(`artifact sha256 mismatch: expected ${release.sha256}, got ${actualHash}`)
  }
  if (artifactBytes.length !== release.artifactSize) {
    throw new Error(
      `artifact size mismatch: expected ${release.artifactSize} bytes, got ${artifactBytes.length}`,
    )
  }
  markProgress(ctx, 'verify', 'done')
  writeJournal(ctx.home, { ...journal, phase: 'verified' })
  ctx.log('artifact hash and size verified against the signed release metadata')
  maybeTestStop('verified', ctx.env)

  const tmpTarPath = join(
    ctx.home.tmpDir,
    `artifact-${release.version}-${randomBytes(6).toString('hex')}.tar.gz`,
  )
  writeFileSync(tmpTarPath, artifactBytes)
  const releaseDir = join(ctx.home.releasesDir, `v${release.version}`)
  try {
    markProgress(ctx, 'stage', 'running')
    clearStaleReleaseDir(ctx.home, releaseDir)
    await extractVerifiedArchive({
      filePath: tmpTarPath,
      destDir: releaseDir,
      policy: { maxEntries: release.entryCount, maxUnpackedBytes: release.unpackedSize },
    })
    markProgress(ctx, 'stage', 'done')

    markProgress(ctx, 'runtime', 'running')
    const { runtimeDirName } = await ensureRuntime(ctx, release)
    markProgress(ctx, 'runtime', 'done')

    writeFileSync(join(releaseDir, 'RUNTIME'), `${runtimeDirName}\n`)
    return { releaseDir, runtimeDirName }
  } finally {
    rmSync(tmpTarPath, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Migrate + flip + stage-1 health
// ---------------------------------------------------------------------------

function daemonDirOf(releaseDir: string): string {
  return join(releaseDir, 'packages', 'daemon')
}

function tsxBinOf(releaseDir: string): string {
  return join(daemonDirOf(releaseDir), 'node_modules', '.bin', 'tsx')
}

/**
 * Runs the new release's own migrate CLI (it owns the target schema; this
 * transaction is still executing as the *old* release —
 * `docs/adr/0013-signed-self-update.md`). A missing migrate CLI is only
 * tolerated when there is nothing to migrate (`release.dataVersion` equals
 * what is already installed — the common case for a code-only release);
 * otherwise a missing migrate CLI is a hard failure, since data would
 * silently stay on the old schema under new code.
 */
async function runMigrationStep(
  ctx: Ctx,
  release: ReleaseMetadata,
  releaseDir: string,
): Promise<void> {
  const forcedFail =
    ctx.env['VEDUTA_UPDATE_TEST_KNOBS'] === '1' && ctx.env['VEDUTA_TEST_FAIL_MIGRATION'] === '1'
  if (forcedFail) {
    throw new Error(
      'migration failed: VEDUTA_TEST_FAIL_MIGRATION forced failure — harness-only failure ' +
        'injection for issues/043-self-update.md AC3',
    )
  }

  const daemonDir = daemonDirOf(releaseDir)
  const tsxBin = tsxBinOf(releaseDir)
  if (!existsSync(tsxBin)) {
    if (release.dataVersion === ctx.installedDataVersion) {
      ctx.log(
        `migrate-cli not present at ${tsxBin}; dataVersion unchanged at ${ctx.installedDataVersion} — nothing to migrate`,
      )
      return
    }
    throw new Error(
      `migrate-cli missing at ${tsxBin} but dataVersion must change ${ctx.installedDataVersion} -> ${release.dataVersion}`,
    )
  }

  const result = await ctx.ports.execFile(
    tsxBin,
    ['src/update/migrate-cli.ts', '--root', ctx.dataRootDir, '--to', String(release.dataVersion)],
    { cwd: daemonDir, env: ctx.env },
  )
  ctx.log(`migrate-cli stdout: ${result.stdout}`)
  ctx.log(`migrate-cli stderr: ${result.stderr}`)
  if (result.code !== 0) {
    throw new Error(`migration failed: migrate-cli exited with code ${result.code}`)
  }
}

/** Atomic symlink flip: write a temp symlink, then rename it over `releases/current` — the rename itself is what makes this atomic, `docs/adr/0013-signed-self-update.md`. */
function flipCurrent(home: UpdateHome, targetReleaseDir: string): void {
  const tmpLink = join(home.releasesDir, '.current.tmp')
  rmSync(tmpLink, { force: true })
  symlinkSync(targetReleaseDir, tmpLink)
  renameSync(tmpLink, home.currentSymlink)
  const dirFd = openSync(home.releasesDir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Stage 1 of the two-stage health check (`self-check.ts`, `docs/adr/0013-signed-self-update.md`): hermetic and read-only, run out of process via the new release's own `--self-check` entry point. */
async function runSelfCheckStep(
  ctx: Ctx,
  releaseDir: string,
): Promise<{ ok: boolean; detail: string }> {
  const daemonDir = daemonDirOf(releaseDir)
  const tsxBin = tsxBinOf(releaseDir)
  const mergedEnv: NodeJS.ProcessEnv = { ...ctx.env, VEDUTA_DATA_DIR: ctx.dataRootDir }
  const result = await ctx.ports.execFile(tsxBin, ['src/index.ts', '--self-check'], {
    cwd: daemonDir,
    env: mergedEnv,
  })
  ctx.log(`self-check stdout: ${result.stdout}`)
  ctx.log(`self-check stderr: ${result.stderr}`)
  return {
    ok: result.code === 0,
    detail: result.stderr || result.stdout || `exit code ${result.code}`,
  }
}

// ---------------------------------------------------------------------------
// Rollback — data-moved-aside -> restored -> flipped-back -> done
// ---------------------------------------------------------------------------

/**
 * Each step below is genuinely idempotent (issue #43 review follow-up): it
 * is skipped outright once the *persisted* substate this call started with
 * (`priorSubstateIndex`, fixed at entry — never the locally-mutated
 * `journal`) already recorded it as done, and otherwise guarded by a
 * filesystem-existence check for the crash-mid-step case. Skipping by
 * substate (not only by existence) matters specifically for the
 * move-aside step: once `restored` (or later) has been recorded, `dataRoot`
 * exists again holding the *restored* backup, not the original failed data —
 * re-running move-aside purely off `existsSync(dataRoot)` would attempt to
 * rename that restored data onto the already-populated `failedDataDir` from
 * the earlier attempt and fail with `ENOTEMPTY`. The failed release's own
 * tree and log are never touched here: they are kept on disk for forensics,
 * per the same source (`docs/adr/0013-signed-self-update.md`).
 */
async function performRollback(ctx: Ctx, journalIn: Journal): Promise<Journal> {
  let journal = journalIn
  const dataRoot = resolve(ctx.dataRootDir)
  const priorSubstateIndex =
    journal.rollback !== undefined ? rollbackSubstateIndex(journal.rollback.substate) : -1

  let failedDataDir = journal.rollback?.failedDataDir
  if (failedDataDir === undefined) {
    failedDataDir = `${dataRoot}.failed-${journal.toVersion}-${isoForFilename(ctx.ports.now())}`
  }

  if (priorSubstateIndex < rollbackSubstateIndex('restored')) {
    journal = writeJournal(ctx.home, {
      ...journal,
      rollback: { substate: 'data-moved-aside', failedDataDir },
    })
    if (existsSync(dataRoot)) {
      renameSync(dataRoot, failedDataDir)
    }
    ctx.log(`rollback: data root moved aside to ${failedDataDir}`)
  }

  if (priorSubstateIndex < rollbackSubstateIndex('flipped-back')) {
    journal = writeJournal(ctx.home, {
      ...journal,
      rollback: { substate: 'restored', failedDataDir },
    })
    const restoreTmp = `${dataRoot}.restore-tmp`
    if (!existsSync(dataRoot)) {
      if (journal.backupFile === undefined) {
        throw new Error('rollback: no backup file recorded in the journal to restore from')
      }
      // restoreBackup extracts incrementally (backup.ts) — a crash
      // mid-extraction can leave restoreTmp partially populated. Always
      // clear it before restoring: restoring from the backup file is
      // idempotent and cheap, and a partial restoreTmp must never be
      // renamed into place as if it were complete (that would silently
      // install a truncated data root while this transaction still reports
      // 'rolled-back').
      rmSync(restoreTmp, { recursive: true, force: true })
      await restoreBackup({
        file: journal.backupFile,
        targetRootDir: restoreTmp,
        keyMaterial: ctx.keyMaterial,
        workDir: ctx.home.tmpDir,
      })
      renameSync(restoreTmp, dataRoot)
    }
    ctx.log('rollback: pre-update backup restored')
  }

  if (priorSubstateIndex < rollbackSubstateIndex('done')) {
    journal = writeJournal(ctx.home, {
      ...journal,
      rollback: { substate: 'flipped-back', failedDataDir },
    })
    if (journal.phase === 'switched' || journal.phase === 'serving-check') {
      if (journal.hadPriorRelease && journal.executorRelease !== '') {
        flipCurrent(ctx.home, journal.executorRelease)
        ctx.log(`rollback: current flipped back to ${journal.executorRelease}`)
      } else if (existsSync(ctx.home.currentSymlink)) {
        // A first update has no previous release to flip back to —
        // `executorRelease` only holds the legacy checkout, which is never
        // a valid `releases/vX.Y.Z` target for `current` (issue #43 review
        // follow-up). Removing the symlink outright, rather than leaving it
        // pointing at the just-failed candidate release, is what makes the
        // wrapper fall back to running the legacy checkout again — the
        // same place the system served from before this transaction
        // started. Idempotent: a re-entry after the symlink is already gone
        // is a no-op. `recursive: true` only satisfies `rmSync`'s own
        // type-check on a symlink whose target is a directory (otherwise it
        // throws "Path is a directory") — it never actually recurses into
        // the target: only the symlink itself is unlinked, the release
        // directory it pointed at is untouched.
        rmSync(ctx.home.currentSymlink, { force: true, recursive: true })
        ctx.log(
          'rollback: no prior release to flip back to (first update); current symlink removed',
        )
      }
    }
  }

  journal = writeJournal(ctx.home, { ...journal, rollback: { substate: 'done', failedDataDir } })
  return journal
}

// ---------------------------------------------------------------------------
// Terminal publication (uniform across success / refused / rolled-back)
// ---------------------------------------------------------------------------

interface PublishResultInput {
  ctx: Ctx
  journal: Journal
  outcome: 'success' | 'refused' | 'rolled-back'
  reason: string
  failedStage?: string
  newReleaseDir: string | undefined
}

/**
 * The terminal-publication sequence shared by every outcome
 * (`docs/adr/0013-signed-self-update.md`): write `result.json` first (the
 * outcome exists only from this point on), then success-only idempotent
 * housekeeping, then archive the journal — a single rename that is the
 * actual commit point retiring executor pinning for every outcome alike.
 */
async function publishResult(input: PublishResultInput): Promise<UpdateResult> {
  const { ctx, journal, outcome, reason, newReleaseDir } = input
  const result: UpdateResult = {
    id: randomUUID(),
    outcome,
    fromVersion: journal.fromVersion,
    toVersion: journal.toVersion,
    reason,
    finishedAt: ctx.ports.now().toISOString(),
    ...(input.failedStage !== undefined ? { failedStage: input.failedStage } : {}),
  }
  writeJsonAtomic(resultPath(ctx.home), result)
  ctx.log(`result published: ${outcome}${reason ? ` (${reason})` : ''}`)
  maybeTestStop('result-written', ctx.env)

  if (outcome === 'success' && newReleaseDir !== undefined) {
    runSuccessHousekeeping(ctx.home, newReleaseDir)
    markProgress(ctx, 'finalize', 'done')
  }

  archiveJournal(ctx.home, journal.toVersion, ctx.ports.now())
  return result
}

// ---------------------------------------------------------------------------
// Forward execution, shared by a fresh run and every resumable phase
// ---------------------------------------------------------------------------

async function terminateRefused(
  ctx: Ctx,
  journal: Journal,
  reason: string,
  failedStage: string,
): Promise<TransactionOutcome> {
  const result = await publishResult({
    ctx,
    journal,
    outcome: 'refused',
    reason,
    failedStage,
    newReleaseDir: undefined,
  })
  return { status: 'terminal', result }
}

async function terminateRolledBack(
  ctx: Ctx,
  journal: Journal,
  reason: string,
  failedStage: string,
): Promise<TransactionOutcome> {
  const rolledJournal = await performRollback(ctx, journal)
  const result = await publishResult({
    ctx,
    journal: rolledJournal,
    outcome: 'rolled-back',
    reason,
    failedStage,
    newReleaseDir: undefined,
  })
  return { status: 'terminal', result }
}

/**
 * Runs (or resumes) every phase from `journal.phase` onward. Two skip
 * points carry the whole resume story: stage work (download/verify/extract)
 * is skipped once `staged` is already reached, and backup+migrate are
 * skipped once `migrated` is already reached — both checked purely by phase
 * order, so a fresh run (phase `started`) and a resumed one converge on the
 * same code path (`docs/adr/0013-signed-self-update.md`'s crash/resume
 * rules). Once execution reaches `backup-done` or later, any failure from
 * here on goes through rollback, never a plain refusal — the data root may
 * already be mutated by then.
 */
async function runFromJournal(ctx: Ctx, initialJournal: Journal): Promise<TransactionOutcome> {
  let journal = initialJournal
  try {
    if (phaseIndex(journal.phase) <= phaseIndex('started')) {
      verifyReleaseChain({
        releaseBytes: Buffer.from(journal.marker.release, 'base64'),
        releaseSigText: journal.marker.releaseSig,
        signingKeyText: journal.marker.signingKey.pub,
        signingKeyRootSigText: journal.marker.signingKey.rootSig,
        rootPublicKeyText: ctx.pinning.rootPublicKey,
        expectedArtifactName: journal.release.artifactName,
        expectedSigningKeyId: journal.marker.signingKey.keyId,
      })
      checkMonotonic({
        offeredVersion: journal.release.version,
        installedVersion: ctx.installedVersion,
        offeredDataVersion: journal.release.dataVersion,
        installedDataVersion: ctx.installedDataVersion,
      })
      ctx.log('release chain verified; offered version/dataVersion are monotonic')

      markProgress(ctx, 'guardrail', 'running')
      const runtimeDir = join(ctx.home.runtimesDir, computeRuntimeDirName(journal.release))
      const needsRuntime = !existsSync(runtimeDir)
      const guardrail = await checkDiskGuardrail(ctx, journal.release, needsRuntime)
      if (!guardrail.ok) {
        markProgress(ctx, 'guardrail', 'failed')
        return await terminateRefused(ctx, journal, guardrail.message, 'guardrail')
      }
      markProgress(ctx, 'guardrail', 'done')
    }

    if (phaseIndex(journal.phase) < phaseIndex('staged')) {
      const staged = await stageRelease(ctx, journal)
      journal = writeJournal(ctx.home, {
        ...journal,
        phase: 'staged',
        releaseDir: staged.releaseDir,
        runtimeDirName: staged.runtimeDirName,
      })
      ctx.log(`release staged at ${staged.releaseDir}`)
      maybeTestStop('staged', ctx.env)
    }

    if (journal.releaseDir === undefined) {
      throw new Error('internal error: releaseDir missing after the stage phase')
    }
    const releaseDir = journal.releaseDir

    if (phaseIndex(journal.phase) < phaseIndex('migrated')) {
      markProgress(ctx, 'backup', 'running')
      const backupFile = await createBackup({
        rootDir: ctx.dataRootDir,
        outDir: ctx.home.backupsDir,
        keyMaterial: ctx.keyMaterial,
        workDir: ctx.home.tmpDir,
        now: ctx.ports.now,
      })
      markProgress(ctx, 'backup', 'done')
      journal = writeJournal(ctx.home, { ...journal, phase: 'backup-done', backupFile })
      ctx.log(`backup created at ${backupFile}`)
      maybeTestStop('backup-done', ctx.env)

      journal = writeJournal(ctx.home, { ...journal, phase: 'migrating' })
      maybeTestStop('migrating', ctx.env)

      markProgress(ctx, 'migrate', 'running')
      await runMigrationStep(ctx, journal.release, releaseDir)
      markProgress(ctx, 'migrate', 'done')

      journal = writeJournal(ctx.home, { ...journal, phase: 'migrated' })
      ctx.log('migration complete')
      maybeTestStop('migrated', ctx.env)
    }

    if (phaseIndex(journal.phase) < phaseIndex('switched')) {
      markProgress(ctx, 'switch', 'running')
      flipCurrent(ctx.home, releaseDir)
      markProgress(ctx, 'switch', 'done')
      journal = writeJournal(ctx.home, { ...journal, phase: 'switched' })
      ctx.log(`current flipped to ${releaseDir}`)
      maybeTestStop('switched', ctx.env)
    }

    // Stage-1 health always re-runs, even resuming from `serving-check`
    // itself: it is cheap and read-only, and the point of the crash/resume
    // rule is to never trust a pass recorded before a crash without
    // reconfirming it.
    markProgress(ctx, 'health', 'running')
    const health = await runSelfCheckStep(ctx, releaseDir)
    if (!health.ok) {
      markProgress(ctx, 'health', 'failed')
      return await terminateRolledBack(
        ctx,
        journal,
        `stage-1 self-check failed: ${health.detail}`,
        'health',
      )
    }
    markProgress(ctx, 'health', 'done')
    journal = writeJournal(ctx.home, { ...journal, phase: 'serving-check' })
    ctx.log('stage-1 self-check passed; awaiting stage 2 (the wrapper starting the real daemon)')
    maybeTestStop('serving-check', ctx.env)

    return { status: 'awaiting-stage-2', releaseDir }
  } catch (error) {
    if (error instanceof UpdateTransactionStoppedError) throw error
    const reachedBackupOrLater = phaseIndex(journal.phase) >= phaseIndex('backup-done')
    const failedStage = journal.phase
    if (reachedBackupOrLater) {
      return await terminateRolledBack(ctx, journal, messageOf(error), failedStage)
    }
    return await terminateRefused(ctx, journal, messageOf(error), failedStage)
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Starts a brand-new update transaction from a freshly verified marker.
 * Throws if a journal is already active with no matching leftover marker
 * file — the caller (`deploy/veduta-run`, via `update-cli.ts`) is expected to
 * call `resumeUpdateTransaction` in that case. When a journal AND a leftover
 * `state/marker.json` are both found, the journal wins (issue #43 review
 * follow-up): that combination means a previous run wrote the durable
 * journal and then crashed before consuming the marker file (see the ordering
 * note below), so this call degrades into a resume of the already-started
 * transaction rather than throwing.
 */
export async function runUpdateTransaction(
  options: UpdateTransactionOptions,
): Promise<TransactionOutcome> {
  const { home } = options
  ensureUpdateHomeLayout(home)
  const env = options.env ?? process.env
  if (existsSync(journalPath(home))) {
    if (!existsSync(markerPath(home))) {
      throw new Error(
        'runUpdateTransaction: an update journal is already active; call resumeUpdateTransaction instead',
      )
    }
    consumeMarkerFileIfPresent(home, options.ports.now())
    const resumed = await resumeUpdateTransaction(options)
    if (resumed.status === 'nothing-to-resume') {
      // Unreachable: the journal existed a few lines above, and only this
      // process retires it. Surfacing it as an error beats returning a status
      // the caller's type does not admit.
      throw new Error('runUpdateTransaction: the active update journal vanished mid-resume')
    }
    return resumed
  }

  const releaseBytes = Buffer.from(options.marker.release, 'base64')
  let releaseJson: unknown
  try {
    releaseJson = JSON.parse(releaseBytes.toString('utf8'))
  } catch (cause) {
    throw new Error(`malformed release metadata in marker: ${messageOf(cause)}`)
  }
  const releaseParsed = ReleaseMetadataSchema.safeParse(releaseJson)
  if (!releaseParsed.success) {
    throw new Error(`malformed release metadata in marker: ${releaseParsed.error.message}`)
  }
  const release = releaseParsed.data

  const now = options.ports.now()
  const hadPriorRelease = existsSync(home.currentSymlink)
  const executorRelease = hadPriorRelease ? realpathSync(home.currentSymlink) : options.legacyRoot
  if (executorRelease === undefined || executorRelease.length === 0) {
    throw new Error(
      'runUpdateTransaction: releases/current does not exist yet (this is the first update) and ' +
        'no legacyRoot was provided; the caller (update-cli.ts) must pass the legacy checkout ' +
        'path so crash recovery never treats the candidate release as its own executor',
    )
  }

  let journal: Journal = {
    phase: 'started',
    toVersion: release.version,
    fromVersion: options.installedVersion,
    executorRelease,
    hadPriorRelease,
    release,
    marker: options.marker,
    startedAt: now.toISOString(),
  }
  // Reset progress and write the journal BEFORE consuming state/marker.json
  // (issue #43 review follow-up): the journal write is fsynced and is the
  // durable record of "this transaction has started" — consuming (renaming
  // away) the marker only after that write means a crash in between leaves
  // both the journal and the marker on disk, a well-defined state the branch
  // above resolves by letting the journal win, rather than leaving neither
  // an actionable marker nor a journal/result on disk.
  resetProgress(home)
  journal = writeJournal(home, journal)
  consumeMarkerFileIfPresent(home, now)
  const log = makeLogger(home, release.version, options.ports)
  log(`update transaction started: ${options.installedVersion} -> ${release.version}`)
  maybeTestStop('started', env)

  const ctx = contextFrom(options, log)
  return runFromJournal(ctx, journal)
}

/**
 * Re-enters an in-progress transaction after a restart, following the
 * crash/resume rules exactly (`docs/adr/0013-signed-self-update.md`):
 * a result already published but not yet archived only redoes the
 * (idempotent) archive step, never the transaction itself; a crash
 * mid-rollback always continues (never abandons) the rollback, never
 * marching forward through the phase machine; `backup-done`/`migrating`
 * with no rollback yet under way always roll back (a half-migrated data root
 * is never blind-resumed); every other phase continues forward from where
 * the journal says it left off.
 */
export async function resumeUpdateTransaction(options: ResumeOptions): Promise<ResumeOutcome> {
  const { home } = options
  ensureUpdateHomeLayout(home)
  const journal = readJournal(home)
  if (journal === undefined) return { status: 'nothing-to-resume' }

  const log = makeLogger(home, journal.release.version, options.ports)
  const ctx = contextFrom(options, log)

  if (existsSync(resultPath(home))) {
    const result = UpdateResultSchema.parse(JSON.parse(readFileSync(resultPath(home), 'utf8')))
    if (result.outcome === 'success' && journal.releaseDir !== undefined) {
      runSuccessHousekeeping(home, journal.releaseDir)
    }
    archiveJournal(home, journal.toVersion, options.ports.now())
    ctx.log(
      `resumed after an interrupted finalize: republished result ${result.outcome}, archive completed`,
    )
    return { status: 'terminal', result }
  }

  // A crash mid-rollback must always resume (never abandon) the rollback
  // itself — marching forward through the phase machine instead (issue #43
  // review follow-up) could re-run the health check against a moved-aside or
  // freshly-restored data root and silently discard the earlier rollback
  // decision. `performRollback` is idempotent from any of its substates, so
  // this always converges on the same 'rolled-back' terminal a fresh
  // rollback from this journal would have reached.
  if (journal.rollback !== undefined) {
    const rolledJournal = await performRollback(ctx, journal)
    const result = await publishResult({
      ctx,
      journal: rolledJournal,
      outcome: 'rolled-back',
      reason: 'resumed after an interrupted rollback; rollback completed',
      failedStage: journal.phase,
      newReleaseDir: undefined,
    })
    return { status: 'terminal', result }
  }

  if (journal.phase === 'backup-done' || journal.phase === 'migrating') {
    return terminateRolledBack(
      ctx,
      journal,
      'resumed after an interrupted update with the data root in an unknown state; rolled back for safety',
      journal.phase,
    )
  }

  return runFromJournal(ctx, journal)
}

/**
 * Called by `deploy/veduta-run` (via `update-cli.ts`'s `finalize` mode) once
 * its own stage-2 check (starting the real daemon and confirming it actually
 * serves) has passed. Publishes the `success` terminal result and runs the
 * success-only housekeeping (prune, wrapper self-update, journal archive).
 */
export async function finalizeUpdate(options: ResumeOptions): Promise<UpdateResult> {
  const { home } = options
  ensureUpdateHomeLayout(home)
  const journal = readJournal(home)
  if (journal === undefined) throw new Error('finalizeUpdate: no active update journal found')
  if (journal.releaseDir === undefined) {
    throw new Error('finalizeUpdate: journal has no staged release directory')
  }
  const log = makeLogger(home, journal.release.version, options.ports)
  const ctx = contextFrom(options, log)
  return publishResult({
    ctx,
    journal,
    outcome: 'success',
    reason: '',
    newReleaseDir: journal.releaseDir,
  })
}

/**
 * Called by `deploy/veduta-run` (via `update-cli.ts`'s `rollback` mode) when
 * its own stage-2 check fails, or by this module internally when stage-1 (or
 * an earlier, data-mutating phase) fails. Runs the full rollback sequence
 * and publishes the `rolled-back` terminal result.
 */
export async function rollbackUpdate(
  options: ResumeOptions,
  reason: string,
  failedStage?: string,
): Promise<UpdateResult> {
  const { home } = options
  ensureUpdateHomeLayout(home)
  const journal = readJournal(home)
  if (journal === undefined) throw new Error('rollbackUpdate: no active update journal found')
  const log = makeLogger(home, journal.release.version, options.ports)
  const ctx = contextFrom(options, log)
  const rolledJournal = await performRollback(ctx, journal)
  return publishResult({
    ctx,
    journal: rolledJournal,
    outcome: 'rolled-back',
    reason,
    ...(failedStage !== undefined ? { failedStage } : {}),
    newReleaseDir: undefined,
  })
}

/**
 * Archives `result.json` (and its ack marker) to `state/history/` once the
 * daemon has durably acknowledged ingesting the outcome
 * (`docs/adr/0013-signed-self-update.md`): the ack contract itself —
 * appending the `update.outcome` System Space event, then durably creating
 * the `result-acked-<id>` marker file this function waits for — is
 * `update-manager.ts`'s `UpdateManager`. Only acts when no journal is
 * active — an in-progress transaction owns `result.json` housekeeping itself
 * via `publishResult`/`resumeUpdateTransaction`.
 */
export function sweepAckedResult(home: UpdateHome): boolean {
  const rPath = resultPath(home)
  if (!existsSync(rPath)) return false
  if (existsSync(journalPath(home))) return false

  const parsed = UpdateResultSchema.safeParse(JSON.parse(readFileSync(rPath, 'utf8')))
  if (!parsed.success) return false
  const result = parsed.data
  const ackPath = join(home.stateDir, `result-acked-${result.id}`)
  if (!existsSync(ackPath)) return false

  mkdirSync(home.historyDir, { recursive: true })
  const ts = isoForFilename(new Date())
  renameSync(rPath, join(home.historyDir, `${ts}-${result.toVersion}-result.json`))
  renameSync(ackPath, join(home.historyDir, `${ts}-${result.toVersion}-result-acked-${result.id}`))
  // `update-manager.ts`'s own notify-dedupe marker (issue #43 review
  // follow-up) has no forensic value once the result it guarded is itself
  // archived — left behind, it would accumulate in `state/` forever.
  const notifiedPath = join(home.stateDir, `result-notified-${result.id}`)
  if (existsSync(notifiedPath)) rmSync(notifiedPath, { force: true })
  return true
}
