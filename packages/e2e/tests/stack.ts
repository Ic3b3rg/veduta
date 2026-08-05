import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// packages/e2e/tests/ -> packages/e2e/ -> packages/ -> repo root.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RUNNER_SCRIPT = join(REPO_ROOT, 'deploy', 'local-vps.sh')

const READY_LINE = /^veduta daemon \(local vps profile\) -> http:\/\/localhost:(\d+)$/
const SETUP_URL_LINE = /^veduta first-boot setup URL: (http:\/\/localhost:\d+\/setup\?code=(\S+))$/

/**
 * One journey's worth of Local VPS profile process supervision (issue 023,
 * `docs/adr/0009-local-vps-profile.md`). `deploy/local-vps.sh`
 * itself passes the daemon's own stdout straight through untouched, so the
 * two lines the spec's acceptance criteria hinge on land on this process's
 * stdout verbatim:
 *
 *   veduta first-boot setup URL: http://localhost:<port>/setup?code=<code>
 *     -- printed only while bootstrap (passkey registration) is required.
 *   veduta daemon (local vps profile) -> http://localhost:<port>
 *     -- the ready line, printed on EVERY boot, including every restart the
 *        runner performs after the onboarding wizard's finish step makes the
 *        daemon exit(0) on purpose. Tests must only ever synchronize on this
 *        line, never on the setup URL (which is absent after first boot).
 */
export interface LocalVpsStack {
  readonly port: number
  readonly baseDir: string
  readonly legacyHome: string
  /** Origin the PWA/daemon serve on, e.g. `http://localhost:41234`. */
  readonly origin: string
  /**
   * Resolves the next time a ready line appears that this handle hasn't
   * already consumed -- one call per boot expected (first boot, then once
   * per restart). Rejects if none arrives within `timeoutMs`.
   */
  waitForReadyLine(timeoutMs?: number): Promise<string>
  /**
   * Resolves with the first-boot setup URL and its pairing code. Only ever
   * printed once per fresh `baseDir` (bootstrap consumes the code), so this
   * has no restart-repeat variant unlike `waitForReadyLine`.
   */
  waitForSetupUrl(timeoutMs?: number): Promise<{ url: string; code: string }>
  /** Sends SIGTERM to the whole process group and awaits exit. */
  stop(): Promise<void>
}

export interface StartStackOptions {
  /** Reuses a fixed port instead of picking a free one -- restart-on-same-port coverage (AC3). */
  port?: number
  /** Reuses a fixed base directory instead of a fresh temp dir -- restart-on-same-base-dir coverage (AC3). */
  baseDir?: string
  /** Reuses a fixed (still-empty) legacy-detection home instead of a fresh temp dir. */
  legacyHome?: string
  /**
   * Extra environment variables applied AFTER the isolation `delete`s below --
   * never affects `local-vps.spec.ts`'s own journey, since it never passes
   * this option. The signed self-update e2e (issue #43,
   * `docs/adr/0013-signed-self-update.md`) uses this to inject the
   * harness-only test knobs (`VEDUTA_UPDATE_TEST_KNOBS` and friends,
   * `packages/daemon/src/update/update-transaction.ts`/`self-check.ts`) and
   * `VEDUTA_INSTALLED_VERSION` (`server.ts`/`update-cli.ts`) into the runner's
   * own process env, which `deploy/local-vps.sh`'s `exec env ...` and
   * `deploy/veduta-run`'s plain subprocess spawns both pass straight through
   * unmodified -- `VEDUTA_UPDATE_HOME`/`VEDUTA_UPDATE_PINNING` themselves need
   * no entry here, since `local-vps.sh` already always points them at
   * `<base-dir>/updates` and `<base-dir>/update.json` unconditionally.
   */
  extraEnv?: Record<string, string>
}

/**
 * Finds a free TCP port by letting the OS assign one, then releasing it
 * immediately. There's an unavoidable, brief race between release and the
 * runner script binding it, but it's the same race any "pick a free port"
 * approach has without a shared broker, and is not observed to be flaky in
 * this suite's single-worker, single-journey-at-a-time run.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not determine an ephemeral port'))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

/**
 * Starts `deploy/local-vps.sh` as its own process group (issue 023's runner
 * relies on `set -m` internally; this side needs `detached: true` so the
 * negative PID below reaches the runner AND everything it forked -- the
 * daemon's `tsx`/`node` process in particular -- not just the top-level bash
 * process). Isolated from the developer's real machine on two axes: a fresh
 * temp `baseDir` (so `<base>/data` and `<base>/vault.key` never touch
 * `~/.veduta-local-vps`) and `VEDUTA_LEGACY_HOME` pointed at an empty temp
 * dir (so the wizard's migration-detection step, gated on a real
 * `~/.hermes`/`~/.openclaw`, never fires just because this happens to run on
 * a machine that has one -- see `packages/daemon/src/onboarding-status.ts`'s
 * `resolveLegacy`).
 */
