import type { ImportItem, ImportPlan, ImportResult, ImportSourceKind } from '@veduta/protocol'
import { escapeSingleQuotes } from './import-archive.ts'
import { sourceLabel } from './import-mapping.ts'
import { VAULT_UNAVAILABLE_MESSAGE } from './onboarding-status.ts'

/**
 * The CLI's text format, split out of `import-cli.ts` so the format is
 * testable in isolation from process plumbing (argv/env/exit codes). Every function here
 * only ever writes through the injected `io` — never `console.*` directly — and never reads
 * a secret value: vault items are rendered straight from `plan.items[].detail`, which
 * `buildImportPlan` (`import-plan.ts`) already guarantees is names-only, whichever way
 * `options.secrets` went (asserted directly by `import-plan.test.ts`) — there is no second,
 * parallel rendering of secret names to keep in sync with that guarantee.
 */

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

/**
 * Single-quote-escapes `value` for safe interpolation into a printed shell command . A thin
 * wrapper, not a second implementation ('s own rule extended to this module): `escapeSingleQuotes`
 * in `import-archive.ts` is the one escaping implementation; this only adds the surrounding quotes.
 */
export function quote(value: string): string {
  return `'${escapeSingleQuotes(value)}'`
}

/** What every printed/documented import command needs: built in exactly one place, so
 * the CLI's own blocked-refusal printer, the wizard routes' dead ends, and `deploy/README.md`
 * (which reproduces this shape by hand, since docs cannot import this module) can never drift
 * into three independently-wrong command strings again. `script` defaults to `import-legacy`
 * (`pnpm ... import` is shadowed by pnpm's own built-in `import` command, so the package
 * script was renamed) — parameterized only so a test can override it if the script is ever
 * renamed again. Every path is escaped through `quote` above.
 */
interface BuildImportCommandOptions {
  kind: ImportSourceKind
  rootDir: string
  home?: string
  apply?: boolean
  overwrite?: boolean
  secrets?: boolean
  /** Prefix with `sudo` (the wizard's dead ends run under `ProtectHome=yes`, needing root to read the admin's home). */
  sudo?: boolean
  script?: string
}

export function buildImportCommand(options: BuildImportCommandOptions): string {
  const script = options.script ?? 'import-legacy'
  const flags: string[] = []
  if (options.apply === true) flags.push('--apply')
  if (options.overwrite === true) flags.push('--overwrite')
  if (options.secrets === true) flags.push('--secrets')
  flags.push(`--root ${quote(options.rootDir)}`)
  if (options.home !== undefined) flags.push(`--home ${quote(options.home)}`)
  const prefix = options.sudo === true ? 'sudo ' : ''
  return `${prefix}pnpm --filter @veduta/daemon ${script} ${options.kind} ${flags.join(' ')}`
}

const ACTION_GROUPS: ReadonlyArray<{ action: ImportItem['action']; heading: string }> = [
  { action: 'import', heading: 'Import' },
  { action: 'overwrite', heading: 'Overwrite' },
  { action: 'skip', heading: 'Skip' },
]

function printGroup(io: CliIo, heading: string, lines: readonly string[]): void {
  io.stdout(`${heading}:`)
  if (lines.length === 0) {
    io.stdout('  none')
    return
  }
  for (const line of lines) io.stdout(`  ${line}`)
}

function defaultItemLine(item: ImportItem): string {
  const reason = item.reason === undefined ? '' : ` (${item.reason})`
  return `${item.target}: ${item.detail}${reason}`
}

/**
 * The grouped preview: always printed first, whatever the flags, so a dry run and an about-to-apply
 * run render identically up to this point. Order is fixed — Import, Overwrite, Skip, Warnings, the
 * adapted SOUL.md text (when `plan.soulPreview` is present), Not migrated, Blocked — and an empty
 * group prints a single "none" line rather than vanishing, so the shape of the output never depends
 * on how much a given source happened to have. Vault items are rendered exactly like every other
 * item, straight from `item.target`/`item.detail`/`item.reason` (the former `describeSecrets`-based
 * rendering was a second, parallel implementation of exactly what `buildImportPlan` already
 * guarantees — its `detail` for a `vault:*` item is names-only at either value of
 * `options.secrets`, asserted directly by `import-plan.test.ts` — so this function no longer needs
 * a `SecretScan` argument at all).
 */
