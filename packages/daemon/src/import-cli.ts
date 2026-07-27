import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ImportSourceKindSchema } from '@veduta/protocol'
import { ImportRefusedError, applyImport } from './import-apply.ts'
import { sourceLabel } from './import-mapping.ts'
import { planLegacyImport } from './import-plan.ts'
import {
  type CliIo,
  printBlockedRefusal,
  printPreview,
  printResult,
  quote,
} from './import-preview-text.ts'
import { scanLegacySecrets } from './import-secrets.ts'
import { readLegacySource, resolveLegacyDir } from './import-source.ts'
import { resolveVaultKeyMaterial, SecretsVault } from './secrets-vault.ts'

/**
 * `pnpm --filter @veduta/daemon import-legacy <openclaw|hermes> [--home <dir>] [--root <dir>]
 * [--apply] [--overwrite] [--secrets]` (issue 020, `tasks/plan.md` T6). Follows the
 * injectable `argv`/`env`/`io` shape of `backup-cli.ts`/`vault-cli.ts`, plus two importer-
 * specific seams: `stdinIsTty` (AC3 — a piped or scripted run must never apply) and
 * `serviceActive` (decision 13 — never shells out to `systemctl` inside a test).
 *
 * Script renamed from `import` to `import-legacy` (B1, this fix group's report):
 * `pnpm --filter @veduta/daemon import` is silently swallowed by pnpm's own built-in `import`
 * command (which imports a `package-lock.json`), so every dead-end command this module ever
 * printed under the old name was unrunnable exactly as printed.
 *
 * `run` never mutates anything unless `--apply` is given AND the terminal is interactive
 * AND the plan has no blocked entries: the grouped preview (`import-preview-text.ts`) is
 * always printed first, whatever the flags, so a dry run and an about-to-apply run render
 * identically up to that point (decision 7 — preview and apply share one plan). `main` is
 * gated behind the file-identity check at the bottom so importing this module never
 * executes it as a side effect.
 *
 * B6: everything from source resolution through apply (steps 1-6 in `run`'s body) runs
 * inside one try/catch, so a thrown error from any step — a planning bug, a corrupt
 * `import.json`, a `resolveVaultKeyMaterial` misconfiguration, `ImportSourceMissingError`, or
 * `applyImport`'s own `ImportRefusedError` — still yields a deterministic exit code instead of
 * an unhandled rejection. `ImportRefusedError` is the one exception with its own code (2,
 * "refusal"); everything else is an invocation or internal failure (1).
 */

export type { CliIo }

export interface RunContext {
  env?: NodeJS.ProcessEnv
  io?: CliIo
  /** Whether stdin is a TTY (issue 020 AC3). Defaults to `process.stdin.isTTY`. */
  stdinIsTty?: boolean
  /** How the daemon's service state was determined (decision 13) — see `ServiceState`. */
  serviceActive?: () => ServiceState
}

/**
 * The outcome of the `systemctl is-active` probe (decision 13, B5). Four states,
 * not three, because "we could not ask" and "we asked and the answer was garbled"
 * must lead to different decisions: with no systemd at all there is nothing to
 * race and the import proceeds with a restart reminder, whereas a probe that
 * failed for any other reason (permissions, a D-Bus error) leaves a live daemon
 * genuinely possible, and `--secrets` must refuse rather than risk clobbering the
 * vault it owns. Collapsing these into one `undefined` is what made the check
 * fail open.
 */
type ServiceState = 'active' | 'inactive' | 'no-systemd' | 'unknown'

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
}

const USAGE =
  'usage: import-legacy <openclaw|hermes> [--home <dir>] [--root <dir>] [--apply] [--overwrite] [--secrets]'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * `systemctl is-active --quiet veduta` (decision 13, B5). Exit 0 → `active`. Exit 3
 * (inactive/failed) and 4 (no such unit) are systemd's own documented answers for
 * "not running" → `inactive`. A thrown `ENOENT` means there is no systemd on this
 * host at all (a macOS dev machine, a container) → `no-systemd`. **Every other
 * outcome** — a permission error, a D-Bus failure, an exit status we do not
 * recognise — is `unknown`, and `--secrets` refuses on it: reading a failed probe
 * as "inactive" is what let a second vault writer through. Never called directly
 * by `run`; always through the injectable `serviceActive` seam so tests never
 * depend on the host actually having systemd.
 */
function defaultServiceActive(): ServiceState {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'veduta'], { stdio: 'ignore' })
    return 'active'
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'no-systemd'
    const status = (error as { status?: unknown }).status
    return status === 3 || status === 4 ? 'inactive' : 'unknown'
  }
}

/**
 * Runs one CLI invocation and returns an exit code (never throws for an expected refusal —
 * every thrown error is caught by the single try/catch around steps 1-6, per B6 above).
 * Reading the source and building the plan (steps 1-4) never mutate anything — `planLegacyImport`
 * is the same pure-`fs` `readTargetState`/`loadImportState`/`buildImportPlan` composition
 * `applyImportLocked` itself recomputes inside the lock. Mutation can only happen past the
 * `--apply` + TTY + unblocked gates below, inside `applyImport`'s own lock.
 */
