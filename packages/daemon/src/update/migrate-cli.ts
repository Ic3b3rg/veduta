import { CURRENT_DATA_VERSION, readDataVersion } from './data-version.ts'
import { runMigrations } from './migrations.ts'

/**
 * `tsx src/update/migrate-cli.ts --root <dataRoot> --to <n>` — spawned by the update
 * transaction's own migrate step (`update-transaction.ts`'s `runMigrationStep`) from the *new*
 * release, since only the new release's own copy of this CLI knows the target schema
 * (`docs/adr/0013-signed-self-update.md`'s self-update amendments). The transaction itself is
 * still running as the *old* executor at this point — this process is the one part of the
 * whole transaction that runs new code, on purpose.
 *
 * Reads the data root's current `dataVersion` (`readDataVersion`; a root with no marker at all
 * starts at 0 — the same pre-issue-43 baseline `data-version.ts`'s `ensureDataVersion` bootstraps
 * from), runs every migration in `(from, to]` via `runMigrations`, and logs one line per step
 * actually run to stderr — this process's own stdout/stderr are captured by the transaction's
 * `execFile` call and folded into `state/logs/<version>.log`, so this is what makes "what
 * actually migrated" visible in that log.
 *
 * Refuses a `--to` greater than this build's own `CURRENT_DATA_VERSION`: the new release can
 * never be asked to migrate past a schema version it does not itself understand. Also refuses a
 * `--to` less than the root's current `dataVersion` — migrations are forward-only by design
 * (`docs/adr/0013-signed-self-update.md`); nothing in this repository ever asks for a downgrade
 * in practice (the transaction's own `checkMonotonic` already refuses a non-monotonic offer
 * before this CLI is ever invoked), but this CLI must not silently do something destructive if
 * it ever is.
 */

interface ParsedArgs {
  root?: string
  to?: number
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--root') {
      const value = args[i + 1]
      if (value !== undefined) parsed.root = value
      i++
    } else if (arg === '--to') {
      const value = args[i + 1]
      if (value !== undefined && value.trim().length > 0) parsed.to = Number(value)
      i++
    }
  }
  return parsed
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Direct-invocation entry point for tests, and for the real process wiring at the bottom of
 * this file — `args` is everything after the script path (`process.argv.slice(2)`). Sets
 * `process.exitCode` rather than calling `process.exit` so a caller (a test, or the transaction's
 * own `execFile`) always sees a clean, flushed exit. */
export function main(args: string[]): void {
  const { root, to } = parseArgs(args)
  if (root === undefined || root.length === 0 || to === undefined || !Number.isInteger(to)) {
    console.error('usage: migrate-cli --root <dataRoot> --to <n>')
    process.exitCode = 1
    return
  }

  if (to > CURRENT_DATA_VERSION) {
    console.error(
      `migrate-cli: refusing --to ${to}: this build's CURRENT_DATA_VERSION is only ${CURRENT_DATA_VERSION}`,
    )
    process.exitCode = 1
    return
  }

  let from: number
  try {
    from = readDataVersion(root) ?? 0
  } catch (error) {
    console.error(`migrate-cli: ${errorText(error)}`)
    process.exitCode = 1
    return
  }

  if (from > to) {
    console.error(`migrate-cli: refusing to migrate backwards from dataVersion ${from} to ${to}`)
    process.exitCode = 1
    return
  }

  try {
    const ran = runMigrations(root, { from, to })
    if (ran.length === 0) {
      console.error(`migrate-cli: dataVersion already at ${from}; nothing to migrate`)
    } else {
      for (const step of ran) {
        console.error(`migrate-cli: ran migration -> dataVersion ${step}`)
      }
    }
    process.exitCode = 0
  } catch (error) {
    console.error(`migrate-cli: migration failed: ${errorText(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-cli.ts')) main(process.argv.slice(2))
