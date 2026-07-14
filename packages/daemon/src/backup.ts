import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { openGcm, sealGcm } from './secret-crypto.ts'

/**
 * Encrypted backups (issue #15 D5, docs/SECURITY.md): a point-in-time,
 * encrypted-at-rest snapshot of everything under a daemon's `rootDir`.
 *
 * `createBackup` stages every `*.sqlite` store directly under `rootDir`
 * (trust, surfaces, scheduler, ingestion) via `VACUUM INTO`, which yields a
 * consistent single-file snapshot even while a live daemon holds an open
 * connection to the same file (this CLI is meant to run alongside a running
 * daemon, not only offline). Every other entry under `rootDir` — the
 * `spaces/` tree, sessions, `USER.md`/`SOUL.md`, `auth.json`, `routing.json`,
 * `ingestion.json`, `usage/`, `acme/`, and the already-encrypted
 * `secrets.vault` — is copied as a plain file tree. `-wal`/`-shm` sqlite
 * sidecars are never copied directly: `VACUUM INTO` folds their contents
 * into the single output file.
 *
 * CONSISTENCY: each SQLite file is individually consistent (a `VACUUM INTO`
 * snapshot); consistency *across* the whole rootDir (e.g. a Surface write
 * and its Space Event log append landing in the same backup) is
 * crash-equivalent — the same class of guarantee the stores already
 * tolerate across a power loss (WAL + boot recovery). A quiesce mode that
 * pauses the daemon for a fully atomic snapshot is out of scope for v1.
 *
 * FRAMING: `<outDir>/veduta-backup-<ISO>.tar.enc` is a UTF-8 JSON header
 * line `{v, salt, iv, tag}` (base64 fields) followed by `\n`, followed by
 * the raw AES-256-GCM ciphertext bytes of the tar archive. Encryption uses
 * the shared `sealGcm`/`openGcm` primitives (`secret-crypto.ts`) with the
 * `backup:` label, so the key is domain-separated from the vault's even
 * under identical key material, and a tampered salt/iv/tag/ciphertext all
 * fail authentication. Only the on-disk envelope (a header line plus raw
 * ciphertext bytes, rather than the vault's single base64 JSON object) is
 * local to this module — keeping a large tar's ciphertext raw avoids the
 * ~33% base64 bloat of embedding it in JSON.
 */

const execFileAsync = promisify(execFile)

export const BACKUP_FILE_PREFIX = 'veduta-backup-'
export const BACKUP_FILE_SUFFIX = '.tar.enc'

const BACKUP_LABEL = 'backup:'

interface BackupHeader {
  v: 1
  salt: string
  iv: string
  tag: string
}

function encryptArchive(plaintext: Buffer, keyMaterial: Buffer): Buffer {
  const sealed = sealGcm({ label: BACKUP_LABEL, keyMaterial, plaintext })
  const header: BackupHeader = { v: 1, salt: sealed.salt, iv: sealed.iv, tag: sealed.tag }
  const ciphertext = Buffer.from(sealed.ct, 'base64')
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ciphertext])
}

function decryptArchive(fileBuffer: Buffer, keyMaterial: Buffer): Buffer {
  const newlineIndex = fileBuffer.indexOf(0x0a)
  if (newlineIndex === -1) throw new Error('backup file is corrupt: missing header line')
  let header: BackupHeader
  try {
    header = JSON.parse(fileBuffer.subarray(0, newlineIndex).toString('utf8')) as BackupHeader
  } catch (error) {
    throw new Error(`backup file header is not valid JSON: ${errorText(error)}`)
  }
  if (header.v !== 1 || !header.salt || !header.iv || !header.tag) {
    throw new Error('backup file header is missing required fields')
  }
  const ct = fileBuffer.subarray(newlineIndex + 1).toString('base64')
  try {
    return openGcm({
      label: BACKUP_LABEL,
      keyMaterial,
      salt: header.salt,
      iv: header.iv,
      tag: header.tag,
      ct,
    })
  } catch {
    // Wrong key material or a tampered header/ciphertext (the AAD covers
    // salt/iv, GCM covers the ciphertext) both surface as an auth failure
    // here — never partial or silently-wrong data.
    throw new Error('failed to decrypt backup: wrong key material or corrupted file')
  }
}

// ---------------------------------------------------------------------------
// Atomic writes (mirrors secrets-vault.ts's tmp-then-rename discipline)
// ---------------------------------------------------------------------------

function writeFileAtomic(path: string, content: Buffer): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(tmpPath)
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

// ---------------------------------------------------------------------------
// Busy-safe SQLite snapshot
// ---------------------------------------------------------------------------

const VACUUM_RETRY_ATTEMPTS = 5
const VACUUM_RETRY_BASE_DELAY_MS = 40

interface SqliteErrorLike extends Error {
  errcode?: number
  errstr?: string
}

/** `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), matched by code where available and by message text otherwise — `node:sqlite` does not expose a typed error class. */
function isBusyOrLockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const withCodes = error as SqliteErrorLike
  if (withCodes.errcode === 5 || withCodes.errcode === 6) return true
  const text = `${withCodes.message} ${withCodes.errstr ?? ''}`.toLowerCase()
  return text.includes('busy') || text.includes('locked')
}

/**
 * A consistent, single-file snapshot of a live SQLite database: opened
 * read-only (never contends for a write lock) and copied via `VACUUM INTO`,
 * which also folds any WAL contents into the output — no separate
 * `-wal`/`-shm` handling needed. Bounded retry with backoff, since this CLI
 * is expected to run against a live daemon that may hold the file briefly.
 */