export function printPreview(io: CliIo, plan: ImportPlan): void {
  io.stdout(`Import plan for ${sourceLabel(plan.source)} — source: ${plan.sourceDir}`)
  io.stdout('')

  for (const group of ACTION_GROUPS) {
    const lines = plan.items
      .filter((item) => item.action === group.action)
      .map((item) => defaultItemLine(item))
    printGroup(io, group.heading, lines)
    io.stdout('')
  }

  printGroup(io, 'Warnings', plan.warnings)
  io.stdout('')
  printSoulPreview(io, plan.soulPreview)
  printGroup(io, 'Not migrated', plan.notMigrated)
  io.stdout('')
  printGroup(io, 'Blocked', plan.blocked)
}

const SOUL_PREVIEW_RULE = '-'.repeat(50)

/**
 * The one place this CLI intentionally prints a large block (ADR-0010): the full adapted `SOUL.md`
 * text, so the user can actually act on the warning above telling them to read it before anything
 * is written. Clearly delimited so it cannot be mistaken for another group's output; a no-op when
 * the plan has nothing to write to `SOUL.md` (skipped, blocked, or absent from the source).
 */
function printSoulPreview(io: CliIo, soulPreview: string | undefined): void {
  if (soulPreview === undefined) return
  io.stdout('Adapted SOUL.md (this exact text will be written):')
  io.stdout(SOUL_PREVIEW_RULE)
  io.stdout(soulPreview)
  io.stdout(SOUL_PREVIEW_RULE)
  io.stdout('')
}

/**
 * Printed once `--apply` hits a blocked plan (issue AC2). Every blocked reason
 * is printed verbatim, plus the exact next command for whichever blockers are clearable: a
 * re-run with `--overwrite` when a conflict caused the block, the vault keyfile provisioning
 * commands when the block is "no backup possible". A stale `import.lock` never reaches this
 * path — that refusal only ever surfaces from `applyImport` itself, whose message already
 * carries its own quoted `rm` command.
 */
export function printBlockedRefusal(
  io: CliIo,
  plan: ImportPlan,
  kind: ImportSourceKind,
  rootDir: string,
  home: string,
): void {
  io.stdout('')
  io.stdout('import refused:')
  for (const reason of plan.blocked) io.stdout(`- ${reason}`)

  if (plan.requiresOverwrite) {
    io.stdout('')
    io.stdout('next command:')
    // carries forward this run's own `--secrets` choice (`plan.options.secrets`) — a
    // recovery command that silently dropped an already-made `--secrets` choice would import
    // fewer things than the run the user actually meant to retry.
    io.stdout(
      `  ${buildImportCommand({
        kind,
        rootDir,
        home,
        apply: true,
        overwrite: true,
        ...(plan.options.secrets ? { secrets: true } : {}),
      })}`,
    )
  }
  if (plan.blocked.some((reason) => reason.startsWith('No backup can be taken'))) {
    io.stdout('')
    io.stdout(VAULT_UNAVAILABLE_MESSAGE)
  }
}

/** The result summary printed after a successful apply — paths and counts only, never a secret value. */
export function printResult(io: CliIo, result: ImportResult): void {
  io.stdout('')
  io.stdout('import complete:')
  io.stdout(
    `  facts: ${result.facts.added} added, ${result.facts.updated} updated, ` +
      `${result.facts.superseded} superseded, ${result.facts.noop} unchanged, ` +
      `${result.facts.overflow} overflowed to the Event log`,
  )
  io.stdout(`  events appended: ${result.eventsAppended}`)
  io.stdout(`  SOUL.md updated: ${result.soulUpdated ? 'yes' : 'no'}`)
  io.stdout(`  USER.md updated: ${result.userUpdated ? 'yes' : 'no'}`)
  io.stdout(
    result.secretsImported.length === 0
      ? '  secrets imported: none'
      : `  secrets imported: ${result.secretsImported.join(', ')}`,
  )
  io.stdout(`  backup: ${result.backupPath}`)
  io.stdout(`  archive: ${result.archiveDir}`)
  io.stdout(`  notes: ${result.notesPath}`)
}
