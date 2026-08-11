import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ImportSourceKind } from '@veduta/protocol'
import { defaultRedactor } from './redaction.ts'

/** A file read from a legacy install, already size- and symlink-checked. */
export interface LegacyFile {
  relPath: string
  text: string
  bytes: number
}

/** A note file under a memory directory; `date` is set only for `YYYY-MM-DD.md` names. */
export interface LegacyNote extends LegacyFile {
  date?: string
}

/**
 * Everything `readLegacySource` found in one legacy install, still raw
 * (untrusted, unredacted, unmapped) — `import-mapping.ts` turns this
 * into an `ImportPlan`. Kept deliberately dumb: this module's only job is a
 * hardened read, never interpretation.
 */
export interface LegacySourceSnapshot {
  kind: ImportSourceKind
  dir: string
  soul?: LegacyFile
  user?: LegacyFile
  memory?: LegacyFile
  notes: LegacyNote[]
  notMigrated: string[]
  oversize: string[]
  refused: string[]
}

/**
 * A hard block that `--overwrite` cannot clear: a missing or
 * non-directory source root is a refusal, never a silent empty snapshot, so the caller can turn it
 * into a 409 (wizard) or an exit code 2 (CLI) instead of reporting an import that found nothing.
 */
export class ImportSourceMissingError extends Error {
  constructor(dir: string) {
    super(`legacy source not found or not a directory: ${dir}`)
    this.name = 'ImportSourceMissingError'
  }
}

/**
 * A single MEMORY.md/USER.md/SOUL.md pasted with an API key in it is a realistic accident; this cap
 * keeps a hostile or merely huge file from being read into memory at all — it is recorded in
 * `oversize` instead. What "oversize" means for each slot (hard block for SOUL/USER/MEMORY, skip
 * for a note) is the plan builder's call; this module only ever reports it.
 */
export const MAX_FILE_BYTES = 1_048_576

/**
 * Caps how many `.md` notes a single memory directory contributes. Notes beyond this are not
 * silently dropped: `readLegacySource` reports the overflow via `notMigrated` (plan "unrecognised
 * is reported, never guessed at"), so NOTES.md still lists them.
 */
export const MAX_NOTES = 200

const HERMES_ALIASES = ['.hermes']
/**
 * OpenClaw's former names (`docs/references/04-onboarding-migration.md` §B). Exported so
 * `onboarding-status.ts`'s own `detectLegacyAgents` imports this one list instead of keeping a
 * second, independently-maintained copy — `deploy/install.sh`'s shell copy is the one duplication
 * left standing on purpose, since bash cannot import a TypeScript constant (see that file's own
 * comment on `OPENCLAW_HOME_ALIASES`).
 */
export const OPENCLAW_ALIASES = ['.openclaw', '.clawdbot', '.moltbot']

/** A staged directory is present only when it contains something the importer can read. */
const STAGED_CONTENT_NAMES = ['SOUL.md', 'USER.md', 'MEMORY.md', 'notes']

function hasStagedContent(dir: string): boolean {
  return STAGED_CONTENT_NAMES.some((name) => existsSync(join(dir, name)))
}

/**
 * The installer stages only the memory files into
 * `<dataDir>/import-source/<kind>/` because the daemon runs as `veduta` under `ProtectHome=yes` and
 * can never read `/home/<admin>/.hermes` on a real VPS install. So the staged directory always wins
 * when present; the live home (`.hermes`/`.openclaw`, plus the `.clawdbot`/`.moltbot` legacy
 * aliases from OpenClaw's own rename history) is only a fallback for a loopback/Local VPS profile
 * where the daemon and the user share a home. Returns `undefined`, never throws, so callers can
 * build a 409 with the CLI command instead of crashing on a plain dev machine with nothing
 * installed. "present" requires more than `existsSync` — the installer can
 * create `<dataDir>/import-source/<kind>/` and stage nothing into it (everything was a symlink,
 * oversized, or simply absent in the source), and an empty staged directory must never shadow a
 * perfectly readable live home. `hasStagedContent` requires at least one of
 * `SOUL.md`/`USER.md`/`MEMORY.md`/`notes` to actually exist inside it before it wins over the
 * fallback.
 */
