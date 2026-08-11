import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createBackup, pruneBackups, restoreBackup } from './backup.ts'
import { resolveVaultKeyMaterial } from './secrets-vault.ts'

/**
 * `pnpm --filter @veduta/daemon backup <backup|restore <file>|prune>`
 * (issue #15). `run` takes injectable `argv`/`env`/`io` so it is testable
 * without touching `process.*`; `main` wires it to the real process and is
 * gated behind the file-identity check below so importing this module (e.g.
 * from a future test) never executes it as a side effect.
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

/**
 * Runs one CLI invocation. Never prints secret values: only file paths and
 * generic status/error text ever reach `io`.
 */
export async function run(
  argv: string[],
  context: { env?: NodeJS.ProcessEnv; io?: CliIo } = {},
): Promise<number> {
  const env = context.env ?? process.env
  const io = context.io ?? defaultIo
  const [command, ...rest] = argv

  let parsed: {
    values: { root?: string; out?: string; keep?: string; target?: string }
    positionals: string[]
  }
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        root: { type: 'string' },
        out: { type: 'string' },
        keep: { type: 'string' },
        target: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  }
  const { positionals, values: flags } = parsed

  const rootDir = flags['root'] ?? env['VEDUTA_DATA_DIR'] ?? join(process.cwd(), '.veduta')
  const outDir = flags['out'] ?? join(rootDir, 'backups')
  const keep = flags['keep'] !== undefined ? Number(flags['keep']) : undefined

  let keyMaterial: Buffer | undefined
  try {
    keyMaterial = resolveVaultKeyMaterial(env)
  } catch (error) {
    // e.g. VEDUTA_VAULT_KEYFILE points at a missing/unreadable file.
    io.stderr(errorText(error))
    return 1
  }
  if (!keyMaterial) {
    io.stderr(
      'no vault key material found; set VEDUTA_VAULT_KEYFILE (path to a keyfile) or VEDUTA_VAULT_KEY',
    )
    return 1
  }

  try {
    switch (command) {
      case 'backup': {
        const path = await createBackup({ rootDir, outDir, keyMaterial })
        io.stdout(`backup written: ${path}`)
        return 0
      }
      case 'restore': {
        const file = positionals[0]
        const target = flags['target']
        if (!file || !target) {
          io.stderr('usage: backup restore <file> --target <dir>')
          return 1
        }
        await restoreBackup({ file, targetRootDir: target, keyMaterial })
        io.stdout(`restored to: ${target}`)
        return 0
      }
      case 'prune': {
        const deleted = pruneBackups(keep === undefined ? { outDir } : { outDir, keep })
        for (const path of deleted) io.stdout(`deleted: ${path}`)
        return 0
      }
      default: {
        io.stderr(
          'usage: backup <backup|restore <file> --target <dir>|prune> [--root <dir>] [--out <dir>] [--keep <n>]',
        )
        return 1
      }
    }
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  }
}

function main(): void {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

if (process.argv[1] && process.argv[1].endsWith('backup-cli.ts')) main()
