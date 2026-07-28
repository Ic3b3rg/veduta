import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, sep } from 'node:path'
import type { ImportPlan } from '@veduta/protocol'
import { sourceLabel, VAULT_TARGET_PREFIX } from './import-mapping.ts'
import { MAX_FILE_BYTES, readRegularFileHardened, sanitizeDisplayPath } from './import-source.ts'
import { defaultRedactor } from './redaction.ts'

/**
 * `writeImportArchive`: a bounded, redacted copy of the legacy install's non-secret text files that
 * the importer does not otherwise map (prompt files, `config.yaml`, `skills/`, `cron/`) — the
 * material `NOTES.md` (`buildNotesMarkdown`, merged into this module by NOTES is written into the
 * archive directory and describes it, so the two belong together) tells the user to keep, since it
 * has no 1:1 home in Veduta. The source install is only ever read here, never written to.
 * `NEVER_ARCHIVED` is the security property this module exists to enforce ("Source layouts"
 * tables): these names hold secrets (`.env`, `auth.json`, `openclaw.json`) or runtime state
 * (`state.db`, `sessions/`, `logs/`, `pending/`) and must never reach the archive, no matter what
 * extension filter or depth/size cap logic exists around them. Kept as one exported constant with
 * its predicate (`import-plan.ts` used to keep an identical, copy-pasted second list and predicate;
 * both now import this one), asserted directly in `import-archive.test.ts`, rather than folded into
 * the walk logic where a future edit could silently narrow it.
 */
export const NEVER_ARCHIVED: readonly string[] = Object.freeze([
  '.env',
  'auth.json',
  'openclaw.json',
  'state.db',
  'sessions',
  'logs',
  'pending',
])

export function isNeverArchived(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => NEVER_ARCHIVED.includes(segment))
}

/**
 * Already mapped elsewhere by this importer (SOUL/USER/MEMORY → the adapted target files; the
 * memory/notes directories → FACTS + the Event log), so archiving them again would just duplicate
 * content the user already has in Veduta under a different, adapted form. Listed by known
 * vendor-layout relative path (both nested and the installer's flat staged layout) rather than
 * derived from a live `LegacySourceSnapshot`, since `writeImportArchive`'s contract deliberately
 * does not take one — this module's only job is a bounded, redacted copy of a directory tree, kept
 * decoupled from `import-source.ts`'s read machinery.
 */
const MAPPED_FILE_RELPATHS = new Set([
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  join('workspace', 'SOUL.md'),
  join('workspace', 'USER.md'),
  join('workspace', 'MEMORY.md'),
])

/**
 * Directory *prefixes*, not bare segment names (fix): the previous
 * version stored `join('workspace', 'memory')` in a `Set` and then tested
 * each path *segment* individually against it — `'workspace/memory'` never
 * equals either `'workspace'` or `'memory'` alone, so that entry could never
 * match anything, and OpenClaw daily notes already imported into the Event
 * log got archived a second time. Matching the full relative path against
 * each prefix (exact match or `prefix + separator` match) is what actually
 * excludes `workspace/memory/2026-01-01.md`.
 */
const MAPPED_DIR_PREFIXES = ['memories', 'notes', join('workspace', 'memory')]

function isMappedElsewhere(relPath: string): boolean {
  if (MAPPED_FILE_RELPATHS.has(relPath)) return true
  return MAPPED_DIR_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(prefix + sep),
  )
}

/**
 * a broader filename guard on top of the exact-name `NEVER_ARCHIVED`
 * denylist — a `credentials.json`, `oauth.txt` or `my-secret-notes.md` sitting
 * next to `config.yaml` in the legacy install is not one of the seven exact
 * names, so the denylist alone would let it through. Matched against the
 * entry's own basename only (never a whole path, which could contain an
 * unrelated ancestor directory that happens to share a substring).
 */
const CREDENTIAL_LIKE_NAME_RE = /credential|secret|token|password|auth/i

const ALLOWED_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.json', '.txt'])

/** No recursion beyond 3 levels. Depth 1 is `sourceDir`'s direct children. */
const MAX_DEPTH = 3

/**
 * Archive-specific file cap — a distinct cap from
 * `import-source.ts`'s `MAX_NOTES` (the unrelated per-memory-directory notes cap), even though both
 * currently read 200; conflating the two would make an unrelated future change to one silently
 * change the other.
 */
