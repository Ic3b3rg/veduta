import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
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
 * the raw AES-256-GCM ciphertext bytes of the tar archive. The header's
 * `v`/`salt`/`iv` fields (not `tag`, which does not exist yet when the AAD
 * is computed) are passed as GCM AAD, so tampering with the header fails
 * authentication exactly like tampering with the ciphertext — this mirrors
 * `secrets-vault.ts`'s framing. The key is domain-separated from the vault
 * key (`deriveBackupKey`, label `backup:`) so the same key material yields
 * a different key for a different purpose.
 */

const execFileAsync = promisify(execFile)

export const BACKUP_FILE_PREFIX = 'veduta-backup-'
export const BACKUP_FILE_SUFFIX = '.tar.enc'

interface BackupHeader {
  v: 1
  salt: string
  iv: string
  tag: string
}

/** Domain-separated scrypt: the `backup:` label keeps this key distinct from the vault's, even under identical key material. */
export function deriveBackupKey(keyMaterial: Buffer, salt: Buffer): Buffer {
  return scryptSync(keyMaterial, Buffer.concat([Buffer.from('backup:'), salt]), 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
}

/** Fixed header field order so the AAD bytes are reproducible on read and write; `tag` is deliberately excluded (it does not exist until encryption finishes). */
function headerAad(header: { v: 1; salt: string; iv: string }): Buffer {
  return Buffer.from(JSON.stringify({ v: header.v, salt: header.salt, iv: header.iv }), 'utf8')
}

function encryptArchive(plaintext: Buffer, keyMaterial: Buffer): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveBackupKey(keyMaterial, salt)
  const header = { v: 1 as const, salt: salt.toString('base64'), iv: iv.toString('base64') }
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(headerAad(header))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const file: BackupHeader = { ...header, tag: cipher.getAuthTag().toString('base64') }
  return Buffer.concat([Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'), ciphertext])
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
  const ciphertext = fileBuffer.subarray(newlineIndex + 1)
  const salt = Buffer.from(header.salt, 'base64')
  const iv = Buffer.from(header.iv, 'base64')
  const tag = Buffer.from(header.tag, 'base64')
  const key = deriveBackupKey(keyMaterial, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(headerAad({ v: header.v, salt: header.salt, iv: header.iv }))
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // Wrong key material or a tampered header/ciphertext (the AAD covers
    // v/salt/iv, GCM covers the ciphertext) both surface as an auth
    // failure here — never partial or silently-wrong data.
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

  const stagingDir = mkdtempSync(join(tmpdir(), 'veduta-backup-staging-'))
  const tarPath = join(tmpdir(), `veduta-backup-${randomBytes(8).toString('hex')}.tar`)
  try {
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
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(tarPath, { force: true })
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

  const tarPath = join(tmpdir(), `veduta-restore-${randomBytes(8).toString('hex')}.tar`)
  try {
    writeFileSync(tarPath, tarBuffer)
    await execFileAsync('tar', ['-xf', tarPath, '-C', targetRootDir])
  } finally {
    rmSync(tarPath, { force: true })
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