export function resolveLegacyDir(input: {
  kind: ImportSourceKind
  stagedDir?: string
  home?: string
}): string | undefined {
  if (
    input.stagedDir !== undefined &&
    existsSync(input.stagedDir) &&
    hasStagedContent(input.stagedDir)
  ) {
    return input.stagedDir
  }
  if (input.home === undefined) return undefined
  const aliases = input.kind === 'hermes' ? HERMES_ALIASES : OPENCLAW_ALIASES
  for (const alias of aliases) {
    const candidate = join(input.home, alias)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const HERMES_SECRET_FILES = ['.env', 'auth.json']
const OPENCLAW_SECRET_FILES = ['openclaw.json']

/** The result of `readRegularFileHardened`: a discriminated success/refusal, never a thrown error. */
type HardenedFileRead =
  { ok: true; text: string; bytes: number } | { ok: false; reason: 'refused' | 'oversize' }

/**
 * Opens `absPath` with `O_NOFOLLOW`, `fstat`s the descriptor before ever
 * reading it, and reads the whole file only if it is a genuine regular file
 * within `maxBytes` — the one hardened-read primitive for the whole
 * importer: `import-archive.ts`'s archive
 * walk calls this directly instead of re-implementing the same
 * open/fstat/read dance a second time ("one security primitive, one
 * implementation"). A malicious legacy tree with `SOUL.md` symlinked at
 * `/etc/shadow` or a vault keyfile must never be followed: POSIX
 * `O_NOFOLLOW` fails the open with `ELOOP` whenever the final path
 * component is a symlink, whether or not the link target exists, so a
 * dangling symlink is refused exactly the same way as a live one. A FIFO or
 * device masquerading as a regular file is refused too — reading a FIFO can
 * block the process forever.
 */
export function readRegularFileHardened(
  absPath: string,
  maxBytes: number = MAX_FILE_BYTES,
): HardenedFileRead {
  let fd: number
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return { ok: false, reason: 'refused' }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, reason: 'refused' }
    if (stat.size > maxBytes) return { ok: false, reason: 'oversize' }
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const bytesRead = readSync(fd, buffer, offset, stat.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { ok: true, text: buffer.toString('utf8'), bytes: stat.size }
  } finally {
    closeSync(fd)
  }
}

/**
 * Strips ASCII control characters and runs the redactor over a
 * source-controlled display path before it is recorded anywhere user-facing
 *: a hostile filename containing a
 * newline or a terminal escape sequence must never be able to forge
 * Markdown structure in `NOTES.md` or a rendered plan. Applied only to the
 * copy that ends up in `notMigrated`/`refused`/`oversize`/a plan
 * warning/an archive destination — never to the path actually used for
 * filesystem I/O, which must stay exactly what is on disk.
 */
export function sanitizeDisplayPath(relPath: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const stripped = relPath.replace(/[\x00-\x1f\x7f]/g, '')
  return defaultRedactor.redactText(stripped)
}

/**
 * Reads one file at `relPath` under `dir`, or returns `undefined` when
 * nothing exists at that path at all (checked with `lstatSync`, which — unlike
 * `existsSync` — reports the presence of a symlink even when its target is
 * missing, so a dangling malicious symlink still reaches
 * `readRegularFileHardened` and gets refused rather than silently read as
 * "not there"). Oversize files are never read into memory: only their size
 * is inspected before the cap is applied. `relPath` is recorded in
 * `refused`/`oversize` through `sanitizeDisplayPath` — display copies
 * only, the actual read above always uses the real, unsanitized path.
 */
function readFileHardened(
  dir: string,
  relPath: string,
  refused: string[],
  oversize: string[],
): LegacyFile | undefined {
  const absPath = join(dir, relPath)
  try {
    lstatSync(absPath)
  } catch {
    return undefined
  }
  const result = readRegularFileHardened(absPath)
  if (!result.ok) {
    ;(result.reason === 'oversize' ? oversize : refused).push(sanitizeDisplayPath(relPath))
    return undefined
  }
  return { relPath, text: result.text, bytes: result.bytes }
}

/**
 * One slot (SOUL/USER/MEMORY) tries the vendor-nested path first; only when *nothing at all* exists
 * at that path does it fall back to the same basename at the root of `dir` — the flat staged layout
 * (the installer copies `SOUL.md`/`USER.md`/`MEMORY.md`/`notes/` straight
 * into the staging dir, no vendor subdirectory). Presence is checked with `lstatSync` for the same
 * dangling-symlink reason as `readFileHardened`.
 */
function readSlotWithFlatFallback(
  dir: string,
  nestedRelPath: string,
  flatBasename: string,
  refused: string[],
  oversize: string[],
): LegacyFile | undefined {
  let nestedPresent = true
  try {
    lstatSync(join(dir, nestedRelPath))
  } catch {
    nestedPresent = false
  }
  if (nestedPresent) return readFileHardened(dir, nestedRelPath, refused, oversize)
  return readFileHardened(dir, flatBasename, refused, oversize)
}

const NOTE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

/**
 * Reads the direct `.md` children of a memory directory as notes — no
 * recursion, ever (plan): a legacy tree could bury a huge or
 * malicious file several levels down, and the vendor layouts (the plan's
 * "Source layouts" tables) never nest notes beyond one level. `excludeNames`
 * keeps MEMORY.md/USER.md out of the note list when they live alongside the
 * notes (Hermes: `memories/`). Names beyond `MAX_NOTES` are pushed to
 * `notMigrated` instead of being silently dropped — sorted, so NOTES.md
 * lists them deterministically.
 */
function readNotesDir(
  dir: string,
  memoryRelDir: string,
  excludeNames: string[],
  refused: string[],
  oversize: string[],
  notMigrated: string[],
): LegacyNote[] {
  const absDir = join(dir, memoryRelDir)
  if (!existsSync(absDir)) return []
  const entries = readdirSync(absDir, { withFileTypes: true })
  const mdNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .filter((name) => !excludeNames.includes(name))
    .sort()

  const inBudget = mdNames.slice(0, MAX_NOTES)
  const overflow = mdNames.slice(MAX_NOTES)
  for (const name of overflow) {
    notMigrated.push(sanitizeDisplayPath(join(memoryRelDir, name)))
  }

  const notes: LegacyNote[] = []
  for (const name of inBudget) {
    const relPath = join(memoryRelDir, name)
    const file = readFileHardened(dir, relPath, refused, oversize)
    if (file === undefined) continue
    const dateMatch = NOTE_DATE_RE.exec(name)
    notes.push({
      ...file,
      ...(dateMatch?.[1] === undefined ? {} : { date: dateMatch[1] }),
    })
  }
  return notes
}

/**
 * Direct children of `dir` (or `dir/subDir`) not in `claimedNames`, so
 * NOTES.md can tell the user exactly what was left behind — the
 * plan's "anything unrecognised is reported, never guessed at". Sorted for a
 * deterministic NOTES.md. A missing `subDir` yields no entries rather than
 * throwing: the caller only calls this for a subdirectory it already knows
 * exists.
 */
function listUnclaimed(dir: string, subDir: string | undefined, claimedNames: string[]): string[] {
  const absDir = subDir === undefined ? dir : join(dir, subDir)
  if (!existsSync(absDir)) return []
  const claimed = new Set(claimedNames)
  return readdirSync(absDir)
    .filter((name) => !claimed.has(name))
    .map((name) => sanitizeDisplayPath(subDir === undefined ? name : join(subDir, name)))
    .sort()
}

/**
 * Reads a legacy Hermes or OpenClaw install into a `LegacySourceSnapshot` per the vendor layout tables
 * documented in `issues/020-importer.md` — a pure, hardened read with zero writes anywhere ("dry-run is genuinely
 * read-only" starts here; `import-mapping.ts`'s `readTargetState` is the target-side half of that
 * guarantee). `notMigrated` is deliberately shallow — direct children of `dir`, and of
 * `dir/workspace` for OpenClaw — matching exactly what the plan's tables call out as
 * archived/NOTES-only (`config.yaml`, `skills/`, `cron/`, `sessions/`, `workspace/AGENTS.md`,
 * etc.); it never recurses into the memory directories, whose `.md` children are already accounted
 * for as notes (or, past `MAX_NOTES`, as overflow) and whose non-`.md` children are out of scope
 * for this issue (`ARCHITECTURE.md` anti-requirements: no speculative generalisation beyond the
 * documented layouts).
 */
export function readLegacySource(dir: string, kind: ImportSourceKind): LegacySourceSnapshot {
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new ImportSourceMissingError(dir)
  }
  if (!stat.isDirectory()) throw new ImportSourceMissingError(dir)
  const resolvedDir = realpathSync(dir)

  const refused: string[] = []
  const oversize: string[] = []
  const notMigrated: string[] = []

  if (kind === 'hermes') {
    // Hermes: SOUL.md always lives at the root (vendor layout and the flat
    // staged layout coincide, so no fallback is needed for it). USER.md and
    // MEMORY.md live under memories/ normally, or at the root when staged
    // flat.
    const soul = readFileHardened(resolvedDir, 'SOUL.md', refused, oversize)
    const memoriesPresent = existsSync(join(resolvedDir, 'memories'))
    const user = readSlotWithFlatFallback(
      resolvedDir,
      'memories/USER.md',
      'USER.md',
      refused,
      oversize,
    )
    const memory = readSlotWithFlatFallback(
      resolvedDir,
      'memories/MEMORY.md',
      'MEMORY.md',
      refused,
      oversize,
    )
    let notes = readNotesDir(
      resolvedDir,
      'memories',
      ['USER.md', 'MEMORY.md'],
      refused,
      oversize,
      notMigrated,
    )
    if (!memoriesPresent) {
      // Flat staged layout: notes land directly under <dir>/notes/.
      notes = readNotesDir(resolvedDir, 'notes', [], refused, oversize, notMigrated)
    }

    const secretFiles = HERMES_SECRET_FILES.filter((name) => existsSync(join(resolvedDir, name)))

    const rootClaimed = [...secretFiles]
    if (memoriesPresent) {
      rootClaimed.push('memories')
    } else {
      rootClaimed.push('USER.md', 'MEMORY.md', 'notes')
    }
    rootClaimed.push('SOUL.md')
    notMigrated.push(...listUnclaimed(resolvedDir, undefined, rootClaimed))
    notMigrated.sort()

    return {
      kind,
      dir: resolvedDir,
      ...(soul === undefined ? {} : { soul }),
      ...(user === undefined ? {} : { user }),
      ...(memory === undefined ? {} : { memory }),
      notes,
      notMigrated,
      oversize,
      refused,
    }
  }

  // OpenClaw: everything memory/identity-related lives under workspace/,
  // normally; staged flat puts the same basenames at the root.
  const workspacePresent = existsSync(join(resolvedDir, 'workspace'))
  const soul = readSlotWithFlatFallback(
    resolvedDir,
    'workspace/SOUL.md',
    'SOUL.md',
    refused,
    oversize,
  )
  const user = readSlotWithFlatFallback(
    resolvedDir,
    'workspace/USER.md',
    'USER.md',
    refused,
    oversize,
  )
  const memory = readSlotWithFlatFallback(
    resolvedDir,
    'workspace/MEMORY.md',
    'MEMORY.md',
    refused,
    oversize,
  )
  let notes = readNotesDir(resolvedDir, 'workspace/memory', [], refused, oversize, notMigrated)
  if (!workspacePresent) {
    notes = readNotesDir(resolvedDir, 'notes', [], refused, oversize, notMigrated)
  }

  const secretFiles = OPENCLAW_SECRET_FILES.filter((name) => existsSync(join(resolvedDir, name)))

  const rootClaimed = [...secretFiles]
  if (workspacePresent) {
    rootClaimed.push('workspace')
    const workspaceClaimed = ['SOUL.md', 'USER.md', 'MEMORY.md', 'memory']
    notMigrated.push(...listUnclaimed(resolvedDir, 'workspace', workspaceClaimed))
  } else {
    rootClaimed.push('SOUL.md', 'USER.md', 'MEMORY.md', 'notes')
  }
  notMigrated.push(...listUnclaimed(resolvedDir, undefined, rootClaimed))
  notMigrated.sort()

  return {
    kind,
    dir: resolvedDir,
    ...(soul === undefined ? {} : { soul }),
    ...(user === undefined ? {} : { user }),
    ...(memory === undefined ? {} : { memory }),
    notes,
    notMigrated,
    oversize,
    refused,
  }
}
