import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
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
import { createBackup, pruneBackups, restoreBackup } from '../backup.ts'
import { compareVersions } from '../version.ts'
import { checkMonotonic, verifyReleaseChain } from './minisign.ts'
import { extractVerifiedArchive } from './tar-reader.ts'

/**
 * The recoverable update transaction (issue #43,
 * `docs/adr/0013-signed-self-update.md` and its "Amendments" section): the
 * on-disk state machine a later CLI/wrapper task drives to take a verified
 * release from "offered" to "serving", with a journaled rollback path so a
 * crash at any point is resumed or reverted on the next start rather than
 * ever leaving old code running against migrated data.
 *
 * Scope: this module owns the transaction itself — verify, disk guardrail,
 * download, stage, backup, migrate, flip, and stage-1 (hermetic) health —
 * plus the uniform terminal-publication sequence (`result.json`, success
 * housekeeping, journal archive) shared by every outcome. Stage 2 (starting
 * the real daemon and waiting for it to actually serve) is the wrapper's
 * job, built in a later task; this module exposes `finalizeUpdate` and
 * `rollbackUpdate` for that wrapper to call once it has made its own
 * judgment about stage 2.
 */

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
// Ports (dependency injection)
// ---------------------------------------------------------------------------

export interface FetchBytesOptions {
  maxBytes: number
}

export interface FetchBytesResult {
  status: number
  bytes: Buffer
}

export interface ExecFileOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ExecFileResult {
  code: number
  stdout: string
  stderr: string
}

export interface StatfsResult {
  bavail: number
  bsize: number
}

/**
 * Everything the transaction needs from the outside world, injected so unit
 * tests never touch a real network, a real disk-space check, or a real
 * subprocess for the new release's own migrate/self-check entry points.
 * `defaultPorts()` below is the production wiring.
 */
export interface Ports {
  /**
   * Fetches `url` in full, capped at `maxBytes`. Production implementations
   * are expected to follow only same-host redirects, to a bounded depth —
   * the caller (this module) separately enforces https-only-except-loopback
   * and pinned-host matching on the *initial* URL before ever calling this.
   */
  fetchBytes(url: string, opts: FetchBytesOptions): Promise<FetchBytesResult>
  execFile(cmd: string, args: string[], opts?: ExecFileOptions): Promise<ExecFileResult>
  /** Wraps `node:fs` `statfsSync` — free-space accounting for the disk guardrail. */
  statfs(path: string): StatfsResult
  /** A `du -sk`-equivalent recursive size of `path`, in bytes. */
  diskUsage(path: string): Promise<number>
  now(): Date
  /** Appends `line` to whatever sink the caller wants (production: also `state/logs/<version>.log`, teed by this module itself; tests: typically a capture array). */
  log(line: string): void
}

const execFileAsync = promisify(execFile)

/** Production `Ports`: real network fetch (https-only except loopback, manual same-host redirects, depth-capped), real `execFile`, real `statfs`/disk-usage walk. */
export function defaultPorts(): Ports {
  return {
    fetchBytes: (url, opts) => fetchOnce(url, opts.maxBytes, 0),
    execFile: async (cmd, args, opts) => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
          maxBuffer: 64 * 1024 * 1024,
        })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
        const code = typeof e.code === 'number' ? e.code : 1
        return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }
      }
    },
    statfs: (path) => {
      const s = statfsSync(path)
      return { bavail: s.bavail, bsize: s.bsize }
    },
    diskUsage: (path) => Promise.resolve(walkDiskUsage(path)),
    now: () => new Date(),
    log: (line) => {
      process.stderr.write(`${line}\n`)
    },
  }
}

const MAX_REDIRECT_DEPTH = 3

