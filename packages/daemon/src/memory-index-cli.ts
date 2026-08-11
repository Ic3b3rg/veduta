import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { MemoryIndex } from './memory-index.ts'
import { SpacesEngine } from './spaces-engine.ts'

/**
 * `pnpm --filter @veduta/daemon memory-index <rebuild|reconcile|status> [--root <dir>]`
 * (issues/021-advanced-memory.md). `run` takes injectable `argv`/`env`/`io` so it is
 * testable without touching `process.*` and returns an exit code; `main` wires it to
 * the real process and is gated behind the file-identity check below so importing
 * this module (e.g. from a test) never executes it.
 *
 * The hybrid index is disposable by design (docs/adr/0006-file-based-memory.md: the
 * files under `SpacesEngine`'s root are the truth, the index only makes them
 * findable), which is exactly why `rebuild` here is a supported, ordinary operation
 * rather than a recovery of last resort. `MemoryIndex.rebuild()` alone cannot do the
 * whole job: unlinking `memory.sqlite` while a connection still has it open does
 * nothing useful on Unix, since the open file descriptor keeps writing through the
 * unlinked inode. So this command closes the index first, removes the database file
 * together with its `-wal`/`-shm` companions, then opens a fresh index and
 * reconciles it against the files. `reconcile` alone (no delete) is the cheap,
 * non-destructive path for the common case where the index is merely behind.
 *
 * `--root` must point at the daemon's data directory (the same one the Gateway
 * uses, i.e. `VEDUTA_DATA_DIR`), matching the convention `vault-cli.ts` and
 * `backup-cli.ts` already use.
 */

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const USAGE = 'usage: memory-index <rebuild|reconcile|status> [--root <dir>]'

/** Deletes `memory.sqlite` and its `-wal`/`-shm` companions if present. The caller must have closed the index first. */
function removeMemoryDatabase(rootDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(rootDir, `memory.sqlite${suffix}`)
    if (existsSync(path)) unlinkSync(path)
  }
}

function printRecordCounts(io: CliIo, index: MemoryIndex): void {
  const { records } = index.status()
  for (const record of records) {
    io.stdout(`${record.spaceId}: ${record.events} event(s), ${record.facts} fact(s)`)
  }
  io.stdout(`total: ${index.recordCount()} record(s)`)
}

/**
 * Runs one CLI invocation. Always closes whichever `MemoryIndex` it opened
 * before returning, including on the error paths, so the process never
 * leaves a WAL file behind for the next invocation to trip over.
 */
export async function run(
  argv: string[],
  context: { env?: NodeJS.ProcessEnv; io?: CliIo } = {},
): Promise<number> {
  const env = context.env ?? process.env
  const io = context.io ?? defaultIo

  let parsed: { values: { root?: string }; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      options: { root: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  }
  const [command] = parsed.positionals
  if (command !== 'rebuild' && command !== 'reconcile' && command !== 'status') {
    io.stderr(USAGE)
    return 1
  }

  const rootDir = parsed.values.root ?? env['VEDUTA_DATA_DIR'] ?? join(process.cwd(), '.veduta')
  const spacesEngine = new SpacesEngine({ rootDir })

  let index: MemoryIndex | undefined
  try {
    // `rebuild` deletes before it opens anything. Opening first would make the
    // recovery command fail on exactly the case it exists for: a database
    // corrupt enough that `DatabaseSync` throws on its header. Nothing is lost
    // by deleting unread — the index holds no truth of its own
    // (docs/adr/0011-disposable-hybrid-index.md).
    if (command === 'rebuild') {
      removeMemoryDatabase(rootDir)
      index = new MemoryIndex({ rootDir, spacesEngine })
      index.reconcile()
      printRecordCounts(io, index)
      return 0
    }

    index = new MemoryIndex({ rootDir, spacesEngine })

    if (command === 'reconcile') {
      index.reconcile()
      printRecordCounts(io, index)
      return 0
    }

    // status: read-only, so nothing above is written here.
    const status = index.status()
    io.stdout(`schema version: ${status.schemaVersion}`)
    io.stdout(`last build: ${status.builtAt ?? 'unknown'}`)
    for (const record of status.records) {
      io.stdout(`${record.spaceId}: ${record.events} event(s), ${record.facts} fact(s)`)
    }
    return 0
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  } finally {
    index?.close()
  }
}

function main(): void {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

if (process.argv[1] && process.argv[1].endsWith('memory-index-cli.ts')) main()