export async function run(argv: string[], context: RunContext = {}): Promise<number> {
  const env = context.env ?? process.env
  const io = context.io ?? defaultIo
  const stdinIsTty = context.stdinIsTty ?? Boolean(process.stdin.isTTY)
  const serviceActive = context.serviceActive ?? defaultServiceActive

  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        home: { type: 'string' },
        root: { type: 'string' },
        apply: { type: 'boolean', default: false },
        overwrite: { type: 'boolean', default: false },
        secrets: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    io.stderr(errorText(error))
    io.stderr(USAGE)
    return 1
  }

  // B6: exactly one positional required. `parseArgs` with `allowPositionals: true` otherwise
  // silently ignores every positional past the first, which would let
  // `import-legacy hermes some-typo-of-a-flag` quietly run the same as `import-legacy hermes`.
  if (parsed.positionals.length !== 1) {
    io.stderr(
      parsed.positionals.length === 0
        ? 'missing source: expected exactly one of openclaw|hermes'
        : `unexpected extra argument(s): ${parsed.positionals.slice(1).join(' ')}`,
    )
    io.stderr(USAGE)
    return 1
  }

  const sourceArg = parsed.positionals[0]
  const kindResult = ImportSourceKindSchema.safeParse(sourceArg)
  if (!kindResult.success) {
    io.stderr(`unknown source: ${sourceArg ?? '(none given)'}`)
    io.stderr(USAGE)
    return 1
  }
  const kind = kindResult.data
  const options = {
    overwrite: parsed.values['overwrite'] === true,
    secrets: parsed.values['secrets'] === true,
  }

  const rootDir =
    (parsed.values['root'] as string | undefined) ??
    env['VEDUTA_DATA_DIR'] ??
    join(process.cwd(), '.veduta')
  const home =
    (parsed.values['home'] as string | undefined) ?? env['VEDUTA_LEGACY_HOME'] ?? homedir()
  const stagedDir = join(rootDir, 'import-source', kind)

  // B6: everything below — source resolution, reading, plan-building, and apply — runs
  // inside one try/catch, so a thrown error from any step (a `buildImportPlan`/schema bug, a
  // corrupt `import.json`, `ImportSourceMissingError` from a source that raced out from under
  // us between `resolveLegacyDir` and `readLegacySource`, ...) still yields a deterministic
  // exit code instead of an unhandled rejection reaching `main`'s `.then`. `ImportRefusedError`
  // (thrown only from inside `applyImport`'s lock) is the one exception with its own exit code.
  try {
    // Step 1: resolve the source directory — staged dir first (decision 16), then the live home.
    const sourceDir = resolveLegacyDir({ kind, stagedDir, home })
    if (sourceDir === undefined) {
      io.stderr(`no legacy ${sourceLabel(kind)} install found. Searched:`)
      io.stderr(`  staged directory: ${quote(stagedDir)}`)
      io.stderr(`  home directory: ${quote(home)}`)
      return 1
    }

    // Step 2: read the snapshot and scan secrets — both pure, hardened reads (decision 6/14).
    const snapshot = readLegacySource(sourceDir, kind)
    const secrets = scanLegacySecrets({ kind, dir: sourceDir })

    // Step 3: vault key material decides `backupAvailable` for the plan — a missing key is
    // not an error at preview time, it becomes a `blocked` entry the preview shows.
    const keyMaterial = resolveVaultKeyMaterial(env)

    // Step 4: the plan — `planLegacyImport` (`import-plan.ts`) is the exact
    // `readTargetState`/`loadImportState`/`buildImportPlan` composition `applyImportLocked`
    // itself uses inside the lock, so this dry-run print and what apply actually recomputes
    // can never structurally disagree.
    const plan = planLegacyImport({
      rootDir,
      snapshot,
      secrets,
      options,
      backupAvailable: keyMaterial !== undefined,
    })

    // Step 5: always print the grouped preview first, whatever the flags.
    printPreview(io, plan)

    // Step 6: decide.
    if (parsed.values['apply'] !== true) {
      io.stdout('')
      io.stdout('run again with --apply to perform the import')
      return 0
    }

    if (plan.blocked.length > 0) {
      printBlockedRefusal(io, plan, kind, rootDir, home)
      return 2
    }

    if (!stdinIsTty) {
      // Issue 020 AC3: a piped or scripted run only ever previews. Returning 0 here would let
      // a pipeline believe it imported when nothing was written.
      io.stdout('')
      io.stdout(
        'applying requires an interactive terminal; a piped or scripted run only ever previews the import.',
      )
      return 2
    }

    if (options.secrets) {
      const state = serviceActive()
      if (state === 'active' || state === 'unknown') {
        const reason =
          state === 'active'
            ? 'the veduta service appears to be active'
            : 'the veduta service state could not be determined (the systemctl probe failed)'
        io.stdout('')
        io.stdout(
          `refusing: ${reason}, and --secrets would race its in-memory vault (decision 13). ` +
            'Stop it first:',
        )
        io.stdout('  sudo systemctl stop veduta')
        io.stdout('then re-run this import, and start it again afterwards:')
        io.stdout('  sudo systemctl start veduta')
        return 2
      }
      if (state === 'no-systemd') {
        io.stdout('')
        io.stdout(
          'warning: there is no systemd on this host, so whether a daemon is running cannot be ' +
            'checked. Restart the daemon afterwards so it reloads the vault: sudo systemctl restart veduta',
        )
      }
    }

    const vault = keyMaterial === undefined ? undefined : SecretsVault.open(rootDir, keyMaterial)
    const result = await applyImport(
      {
        rootDir,
        ...(vault === undefined ? {} : { vault }),
        ...(keyMaterial === undefined ? {} : { keyMaterial }),
      },
      { snapshot, secrets, options },
    )
    printResult(io, result)
    return 0
  } catch (error) {
    if (error instanceof ImportRefusedError) {
      io.stderr(error.message)
      return 2
    }
    io.stderr(errorText(error))
    return 1
  }
}

function main(): void {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

if (process.argv[1] && process.argv[1].endsWith('import-cli.ts')) main()