function fetchOnce(urlText: string, maxBytes: number, depth: number): Promise<FetchBytesResult> {
  return new Promise((resolvePromise, reject) => {
    let url: URL
    try {
      url = new URL(urlText)
    } catch (cause) {
      reject(new Error(`malformed URL: ${urlText}: ${messageOf(cause)}`))
      return
    }
    const mod = url.protocol === 'http:' ? http : https
    const req = mod.get(url, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location !== undefined) {
        res.resume()
        if (depth >= MAX_REDIRECT_DEPTH) {
          reject(new Error(`too many redirects fetching ${urlText}`))
          return
        }
        let redirectUrl: URL
        try {
          redirectUrl = new URL(location, url)
        } catch (cause) {
          reject(new Error(`malformed redirect Location fetching ${urlText}: ${messageOf(cause)}`))
          return
        }
        if (redirectUrl.hostname !== url.hostname) {
          reject(
            new Error(`refusing a cross-host redirect: ${url.hostname} -> ${redirectUrl.hostname}`),
          )
          return
        }
        resolvePromise(fetchOnce(redirectUrl.href, maxBytes, depth + 1))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          req.destroy()
          reject(
            new Error(`response for ${urlText} exceeded the maximum allowed ${maxBytes} bytes`),
          )
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolvePromise({ status, bytes: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

function walkDiskUsage(rootPath: string): number {
  let total = 0
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) continue
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        total += statSync(full).size
      } catch {
        // A file disappearing mid-walk (a concurrent writer) is tolerated —
        // this is an approximation for the disk guardrail, not an audit.
      }
    }
  }
  return total
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

const RollbackSubstateSchema = z.enum(['data-moved-aside', 'restored', 'flipped-back', 'done'])
export type RollbackSubstate = z.infer<typeof RollbackSubstateSchema>

const JournalSchema = z.object({
  phase: z.enum(PHASE_ORDER),
  toVersion: z.string().min(1),
  fromVersion: z.string().min(1),
  /** Absolute path of the release currently running this transaction — where the wrapper (a later task) must exec the updater CLI from if it needs to resume, never the new release. */
  executorRelease: z.string(),
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

/** Consumes `state/marker.json` if present, as part of writing the transaction's first (`started`) journal entry — so no crash or retry can ever re-read the same marker twice. The marker file itself is written by a later CLI task; this module tolerates its absence (the marker's content is already handed in as `options.marker`). */
function consumeMarkerFileIfPresent(home: UpdateHome, now: Date): void {
  const markerPath = join(home.stateDir, 'marker.json')
  if (!existsSync(markerPath)) return
  renameSync(markerPath, join(home.stateDir, `.marker-consumed-${isoForFilename(now)}.json`))
}

// ---------------------------------------------------------------------------
// Atomic JSON writes (tmp + fsync + rename + directory fsync)
// ---------------------------------------------------------------------------

function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(tmpPath, { force: true })
    throw error
  }
  closeSync(fd)
  renameSync(tmpPath, path)
  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

function writeJsonAtomicBestEffort(path: string, data: unknown): void {
  try {
    writeJsonAtomic(path, data)
  } catch {
    // progress.json is post-hoc reporting only (`docs/adr/0013-signed-self-update.md`) — a failure here must never fail the transaction itself.
  }
}

/** Filesystem-safe ISO timestamp: colons become dashes, uniformly, so lexical order still matches chronological order (mirrors `backup.ts`'s `isoForFilename`). */
function isoForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
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

function readOrInitProgress(home: UpdateHome): UpdateProgress {
  const path = progressPath(home)
  if (existsSync(path)) {
    const parsed = UpdateProgressSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
  }
  return {
    protocol_version: 1,
    stages: Object.keys(PROGRESS_STAGE_TITLES).map((id) => ({
      id,
      title: PROGRESS_STAGE_TITLES[id] ?? id,
      status: 'pending',
    })),
  }
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
// Network/host discipline
// ---------------------------------------------------------------------------

function assertHttpsOrLoopback(url: URL): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '::1')) return
  throw new Error(`refusing a non-https URL from a non-loopback host: ${url.href}`)
}

function assertSameHost(url: URL, allowedHost: string, what: string): void {
  if (url.hostname !== allowedHost) {
    throw new Error(
      `${what} host '${url.hostname}' does not match the pinned host '${allowedHost}'`,
    )
  }
}

async function fetchChecked(
  ports: Ports,
  urlText: string,
  allowedHost: string,
  maxBytes: number,
  what: string,
): Promise<Buffer> {
  const url = new URL(urlText)
  assertHttpsOrLoopback(url)
  assertSameHost(url, allowedHost, what)
  const result = await ports.fetchBytes(urlText, { maxBytes })
  if (result.status !== 200) {
    throw new Error(`${what} fetch failed: HTTP ${result.status} from ${urlText}`)
  }
  return result.bytes
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
// Runtime (Node) ensure — AC6
// ---------------------------------------------------------------------------

function normalizeNodeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}

function computeRuntimeDirName(release: ReleaseMetadata): string {
  return `node-v${normalizeNodeVersion(release.nodeVersion)}-linux-${process.arch}`
}

function findShasumLine(shasumsText: string, fileName: string): string {
  for (const line of shasumsText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+/)
    const hash = parts[0]
    const name = parts[1]
    if (name === fileName && hash !== undefined) return hash
  }
  throw new Error(`no SHASUMS256 entry found for ${fileName}`)
}

/**
 * Ensures `runtimes/node-v<version>-linux-<arch>` exists, downloading and
 * SHA-256-verifying it against the dist host's `SHASUMS256.txt` when it does
 * not (`issues/043-self-update.md` AC6). A hash mismatch throws before
 * anything is extracted or renamed into place — nothing is materialized for
 * a tampered tarball.
 */
async function ensureRuntime(
  ctx: Ctx,
  release: ReleaseMetadata,
): Promise<{ runtimeDirName: string }> {
  const runtimeDirName = computeRuntimeDirName(release)
  const runtimeDir = join(ctx.home.runtimesDir, runtimeDirName)
  if (existsSync(runtimeDir)) return { runtimeDirName }

  const version = normalizeNodeVersion(release.nodeVersion)
  const distBase = (ctx.env['VEDUTA_NODE_DIST_URL'] ?? 'https://nodejs.org/dist').replace(
    /\/+$/,
    '',
  )
  const distHost = new URL(distBase).hostname
  const tarName = `node-v${version}-linux-${process.arch}.tar.gz`
  const tarUrl = `${distBase}/v${version}/${tarName}`
  const shasumsUrl = `${distBase}/v${version}/SHASUMS256.txt`

  const tarBytes = await fetchChecked(
    ctx.ports,
    tarUrl,
    distHost,
    release.nodeTarSize,
    'node runtime tarball',
  )
  const shasumsBytes = await fetchChecked(
    ctx.ports,
    shasumsUrl,
    distHost,
    5_000_000,
    'node SHASUMS256.txt',
  )
  const expectedSha = findShasumLine(shasumsBytes.toString('utf8'), tarName)
  const actualSha = createHash('sha256').update(tarBytes).digest('hex')
  if (actualSha !== expectedSha) {
    throw new Error(
      `node runtime tarball sha256 mismatch for ${tarName}: expected ${expectedSha}, got ${actualSha}`,
    )
  }
  if (tarBytes.length !== release.nodeTarSize) {
    throw new Error(
      `node runtime tarball size mismatch for ${tarName}: expected ${release.nodeTarSize}, got ${tarBytes.length}`,
    )
  }

  const tmpTarPath = join(ctx.home.tmpDir, `node-${randomBytes(6).toString('hex')}.tar.gz`)
  const stagingDir = join(ctx.home.tmpDir, `node-staging-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmpTarPath, tarBytes)
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  try {
    const result = await ctx.ports.execFile('tar', ['-xzf', tmpTarPath, '-C', stagingDir])
    if (result.code !== 0) {
      throw new Error(
        `extracting the node runtime tarball failed: ${result.stderr || result.stdout}`,
      )
    }
    const innerDir = join(stagingDir, tarName.replace(/\.tar\.gz$/, ''))
    if (!existsSync(innerDir)) {
      throw new Error(
        `node runtime tarball did not contain the expected top-level directory: ${innerDir}`,
      )
    }
    renameSync(innerDir, runtimeDir)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(tmpTarPath, { force: true })
  }
  return { runtimeDirName }
}

// ---------------------------------------------------------------------------
// Disk guardrail — AC8
// ---------------------------------------------------------------------------

interface DiskReservation {
  label: string
  fsPath: string
  bytes: number
}

/**
 * Sizes come from the signed release metadata (never a live measurement of
 * the untrusted download) plus a measured size of the live data root
 * (`issues/043-self-update.md` AC8). Reservations are grouped by filesystem
 * (`stat().dev`) before being checked against `statfs` free space, so two
 * reservations that happen to land on the same disk are not double-counted
 * as if they had independent headroom.
 */
async function checkDiskGuardrail(
  ctx: Ctx,
  release: ReleaseMetadata,
  needsRuntime: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const dataRootBytes = await ctx.ports.diskUsage(ctx.dataRootDir)
  const reservations: DiskReservation[] = [
    {
      label: 'download + extraction' + (needsRuntime ? ' + node runtime' : ''),
      fsPath: ctx.home.root,
      bytes:
        release.artifactSize +
        release.unpackedSize +
        (needsRuntime ? release.nodeTarSize + release.nodeUnpackedSize : 0),
    },
    { label: 'backup staging', fsPath: ctx.home.tmpDir, bytes: dataRootBytes * 2 },
    { label: 'backup file', fsPath: ctx.home.backupsDir, bytes: dataRootBytes },
    {
      label: 'restore headroom',
      fsPath: dirname(resolve(ctx.dataRootDir)),
      bytes: dataRootBytes,
    },
  ]

  const groups = new Map<number, { fsPath: string; bytes: number; labels: string[] }>()
  for (const reservation of reservations) {
    const dev = statSync(reservation.fsPath).dev
    const existing = groups.get(dev) ?? { fsPath: reservation.fsPath, bytes: 0, labels: [] }
    existing.bytes += reservation.bytes
    existing.labels.push(reservation.label)
    groups.set(dev, existing)
  }

  const shortfalls: string[] = []
  for (const group of groups.values()) {
    const { bavail, bsize } = ctx.ports.statfs(group.fsPath)
    const freeBytes = bavail * bsize
    const neededBytes = Math.ceil(group.bytes * 1.2)
    if (neededBytes > freeBytes) {
      shortfalls.push(
        `${group.fsPath}: needs ~${neededBytes} bytes (${group.labels.join(', ')}), only ${freeBytes} bytes free`,
      )
    }
  }

  if (shortfalls.length > 0) {
    return { ok: false, message: `insufficient disk space:\n${shortfalls.join('\n')}` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Stage: download + verify + extract the release artifact
// ---------------------------------------------------------------------------

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
 * Each step below is idempotent via a filesystem-existence check, not solely
 * via the recorded substate — so a retry after a crash mid-rollback redoes
 * only the work that is actually still needed, regardless of exactly which
 * substate the journal last recorded (`docs/adr/0013-signed-self-update.md`).
 * The failed release's own tree and log are never touched here: they are
 * kept on disk for forensics, per the same source.
 */
async function performRollback(ctx: Ctx, journalIn: Journal): Promise<Journal> {
  let journal = journalIn
  const dataRoot = resolve(ctx.dataRootDir)

  let failedDataDir = journal.rollback?.failedDataDir
  if (failedDataDir === undefined) {
    failedDataDir = `${dataRoot}.failed-${journal.toVersion}-${isoForFilename(ctx.ports.now())}`
  }
  journal = writeJournal(ctx.home, {
    ...journal,
    rollback: { substate: 'data-moved-aside', failedDataDir },
  })
  if (existsSync(dataRoot)) {
    renameSync(dataRoot, failedDataDir)
  }
  ctx.log(`rollback: data root moved aside to ${failedDataDir}`)

  journal = writeJournal(ctx.home, {
    ...journal,
    rollback: { substate: 'restored', failedDataDir },
  })
  const restoreTmp = `${dataRoot}.restore-tmp`
  if (!existsSync(dataRoot)) {
    if (journal.backupFile === undefined) {
      throw new Error('rollback: no backup file recorded in the journal to restore from')
    }
    if (!existsSync(restoreTmp)) {
      await restoreBackup({
        file: journal.backupFile,
        targetRootDir: restoreTmp,
        keyMaterial: ctx.keyMaterial,
        workDir: ctx.home.tmpDir,
      })
    }
    renameSync(restoreTmp, dataRoot)
  }
  ctx.log('rollback: pre-update backup restored')

  journal = writeJournal(ctx.home, {
    ...journal,
    rollback: { substate: 'flipped-back', failedDataDir },
  })
  if (
    (journal.phase === 'switched' || journal.phase === 'serving-check') &&
    journal.executorRelease !== ''
  ) {
    flipCurrent(ctx.home, journal.executorRelease)
    ctx.log(`rollback: current flipped back to ${journal.executorRelease}`)
  }

  journal = writeJournal(ctx.home, { ...journal, rollback: { substate: 'done', failedDataDir } })
  return journal
}

// ---------------------------------------------------------------------------
// Success housekeeping (idempotent, success outcome only)
// ---------------------------------------------------------------------------

function pruneReleases(home: UpdateHome, keep = 3): void {
  if (!existsSync(home.releasesDir)) return
  const names = readdirSync(home.releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
    .map((entry) => entry.name)
  const sorted = [...names].sort((a, b) => compareVersions(a.slice(1), b.slice(1)))
  const toDelete = sorted.slice(0, Math.max(0, sorted.length - keep))
  for (const name of toDelete) {
    rmSync(join(home.releasesDir, name), { recursive: true, force: true })
  }
}

function pruneOrphanedRuntimes(home: UpdateHome): void {
  if (!existsSync(home.runtimesDir)) return
  const referenced = new Set<string>()
  if (existsSync(home.releasesDir)) {
    for (const entry of readdirSync(home.releasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('v')) continue
      const runtimeFile = join(home.releasesDir, entry.name, 'RUNTIME')
      if (existsSync(runtimeFile)) referenced.add(readFileSync(runtimeFile, 'utf8').trim())
    }
  }
  for (const entry of readdirSync(home.runtimesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !referenced.has(entry.name)) {
      rmSync(join(home.runtimesDir, entry.name), { recursive: true, force: true })
    }
  }
}

/** Copies `deploy/veduta-run` from the new release into `bin/veduta-run`, atomically, last (`docs/adr/0013-signed-self-update.md`). Skips silently when the source does not exist yet — it ships in a later task. */
function selfUpdateWrapper(home: UpdateHome, newReleaseDir: string): void {
  const source = join(newReleaseDir, 'deploy', 'veduta-run')
  if (!existsSync(source)) return
  mkdirSync(home.binDir, { recursive: true })
  const tmpPath = join(home.binDir, '.veduta-run.tmp')
  const destPath = join(home.binDir, 'veduta-run')
  copyFileSync(source, tmpPath)
  chmodSync(tmpPath, 0o755)
  const fd = openSync(tmpPath, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, destPath)
  const dirFd = openSync(home.binDir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

function runSuccessHousekeeping(home: UpdateHome, newReleaseDir: string): void {
  pruneReleases(home)
  // The updater's own pre-update backups directory, never the operator's
  // daily-backup directory (`docs/adr/0013-signed-self-update.md`).
  pruneBackups({ outDir: home.backupsDir, keep: 3 })
  pruneOrphanedRuntimes(home)
  selfUpdateWrapper(home, newReleaseDir)
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
 * Throws if a journal is already active — the caller (the wrapper/CLI, a
 * later task) is expected to call `resumeUpdateTransaction` in that case.
 */
export async function runUpdateTransaction(
  options: UpdateTransactionOptions,
): Promise<TransactionOutcome> {
  const { home } = options
  ensureUpdateHomeLayout(home)
  const env = options.env ?? process.env
  if (existsSync(journalPath(home))) {
    throw new Error(
      'runUpdateTransaction: an update journal is already active; call resumeUpdateTransaction instead',
    )
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
  const executorRelease = existsSync(home.currentSymlink) ? realpathSync(home.currentSymlink) : ''
  consumeMarkerFileIfPresent(home, now)

  let journal: Journal = {
    phase: 'started',
    toVersion: release.version,
    fromVersion: options.installedVersion,
    executorRelease,
    release,
    marker: options.marker,
    startedAt: now.toISOString(),
  }
  journal = writeJournal(home, journal)
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
 * (idempotent) archive step, never the transaction itself; `backup-done`/
 * `migrating` always roll back (a half-migrated data root is never
 * blind-resumed); every other phase continues forward from where the
 * journal says it left off.
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
 * Called by the wrapper/CLI (a later task) once its own stage-2 check
 * (starting the real daemon and confirming it actually serves) has passed.
 * Publishes the `success` terminal result and runs the success-only
 * housekeeping (prune, wrapper self-update, journal archive).
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
 * Called by the wrapper/CLI (a later task) when its own stage-2 check
 * fails, or by this module internally when stage-1 (or an earlier,
 * data-mutating phase) fails. Runs the full rollback sequence and
 * publishes the `rolled-back` terminal result.
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
 * (`docs/adr/0013-signed-self-update.md`; the daemon-side ack contract
 * itself lands in a later task). Only acts when no journal is active — an
 * in-progress transaction owns `result.json` housekeeping itself via
 * `publishResult`/`resumeUpdateTransaction`.
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
  return true
}