export async function startLocalVpsStack(options: StartStackOptions = {}): Promise<LocalVpsStack> {
  const port = options.port ?? (await findFreePort())
  const baseDir = options.baseDir ?? (await mkdtemp(join(tmpdir(), 'veduta-e2e-base-')))
  const legacyHome = options.legacyHome ?? (await mkdtemp(join(tmpdir(), 'veduta-e2e-legacy-')))

  const env = { ...process.env }
  delete env['VEDUTA_PROFILE']
  delete env['VEDUTA_ONBOARDING']
  delete env['VEDUTA_DATA_DIR']
  delete env['VEDUTA_VAULT_KEYFILE']
  delete env['VEDUTA_VAULT_KEY']
  delete env['VEDUTA_PUBLIC_DOMAIN']
  delete env['VEDUTA_BOOTSTRAP_CODE']
  delete env['VEDUTA_AUTH_STATE']
  delete env['PORT']
  env['VEDUTA_LEGACY_HOME'] = legacyHome
  Object.assign(env, options.extraEnv)

  const child = spawn(RUNNER_SCRIPT, ['--port', String(port), '--base-dir', baseDir], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events = new EventEmitter()
  const readyLines: string[] = []
  const setupUrls: { url: string; code: string }[] = []
  let consumedReady = 0
  let consumedSetup = 0

  const onLine = (source: 'stdout' | 'stderr', line: string) => {
    // Surfaced for CI debugging (the first run in particular is slow -- the
    // runner builds the PWA before the daemon ever boots) -- never asserted
    // on directly, only parsed for the two lines below.
    console.log(`[local-vps ${source}:${port}] ${line}`)
    const ready = READY_LINE.exec(line)
    if (ready) {
      readyLines.push(line)
      events.emit('ready')
    }
    const setup = SETUP_URL_LINE.exec(line)
    if (setup) {
      setupUrls.push({ url: setup[1]!, code: setup[2]! })
      events.emit('setup')
    }
  }

  createInterface({ input: child.stdout! }).on('line', (line) => onLine('stdout', line))
  createInterface({ input: child.stderr! }).on('line', (line) => onLine('stderr', line))

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })

  const waitForReadyLine = (timeoutMs = 180_000): Promise<string> =>
    waitForNext({
      already: () => readyLines.length > consumedReady,
      take: () => readyLines[consumedReady++]!,
      on: (fn) => events.on('ready', fn),
      off: (fn) => events.off('ready', fn),
      timeoutMs,
      what: 'ready line',
    })

  const waitForSetupUrl = (timeoutMs = 180_000): Promise<{ url: string; code: string }> =>
    waitForNext({
      already: () => setupUrls.length > consumedSetup,
      take: () => setupUrls[consumedSetup++]!,
      on: (fn) => events.on('setup', fn),
      off: (fn) => events.off('setup', fn),
      timeoutMs,
      what: 'first-boot setup URL',
    })

  const stop = async (): Promise<void> => {
    if (exitedAlready(child)) return
    const pid = child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // Already gone -- nothing left to signal.
      return
    }
    const result = await Promise.race([
      exited.then(() => 'exited' as const),
      sleep(15_000).then(() => 'timeout' as const),
    ])
    if (result === 'timeout') {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await exited
    }
  }

  return {
    port,
    baseDir,
    legacyHome,
    origin: `http://localhost:${port}`,
    waitForReadyLine,
    waitForSetupUrl,
    stop,
  }
}

/** Best-effort cleanup of the temp directories a fresh (non-reused) stack created. */
export async function cleanupStackDirs(stack: LocalVpsStack): Promise<void> {
  await Promise.all([
    rm(stack.baseDir, { recursive: true, force: true }),
    rm(stack.legacyHome, { recursive: true, force: true }),
  ])
}

function exitedAlready(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForNext<T>(spec: {
  already: () => boolean
  take: () => T
  on: (fn: () => void) => void
  off: (fn: () => void) => void
  timeoutMs: number
  what: string
}): Promise<T> {
  if (spec.already()) return Promise.resolve(spec.take())
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      spec.off(onEvent)
      reject(new Error(`timed out waiting for the ${spec.what}`))
    }, spec.timeoutMs)
    function onEvent() {
      if (!spec.already()) return
      clearTimeout(timeout)
      spec.off(onEvent)
      resolve(spec.take())
    }
    spec.on(onEvent)
  })
}