const MAX_ARCHIVE_FILES = 200

export interface WriteImportArchiveInput {
  sourceDir: string
  archiveDir: string
}

export interface WriteImportArchiveResult {
  archived: string[]
  skipped: { path: string; reason: string }[]
}

interface WalkState {
  archived: string[]
  skipped: { path: string; reason: string }[]
  fileCount: number
}

function archiveFile(input: WriteImportArchiveInput, relPath: string, state: WalkState): void {
  const displayPath = sanitizeDisplayPath(relPath)
  if (state.fileCount >= MAX_ARCHIVE_FILES) {
    state.skipped.push({
      path: displayPath,
      reason: `archive file cap (${MAX_ARCHIVE_FILES}) reached`,
    })
    return
  }
  const ext = extname(relPath).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    state.skipped.push({
      path: displayPath,
      reason: `extension ${ext || '(none)'} is not archived`,
    })
    return
  }

  // the one hardened-read primitive for the whole importer, exported by
  // `import-source.ts` — this used to be a byte-for-byte second copy of that
  // module's open/fstat/read hardening ("one security primitive, one
  // implementation").
  const read = readRegularFileHardened(join(input.sourceDir, relPath), MAX_FILE_BYTES)
  if (!read.ok) {
    state.skipped.push({
      path: displayPath,
      reason: read.reason === 'oversize' ? 'exceeds the 1 MiB archive cap' : 'not a regular file',
    })
    return
  }

  // the archive destination uses the sanitized display name — a hostile
  // filename (a control character, a terminal escape sequence) must never
  // reach the archive directory tree verbatim.
  const destPath = join(input.archiveDir, displayPath)
  mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 })
  writeFileSync(destPath, defaultRedactor.redactText(read.text), { mode: 0o600 })
  state.fileCount += 1
  state.archived.push(displayPath)
}

function walk(
  input: WriteImportArchiveInput,
  relBase: string,
  depth: number,
  state: WalkState,
): void {
  const absDir = relBase === '' ? input.sourceDir : join(input.sourceDir, relBase)
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    state.skipped.push({ path: sanitizeDisplayPath(relBase), reason: 'could not read directory' })
    return
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = relBase === '' ? entry.name : join(relBase, entry.name)
    const displayPath = sanitizeDisplayPath(relPath)

    if (isNeverArchived(relPath)) {
      state.skipped.push({ path: displayPath, reason: 'excluded: holds secrets or runtime state' })
      continue
    }
    if (isMappedElsewhere(relPath)) continue

    if (CREDENTIAL_LIKE_NAME_RE.test(entry.name)) {
      state.skipped.push({ path: displayPath, reason: 'excluded: filename looks credential-like' })
      continue
    }

    if (entry.isSymbolicLink()) {
      state.skipped.push({ path: displayPath, reason: 'symlink refused' })
      continue
    }

    if (entry.isDirectory()) {
      if (depth + 1 > MAX_DEPTH) {
        state.skipped.push({ path: displayPath, reason: `max depth (${MAX_DEPTH}) exceeded` })
        continue
      }
      walk(input, relPath, depth + 1, state)
      continue
    }

    if (entry.isFile()) {
      archiveFile(input, relPath, state)
      continue
    }

    state.skipped.push({ path: displayPath, reason: 'not a regular file or directory' })
  }
}

/**
 * Walks `sourceDir` (bounded: `MAX_DEPTH` levels, `MAX_ARCHIVE_FILES` files, `MAX_FILE_BYTES` each,
 * `.md`/`.yaml`/`.yml`/`.json`/`.txt` only) and copies every eligible file into `archiveDir`,
 * redacted through `defaultRedactor.redactText`. Overflow past any
 * cap, a refused symlink, a credential-like filename, or an unmapped/unarchivable entry all land in
 * `skipped` with a reason rather than vanishing silently. `archiveDir` and every directory created
 * under it are `0700`; every archived file is `0600` — the archive can hold no secrets by
 * construction, but it can still hold identifying personal text, so it gets the same restrictive
 * permissions as the vault and config files.
 */
