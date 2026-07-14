import { join } from 'node:path'
import { SecretsVault, resolveVaultKeyMaterial } from './secrets-vault.ts'

/**
 * `pnpm --filter @veduta/daemon vault <set <name> <value>|list|delete <name>> [--root <dir>]`
 * (issue #15 D2). `run` takes injectable `argv`/`env`/`io` so it is testable
 * without touching `process.*` and returns an exit code; `main` wires it to
 * the real process and is gated behind the file-identity check below so
 * importing this module (e.g. from a test) never executes it.
 *
 * `--root` must point at the daemon's data directory (the same one the
 * Gateway uses, i.e. `VEDUTA_DATA_DIR`), so secrets land in the vault the
 * running daemon actually reads. Never prints secret values.
 */

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
}

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string>
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value === undefined) throw new Error(`missing value for --${key}`)
      flags[key] = value
      i++
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function run(argv: string[], context: { env?: NodeJS.ProcessEnv; io?: CliIo } = {}): number {
  const env = context.env ?? process.env
  const io = context.io ?? defaultIo

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  }
  const [command, name, value] = parsed.positionals
  const rootDir = parsed.flags['root'] ?? env['VEDUTA_DATA_DIR'] ?? join(process.cwd(), '.veduta')

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
    const vault = SecretsVault.open(rootDir, keyMaterial)
    if (command === 'list') {
      for (const entryName of vault.list()) io.stdout(entryName)
      return 0
    }
    if (command === 'set') {
      if (!name || value === undefined) {
        io.stderr('usage: vault set <name> <value> [--root <dir>]')
        return 1
      }
      vault.set(name, value)
      io.stdout(`stored ${name}`)
      return 0
    }
    if (command === 'delete') {
      if (!name) {
        io.stderr('usage: vault delete <name> [--root <dir>]')
        return 1
      }
      io.stdout(vault.delete(name) ? `deleted ${name}` : `${name} was not set`)
      return 0
    }
    io.stderr('usage: vault <set <name> <value>|list|delete <name>> [--root <dir>]')
    return 1
  } catch (error) {
    io.stderr(errorText(error))
    return 1
  }
}

function main(): void {
  process.exitCode = run(process.argv.slice(2))
}

if (process.argv[1] && process.argv[1].endsWith('vault-cli.ts')) main()
