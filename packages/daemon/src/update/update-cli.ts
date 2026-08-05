import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UpdateMarkerSchema, UpdatePinningSchema } from '@veduta/protocol'
import type { UpdateMarker, UpdatePinning } from '@veduta/protocol'
import { resolveVaultKeyMaterial } from '../secrets-vault.ts'
import { resolveInstalledVersion } from '../version.ts'
import { readDataVersion } from './data-version.ts'
import {
  defaultPorts,
  finalizeUpdate,
  resolveUpdateHome,
  resumeUpdateTransaction,
  rollbackUpdate,
  runUpdateTransaction,
  sweepAckedResult,
  type Ports,
  type ResumeOptions,
  type ResumeOutcome,
  type UpdateHome,
} from './update-transaction.ts'

/**
 * `tsx src/update/update-cli.ts <run|finalize --version <v>|rollback --reason <text>>` — run
 * from the *old* (executor) release by `deploy/veduta-run` to drive one step of the update
 * transaction (`update-transaction.ts`; `docs/adr/0013-signed-self-update.md`'s "Amendments"
 * section). This module owns none of the transaction logic itself: it only resolves the
 * environment contract (update home, data root, pinning, vault key material), decides which of
 * `runUpdateTransaction` / `resumeUpdateTransaction` / `finalizeUpdate` / `rollbackUpdate`
 * applies, and prints exactly one machine-parseable `update-cli: <outcome>` line to stdout so
 * the bash wrapper never has to parse anything richer than a single trailing word. Every other
 * line this process prints — the transaction's own stage-by-stage narration — goes to stderr,
 * via `Ports.log` (`update-transaction.ts`'s `defaultPorts`).
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markerJsonPath(home: UpdateHome): string {
  return join(home.stateDir, 'marker.json')
}

function journalJsonPath(home: UpdateHome): string {
  return join(home.stateDir, 'update-state.json')
}

/**
 * Reads and validates `VEDUTA_UPDATE_PINNING` (the root-owned `/etc/veduta/update.json` in
 * production, `deploy/install.sh`). A fork/instance that never passed `--update-root-key` at
 * install time has no pinning file at all — that must never crash this CLI's `run` mode when
 * there is nothing to do (no marker, no journal), so this is only ever called once a transaction
 * is actually about to run; neither a marker nor a journal could exist without pinning having
 * already been configured when the daemon offered/applied the update in the first place.
 */