export function writeImportArchive(input: WriteImportArchiveInput): WriteImportArchiveResult {
  mkdirSync(input.archiveDir, { recursive: true, mode: 0o700 })
  const state: WalkState = { archived: [], skipped: [], fileCount: 0 }
  walk(input, '', 0, state)
  return { archived: state.archived, skipped: state.skipped }
}

// --- NOTES.md (merged in from the former `import-notes.ts` — NOTES is ---
// --- written into this archive directory and describes it, so they belong ---
// --- in the same module, and apply can pass the real archive result in.) ---

/**
 * Escapes `'` for safe interpolation into a single-quoted shell argument.
 * Exported so `onboarding-step-migration.ts` can quote the same way when
 * it prints the CLI dead-end command — one escaping implementation, not two.
 */
export function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

/**
 * Builds the `NOTES.md` an apply always writes alongside the archive : what was archived and where,
 * what must be recreated by hand, what was deliberately never copied and why, and — for every
 * secret skipped because `--secrets` was not passed — the exact `vault set` command to import it
 * later. `rootDir` is threaded in separately from `plan` because that command needs the *target*
 * data directory, which `ImportPlan` itself has no reason to carry (it already has `sourceDir`, a
 * different path). Never emits a secret value: only `vaultName` (not a secret) and `rootDir` are
 * interpolated into the command, both single-quote escaped for safe shell use. `archiveResult` is
 * the REAL `WriteImportArchiveResult` from the archive walk that just ran: the plan's own archive
 * item only ever counted candidate files before any cap/filter was applied, which could — and did —
 * disagree with what was actually archived. NOTES.md now reports what happened, not what the
 * preview guessed might happen; every skipped entry is rendered with its reason under "Not
 * archived" (promise, previously discarded entirely).
 */
export function buildNotesMarkdown(input: {
  plan: ImportPlan
  rootDir: string
  now: string
  archiveResult: WriteImportArchiveResult
}): string {
  const { plan, rootDir, now, archiveResult } = input
  const label = sourceLabel(plan.source)
  const lines: string[] = []

  lines.push(`# Import notes — ${label}`, '', `Generated ${now} from \`${plan.sourceDir}\`.`, '')

  lines.push('## Archived', '')
  lines.push(
    archiveResult.archived.length > 0
      ? `- ${archiveResult.archived.length} file(s) archived — see \`import-archive/\` next to this file.`
      : '- Nothing was archived.',
    '',
  )

  lines.push('## Not archived', '')
  if (archiveResult.skipped.length === 0) {
    lines.push('- Nothing was skipped.', '')
  } else {
    for (const entry of archiveResult.skipped) lines.push(`- \`${entry.path}\` — ${entry.reason}`)
    lines.push('')
  }

  lines.push('## Recreate by hand', '')
  if (plan.notMigrated.length === 0) {
    lines.push('- Nothing.', '')
  } else {
    for (const entry of plan.notMigrated) lines.push(`- ${entry}`)
    lines.push('')
  }

  lines.push('## Deliberately not copied', '')
  lines.push(
    '- `.env`, `auth.json`, `openclaw.json` — hold secrets or OAuth credentials; run with ' +
      '`--secrets` to import the allowlisted provider keys, or recreate the rest by hand.',
    '- `state.db`, `sessions/`, `logs/`, `pending/` — runtime state with no 1:1 mapping in ' +
      'Veduta; never migrated.',
    '',
  )

  const skippedSecrets = plan.items.filter(
    (item) => item.action === 'skip' && item.target.startsWith(VAULT_TARGET_PREFIX),
  )
  if (skippedSecrets.length > 0) {
    lines.push('## Import these secrets by hand', '')
    for (const item of skippedSecrets) {
      const vaultName = item.target.slice(VAULT_TARGET_PREFIX.length)
      lines.push(
        `- ${item.detail}:`,
        '  ```',
        // `<YOUR_VALUE>` must be quoted -- an
        // unquoted `<` is parsed by the shell as input redirection, not as a
        // literal placeholder character, which would make this exact command
        // fail (or silently redirect from a file literally named
        // `YOUR_VALUE>`) if copy-pasted as printed.
        `  pnpm --filter @veduta/daemon vault set ${vaultName} '<YOUR_VALUE>' --root '${escapeSingleQuotes(rootDir)}'`,
        '  ```',
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}