async function vacuumIntoWithRetry(sourcePath: string, destPath: string): Promise<void> {
  for (let attempt = 1; attempt <= VACUUM_RETRY_ATTEMPTS; attempt++) {
    try {
      const db = new DatabaseSync(sourcePath, { readOnly: true })
      try {
        db.prepare('VACUUM INTO ?').run(destPath)
      } finally {
        db.close()
      }
      return
    } catch (error) {
      if (attempt === VACUUM_RETRY_ATTEMPTS || !isBusyOrLockedError(error)) throw error
      await delay(VACUUM_RETRY_BASE_DELAY_MS * attempt)
    }
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** Every direct child of `rootDir`, staged into `stagingDir`: `*.sqlite` files via a busy-safe `VACUUM INTO`, everything else copied as a tree. */
async function stageRootDir(rootDir: string, outDir: string, stagingDir: string): Promise<void> {
  const resolvedOutDir = resolve(outDir)
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const name = entry.name
    if (name.endsWith('-wal') || name.endsWith('-shm')) continue
    const srcPath = join(rootDir, name)
    if (resolve(srcPath) === resolvedOutDir) continue
    const destPath = join(stagingDir, name)
    if (entry.isFile() && name.endsWith('.sqlite')) {
      await vacuumIntoWithRetry(srcPath, destPath)
      continue
    }
    cpSync(srcPath, destPath, {
      recursive: true,
      filter: (source) => !source.endsWith('-wal') && !source.endsWith('-shm'),
    })
  }
}

/** Filesystem-safe ISO timestamp: colons become dashes, uniformly, so lexical order still matches chronological order. */
function isoForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  rootDir: string
  outDir: string
  keyMaterial: Buffer
  now?: () => Date
}

/** Builds an encrypted, point-in-time backup of `rootDir` under `outDir`. Returns the written file's absolute path. */
export async function createBackup(options: CreateBackupOptions): Promise<string> {
  const now = options.now ?? (() => new Date())
  const rootDir = resolve(options.rootDir)
  const outDir = resolve(options.outDir)
  if (!existsSync(rootDir)) throw new Error(`backup source rootDir does not exist: ${rootDir}`)
  mkdirSync(outDir, { recursive: true })

  // Unencrypted intermediate material (the staged file tree and the plain
  // tar) stays inside a single private directory (`mkdtemp` creates it 0700,
  // so it is never world-readable) and is removed in `finally` on both
  // success and failure. It lives under the system tmp dir — deliberately
  // NOT under `rootDir`/`outDir`, so a staging tree can never be recursively
  // copied into its own backup.
  const workDir = mkdtempSync(join(tmpdir(), 'veduta-backup-'))
  const stagingDir = join(workDir, 'staging')
  const tarPath = join(workDir, 'archive.tar')
  try {
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
    await stageRootDir(rootDir, outDir, stagingDir)
    await execFileAsync('tar', ['-cf', tarPath, '-C', stagingDir, '.'])
    const tarBuffer = readFileSync(tarPath)
    const encrypted = encryptArchive(tarBuffer, options.keyMaterial)
    const outPath = join(
      outDir,
      `${BACKUP_FILE_PREFIX}${isoForFilename(now())}${BACKUP_FILE_SUFFIX}`,
    )
    writeFileAtomic(outPath, encrypted)
    return outPath
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

export interface RestoreBackupOptions {
  file: string
  targetRootDir: string
  keyMaterial: Buffer
}

/**
 * Restores an encrypted backup into `targetRootDir`, which must not already
 * exist with contents (a "clean machine" restore, never a silent merge over
 * live data). Decrypt failures (wrong key, tampered file) throw before
 * anything is extracted; a post-extraction sanity check throws if the
 * archive did not actually contain daemon state.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<void> {
  const targetRootDir = resolve(options.targetRootDir)
  if (existsSync(targetRootDir)) {
    if (readdirSync(targetRootDir).length > 0) {
      throw new Error(`restore target is not empty: ${targetRootDir}`)
    }
  } else {
    mkdirSync(targetRootDir, { recursive: true })
  }

  const fileBuffer = readFileSync(options.file)
  const tarBuffer = decryptArchive(fileBuffer, options.keyMaterial)

  // The decrypted tar is plaintext daemon state — stage it in a private
  // directory (`mkdtemp` creates it 0700) and remove it in `finally`.
  const workDir = mkdtempSync(join(tmpdir(), 'veduta-restore-'))
  const tarPath = join(workDir, 'archive.tar')
  try {
    writeFileSync(tarPath, tarBuffer, { mode: 0o600 })
    await execFileAsync('tar', ['-xf', tarPath, '-C', targetRootDir])
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  const restored = readdirSync(targetRootDir, { withFileTypes: true })
  const hasMarker = restored.some(
    (entry) =>
      (entry.name === 'spaces' && entry.isDirectory()) ||
      (entry.isFile() && entry.name.endsWith('.sqlite')),
  )
  if (!hasMarker)
    throw new Error('backup looks empty/corrupt: no spaces/ directory or *.sqlite file found')
}

export interface PruneBackupsOptions {
  outDir: string
  keep?: number
}

/** Deletes all but the newest `keep` (default 7) backups under `outDir`, ordered by filename timestamp. Returns the deleted files' absolute paths. */
export function pruneBackups(options: PruneBackupsOptions): string[] {
  const keep = options.keep ?? 7
  const outDir = resolve(options.outDir)
  if (!existsSync(outDir)) return []
  const files = readdirSync(outDir)
    .filter((name) => name.startsWith(BACKUP_FILE_PREFIX) && name.endsWith(BACKUP_FILE_SUFFIX))
    .sort()
  const toDelete = files.slice(0, Math.max(0, files.length - keep))
  const deleted: string[] = []
  for (const name of toDelete) {
    const fullPath = join(outDir, name)
    unlinkSync(fullPath)
    deleted.push(fullPath)
  }
  return deleted
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