function readPinning(path: string | undefined): UpdatePinning {
  if (path === undefined || path.length === 0) {
    throw new Error('VEDUTA_UPDATE_PINNING is required (path to update.json) to run a transaction')
  }
  if (!existsSync(path)) {
    throw new Error(`VEDUTA_UPDATE_PINNING points at a file that does not exist: ${path}`)
  }
  return UpdatePinningSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

function readKeyMaterial(env: NodeJS.ProcessEnv): Buffer {
  const keyMaterial = resolveVaultKeyMaterial(env)
  if (!keyMaterial) {
    throw new Error(
      'no vault key material found; set VEDUTA_VAULT_KEYFILE (path to a keyfile) or VEDUTA_VAULT_KEY',
    )
  }
  return keyMaterial
}

/**
 * Where the code that is running right now lives when there is no
 * `releases/current` yet — the git checkout `deploy/install.sh` deploys, which
 * on a first-ever update is the only place the *old* release exists. The
 * transaction records it as the journal's executor so a crash after the symlink
 * flip still recovers using the previous code rather than the candidate it is
 * installing (`docs/adr/0013-signed-self-update.md`). `deploy/veduta-run`
 * exports it on every invocation; the default matches the installer's layout.
 */
const DEFAULT_LEGACY_ROOT = '/opt/veduta'

function buildResumeOptions(
  home: UpdateHome,
  dataRootDir: string,
  env: NodeJS.ProcessEnv,
  ports: Ports,
): ResumeOptions {
  return {
    home,
    dataRootDir,
    pinning: readPinning(env['VEDUTA_UPDATE_PINNING']),
    installedVersion: resolveInstalledVersion(env),
    installedDataVersion: readDataVersion(dataRootDir) ?? 0,
    keyMaterial: readKeyMaterial(env),
    legacyRoot: env['VEDUTA_LEGACY_ROOT'] || DEFAULT_LEGACY_ROOT,
    ports,
    env,
  }
}

/**
 * Prints the one `update-cli: <outcome>` line `deploy/veduta-run` parses off stdout, for every
 * shape `runUpdateTransaction`/`resumeUpdateTransaction` can return. A `success` terminal here
 * only happens by resuming after a crash between `finalizeUpdate`'s `result.json` write and its
 * journal archive (`update-transaction.ts`'s `resumeUpdateTransaction` interrupted-finalize
 * branch) — the update itself already completed, so `none` (nothing left for the wrapper to
 * react to beyond starting the daemon normally) is the honest outcome word, not a fifth token the
 * wrapper was never told to expect.
 */
function printRunOutcome(outcome: ResumeOutcome): number {
  if (outcome.status === 'nothing-to-resume') {
    console.log('update-cli: none')
    return 0
  }
  if (outcome.status === 'awaiting-stage-2') {
    console.log('update-cli: awaiting-stage-2')
    return 0
  }
  if (outcome.result.outcome === 'success') {
    console.log('update-cli: none')
    return 0
  }
  const word = outcome.result.outcome === 'refused' ? 'refused' : 'rolled-back'
  console.log(`update-cli: ${word}`)
  return 0
}

async function runMode(
  home: UpdateHome,
  dataRootDir: string,
  env: NodeJS.ProcessEnv,
  ports: Ports,
): Promise<number> {
  sweepAckedResult(home)

  const markerPath = markerJsonPath(home)
  const journalPath = journalJsonPath(home)

  if (existsSync(markerPath)) {
    const marker: UpdateMarker = UpdateMarkerSchema.parse(
      JSON.parse(readFileSync(markerPath, 'utf8')),
    )
    const options = buildResumeOptions(home, dataRootDir, env, ports)
    return printRunOutcome(await runUpdateTransaction({ ...options, marker }))
  }

  if (existsSync(journalPath)) {
    const options = buildResumeOptions(home, dataRootDir, env, ports)
    return printRunOutcome(await resumeUpdateTransaction(options))
  }

  console.log('update-cli: none')
  return 0
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx === -1 ? undefined : args[idx + 1]
}

async function finalizeMode(
  home: UpdateHome,
  dataRootDir: string,
  env: NodeJS.ProcessEnv,
  ports: Ports,
  args: string[],
): Promise<number> {
  const version = flagValue(args, 'version')
  if (version === undefined || version.length === 0) {
    throw new Error('finalize requires --version <v>')
  }
  const journalPath = journalJsonPath(home)
  if (!existsSync(journalPath)) throw new Error('finalize: no active update journal found')
  // A lightweight cross-check, not a re-implementation of the journal schema (`update-transaction.ts`
  // keeps that private): `--version` is the wrapper's own record of which release it just ran
  // stage 2 against, and this catches finalizing the wrong transaction rather than silently
  // trusting the caller.
  const journalRaw = JSON.parse(readFileSync(journalPath, 'utf8')) as { toVersion?: unknown }
  if (journalRaw.toVersion !== version) {
    throw new Error(
      `finalize: --version ${version} does not match the active journal's toVersion ` +
        `${String(journalRaw.toVersion)}`,
    )
  }
  const options = buildResumeOptions(home, dataRootDir, env, ports)
  await finalizeUpdate(options)
  console.log('update-cli: finalized')
  return 0
}

async function rollbackMode(
  home: UpdateHome,
  dataRootDir: string,
  env: NodeJS.ProcessEnv,
  ports: Ports,
  args: string[],
): Promise<number> {
  const reason = flagValue(args, 'reason')
  if (reason === undefined || reason.length === 0) {
    throw new Error('rollback requires --reason <text>')
  }
  const options = buildResumeOptions(home, dataRootDir, env, ports)
  await rollbackUpdate(options, reason)
  console.log('update-cli: rolled-back')
  return 0
}

/**
 * Direct-invocation entry point for tests, and for the real process wiring at the bottom of this
 * file: everything the process needs comes in as `args`/`env`, plus an optional `Ports` override
 * so tests never touch a real network, subprocess, or disk-space check. Returns the process exit
 * code rather than setting `process.exitCode` itself, so a test never has to reset global state
 * between cases.
 */
export async function main(
  args: string[],
  env: NodeJS.ProcessEnv,
  portsOverride?: Ports,
): Promise<number> {
  const updateHomeRaw = env['VEDUTA_UPDATE_HOME']
  const dataRootDir = env['VEDUTA_DATA_DIR']
  if (updateHomeRaw === undefined || updateHomeRaw.length === 0 || !dataRootDir) {
    console.error('update-cli: VEDUTA_UPDATE_HOME and VEDUTA_DATA_DIR are both required')
    return 2
  }

  const ports = portsOverride ?? defaultPorts()
  const home = resolveUpdateHome(updateHomeRaw)
  const [mode, ...rest] = args

  try {
    switch (mode) {
      case 'run':
      case undefined:
        return await runMode(home, dataRootDir, env, ports)
      case 'finalize':
        return await finalizeMode(home, dataRootDir, env, ports, rest)
      case 'rollback':
        return await rollbackMode(home, dataRootDir, env, ports, rest)
      default:
        console.error(`update-cli: unknown mode '${mode}' (expected run|finalize|rollback)`)
        return 1
    }
  } catch (error) {
    console.error(`update-cli: ${errorText(error)}`)
    return 1
  }
}

function realMain(): void {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code
  })
}

if (process.argv[1] && process.argv[1].endsWith('update-cli.ts')) realMain()
