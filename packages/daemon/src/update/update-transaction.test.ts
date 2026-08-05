import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ReleaseMetadata, UpdateMarker, UpdatePinning } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeypair, publicKeyIdText, sign } from './minisign.ts'
import { preflightArchive } from './tar-reader.ts'
import {
  UpdateTransactionStoppedError,
  ensureUpdateHomeLayout,
  finalizeUpdate,
  resolveUpdateHome,
  resumeUpdateTransaction,
  rollbackUpdate,
  runUpdateTransaction,
  sweepAckedResult,
  type ExecFileOptions,
  type ExecFileResult,
  type Ports,
  type UpdateHome,
  type UpdateTransactionOptions,
} from './update-transaction.ts'

/**
 * `update-transaction.ts` (issues/043-self-update.md; docs/adr/0013-signed-self-update.md and
 * its "Amendments" section): the recoverable, journaled update transaction —
 * verify, disk guardrail, download, stage, backup, migrate, flip, stage-1
 * health, and the uniform terminal-publication sequence for every outcome.
 *
 * `Ports` (fetch/exec/statfs/diskUsage/now/log) are always injected; only
 * the system `tar` binary is exercised for real, both to build fixtures and
 * because `ensureRuntime`/`stageRelease` shell out to it themselves.
 */

const execFileAsync = promisify(execFile)

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Resolved through `realpathSync` — on macOS, `os.tmpdir()` is itself a
 * symlink (`/var` -> `/private/var`), so `realpathSync` on a symlink whose
 * *target* was built from an un-resolved tmpdir path (e.g. the current
 * symlink's target) would otherwise disagree with a path built by plain
 * `join()` from the same starting point, even though both point at the same
 * directory.
 */
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const real = realpathSync(dir)
  tmpDirs.push(real)
  return real
}

const KEY_MATERIAL = Buffer.from('a test key material, long enough for the backup scrypt call')

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Builds the release tree the fake artifact tarball is made from: enough for the transaction's own file stats (`deploy/veduta-run`, the migrate-cli/tsx paths) — the actual migrate/self-check *behavior* is entirely controlled by the stubbed `execFile` port, never really invoked. */
function buildFakeReleaseTree(baseDir: string, options: { includeTsx?: boolean } = {}): void {
  mkdirSync(join(baseDir, 'deploy'), { recursive: true })
  writeFileSync(join(baseDir, 'deploy', 'veduta-run'), '#!/bin/sh\necho fake wrapper\n')
  const daemonDir = join(baseDir, 'packages', 'daemon')
  mkdirSync(join(daemonDir, 'src', 'update'), { recursive: true })
  writeFileSync(join(daemonDir, 'src', 'index.ts'), '// fake daemon entry point\n')
  writeFileSync(join(daemonDir, 'src', 'update', 'migrate-cli.ts'), '// fake migrate cli\n')
  if (options.includeTsx !== false) {
    mkdirSync(join(daemonDir, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(daemonDir, 'node_modules', '.bin', 'tsx'), '#!/bin/sh\necho fake tsx\n')
  }
}

async function buildFakeArtifactTarball(
  destTarPath: string,
  options: { includeTsx?: boolean } = {},
): Promise<void> {
  const treeDir = mkdtempSync(join(tmpdir(), 'veduta-fake-release-'))
  try {
    buildFakeReleaseTree(treeDir, options)
    await execFileAsync('tar', ['-czf', destTarPath, '-C', treeDir, '.'])
  } finally {
    rmSync(treeDir, { recursive: true, force: true })
  }
}

async function buildFakeNodeTarball(
  destTarPath: string,
  version: string,
  arch: string,
): Promise<void> {
  const parentDir = mkdtempSync(join(tmpdir(), 'veduta-fake-node-'))
  try {
    const innerName = `node-v${version}-linux-${arch}`
    mkdirSync(join(parentDir, innerName, 'bin'), { recursive: true })
    writeFileSync(join(parentDir, innerName, 'bin', 'node'), '#!/bin/sh\necho fake node\n')
    await execFileAsync('tar', ['-czf', destTarPath, '-C', parentDir, innerName])
  } finally {
    rmSync(parentDir, { recursive: true, force: true })
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Chain {
  rootPublicKeyText: string
  releaseBytes: Buffer
  releaseSigText: string
  signingPublicKeyText: string
  signingCertText: string
}

/** Builds a full, fresh, throwaway minisign chain (root -> signing cert -> signed release bytes) — the test-only `generateKeypair`/`sign` helpers produce real minisign wire format, so this exercises the exact same verification path a real release would (`minisign.test.ts`'s "accepts a root-signed replacement signing key" test does the same thing). */
function buildChain(releaseFields: ReleaseMetadata): Chain {
  const root = generateKeypair()
  const signing = generateKeypair()
  const signingCertText = sign({
    contentBytes: Buffer.from(signing.publicKeyText, 'utf8'),
    secretKey: root.secretKey,
    trustedComment: 'signing.pub',
  })
  const releaseBytes = Buffer.from(JSON.stringify(releaseFields), 'utf8')
  const releaseSigText = sign({
    contentBytes: releaseBytes,
    secretKey: signing.secretKey,
    trustedComment: releaseFields.artifactName,
  })
  return {
    rootPublicKeyText: root.publicKeyText,
    releaseBytes,
    releaseSigText,
    signingPublicKeyText: signing.publicKeyText,
    signingCertText,
  }
}

function markerFrom(chain: Chain, artifactUrl: string): UpdateMarker {
  return {
    requestedAt: '2026-08-04T12:00:00.000Z',
    release: chain.releaseBytes.toString('base64'),
    releaseSig: chain.releaseSigText,
    signingKey: {
      pub: chain.signingPublicKeyText,
      rootSig: chain.signingCertText,
      keyId: publicKeyIdText(chain.signingPublicKeyText),
    },
    artifactUrl,
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string
  args: string[]
  opts?: ExecFileOptions
}

interface ExecBehavior {
  migrateCode: number
  migrateStderr: string
  selfCheckCode: number
  selfCheckStderr: string
}

function defaultExecBehavior(): ExecBehavior {
  return { migrateCode: 0, migrateStderr: '', selfCheckCode: 0, selfCheckStderr: '' }
}

function makeExecFile(behavior: ExecBehavior, execCalls: ExecCall[]) {
  return async (cmd: string, args: string[], opts?: ExecFileOptions): Promise<ExecFileResult> => {
    execCalls.push({ cmd, args, ...(opts !== undefined ? { opts } : {}) })
    if (cmd === 'tar') {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
        })
        return { code: 0, stdout, stderr }
      } catch (error) {
        const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
        return {
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message,
        }
      }
    }
    if (args.some((a) => a.includes('migrate-cli.ts'))) {
      return { code: behavior.migrateCode, stdout: '', stderr: behavior.migrateStderr }
    }
    if (args.some((a) => a.includes('index.ts'))) {
      return { code: behavior.selfCheckCode, stdout: '', stderr: behavior.selfCheckStderr }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

interface Fixture {
  home: UpdateHome
  dataRootDir: string
  oldReleaseDir: string
  pinning: UpdatePinning
  release: ReleaseMetadata
  chain: Chain
  marker: UpdateMarker
  artifactTarPath: string
  execCalls: ExecCall[]
  execBehavior: ExecBehavior
  logLines: string[]
  routes: Map<string, { status: number; bytes: Buffer }>
  statfsResult: { bavail: number; bsize: number }
  ports: Ports
  installedVersion: string
  installedDataVersion: number
}

const FEED_HOST_URL = 'http://127.0.0.1:1'
const NODE_DIST_URL = 'http://127.0.0.1:2/dist'
const ARCH = process.arch
const NODE_VERSION = '9.9.9'

/** Builds a complete, self-consistent fixture: an update home with a pre-existing "old" release as `current`, a populated data root, a signed release + marker offering a newer version, a fake artifact tarball sized/hashed to match the signed metadata, and `Ports` wired to serve all of it. Individual tests mutate specific pieces (a byte in the chain, a route's served bytes, `statfsResult`) to exercise refusal/rollback paths. */
async function buildFixture(
  overrides: { dataVersion?: number; needsRuntime?: boolean; includeTsx?: boolean } = {},
): Promise<Fixture> {
  const homeRoot = freshDir('veduta-update-home-')
  const home = resolveUpdateHome(homeRoot)
  ensureUpdateHomeLayout(home)

  const dataRootDir = freshDir('veduta-update-dataroot-')
  mkdirSync(join(dataRootDir, 'spaces'), { recursive: true })
  writeFileSync(join(dataRootDir, 'marker-seed.txt'), 'seed-content-v1\n')

  const oldReleaseDir = join(home.releasesDir, 'v0.0.1')
  mkdirSync(oldReleaseDir, { recursive: true })
  symlinkSync(oldReleaseDir, home.currentSymlink)

  // `needsRuntime: false` means "the runtime this release wants is already
  // present" — pre-create it so the transaction's own `!existsSync(runtimeDir)`
  // check (which decides whether to download at all) agrees with the fixture,
  // rather than trying to download from a route nothing registered.
  if (overrides.needsRuntime === false) {
    mkdirSync(join(home.runtimesDir, `node-v${NODE_VERSION}-linux-${ARCH}`, 'bin'), {
      recursive: true,
    })
    writeFileSync(join(home.runtimesDir, `node-v${NODE_VERSION}-linux-${ARCH}`, 'bin', 'node'), 'x')
  }

  const artifactTarPath = join(freshDir('veduta-update-artifact-'), 'veduta-v1.2.3-linux.tar.gz')
  await buildFakeArtifactTarball(
    artifactTarPath,
    overrides.includeTsx !== undefined ? { includeTsx: overrides.includeTsx } : {},
  )
  const artifactBytes = readFileSync(artifactTarPath)
  const preflight = await preflightArchive(artifactTarPath, {
    maxEntries: 100_000,
    maxUnpackedBytes: 100_000_000,
  })

  const release: ReleaseMetadata = {
    version: '1.2.3',
    artifactName: 'veduta-v1.2.3-linux.tar.gz',
    sha256: sha256Hex(artifactBytes),
    artifactSize: artifactBytes.length,
    unpackedSize: preflight.unpackedBytes,
    entryCount: preflight.entries,
    dataVersion: overrides.dataVersion ?? 2,
    nodeVersion: NODE_VERSION,
    nodeTarSize: 1,
    nodeUnpackedSize: 1,
    notes: 'a fixture release',
  }

  const chain = buildChain(release)
  const artifactUrl = `${FEED_HOST_URL}/artifact/${release.artifactName}`
  const marker = markerFrom(chain, artifactUrl)
  const pinning: UpdatePinning = {
    feedUrl: `${FEED_HOST_URL}/feed/stable.json`,
    rootPublicKey: chain.rootPublicKeyText,
  }

  const routes = new Map<string, { status: number; bytes: Buffer }>()
  routes.set(artifactUrl, { status: 200, bytes: artifactBytes })

  const needsRuntime = overrides.needsRuntime ?? true
  if (needsRuntime) {
    const nodeTarPath = join(
      freshDir('veduta-update-node-'),
      `node-v${NODE_VERSION}-linux-${ARCH}.tar.gz`,
    )
    await buildFakeNodeTarball(nodeTarPath, NODE_VERSION, ARCH)
    const nodeTarBytes = readFileSync(nodeTarPath)
    release.nodeTarSize = nodeTarBytes.length
    release.nodeUnpackedSize = nodeTarBytes.length * 3
    // Rebuild the chain now that nodeTarSize changed (it is part of the signed bytes).
    const rebuiltChain = buildChain(release)
    const rebuiltMarker = markerFrom(rebuiltChain, artifactUrl)
    const tarName = `node-v${NODE_VERSION}-linux-${ARCH}.tar.gz`
    const nodeTarUrl = `${NODE_DIST_URL}/v${NODE_VERSION}/${tarName}`
    const shasumsUrl = `${NODE_DIST_URL}/v${NODE_VERSION}/SHASUMS256.txt`
    routes.set(nodeTarUrl, { status: 200, bytes: nodeTarBytes })
    routes.set(shasumsUrl, {
      status: 200,
      bytes: Buffer.from(`${sha256Hex(nodeTarBytes)}  ${tarName}\n`, 'utf8'),
    })
    const execCalls: ExecCall[] = []
    const execBehavior = defaultExecBehavior()
    const logLines: string[] = []
    const statfsResult = { bavail: 100_000_000, bsize: 4096 }
    const ports: Ports = {
      fetchBytes: async (url) => {
        const route = routes.get(url)
        if (route === undefined)
          throw new Error(`test fixture: no fake route registered for ${url}`)
        return route
      },
      execFile: makeExecFile(execBehavior, execCalls),
      statfs: () => statfsResult,
      diskUsage: async () => 4096,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      log: (line) => logLines.push(line),
    }
    return {
      home,
      dataRootDir,
      oldReleaseDir,
      pinning: { feedUrl: pinning.feedUrl, rootPublicKey: rebuiltChain.rootPublicKeyText },
      release,
      chain: rebuiltChain,
      marker: rebuiltMarker,
      artifactTarPath,
      execCalls,
      execBehavior,
      logLines,
      routes,
      statfsResult,
      ports,
      installedVersion: '0.0.1',
      installedDataVersion: 1,
    }
  }

  const execCalls: ExecCall[] = []
  const execBehavior = defaultExecBehavior()
  const logLines: string[] = []
  const statfsResult = { bavail: 100_000_000, bsize: 4096 }
  const ports: Ports = {
    fetchBytes: async (url) => {
      const route = routes.get(url)
      if (route === undefined) throw new Error(`test fixture: no fake route registered for ${url}`)
      return route
    },
    execFile: makeExecFile(execBehavior, execCalls),
    statfs: () => statfsResult,
    diskUsage: async () => 4096,
    now: () => new Date('2026-08-04T12:00:00.000Z'),
    log: (line) => logLines.push(line),
  }

  return {
    home,
    dataRootDir,
    oldReleaseDir,
    pinning,
    release,
    chain,
    marker,
    artifactTarPath,
    execCalls,
    execBehavior,
    logLines,
    routes,
    statfsResult,
    ports,
    installedVersion: '0.0.1',
    installedDataVersion: 1,
  }
}

/** Every fixture's fake node-dist routes are keyed under `NODE_DIST_URL`, so every call defaults `VEDUTA_NODE_DIST_URL` to it — only a test that deliberately wants the real default (`https://nodejs.org/dist`) needs to override `env` to omit it. */
function optionsFrom(fixture: Fixture, env?: NodeJS.ProcessEnv): UpdateTransactionOptions {
  return {
    home: fixture.home,
    dataRootDir: fixture.dataRootDir,
    pinning: fixture.pinning,
    marker: fixture.marker,
    installedVersion: fixture.installedVersion,
    installedDataVersion: fixture.installedDataVersion,
    keyMaterial: KEY_MATERIAL,
    ports: fixture.ports,
    env: { ...process.env, VEDUTA_NODE_DIST_URL: NODE_DIST_URL, ...(env ?? {}) },
  }
}

function currentTargetOf(home: UpdateHome): string {
  return realpathSync(home.currentSymlink)
}

function seedFileContent(dataRootDir: string): string {
  return readFileSync(join(dataRootDir, 'marker-seed.txt'), 'utf8')
}

function historyFiles(home: UpdateHome): string[] {
  return existsSync(home.historyDir) ? readdirSync(home.historyDir) : []
}

function journalExists(home: UpdateHome): boolean {
  return existsSync(join(home.stateDir, 'update-state.json'))
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runUpdateTransaction — happy path', () => {
  it('runs every phase in order, downloads the runtime, migrates, flips, passes health, and finalizes successfully', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })

    // Extra pre-existing releases so the success-only prune step has real work to do.
    for (const version of ['0.0.2', '0.0.3', '0.0.4']) {
      mkdirSync(join(fixture.home.releasesDir, `v${version}`), { recursive: true })
    }

    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('awaiting-stage-2')
    if (outcome.status !== 'awaiting-stage-2') throw new Error('unreachable')
    expect(outcome.releaseDir).toBe(join(fixture.home.releasesDir, 'v1.2.3'))

    // Stage 1 ran for real (through the stubbed execFile): migrate + self-check invoked.
    expect(fixture.execCalls.some((c) => c.args.some((a) => a.includes('migrate-cli.ts')))).toBe(
      true,
    )
    expect(fixture.execCalls.some((c) => c.args.some((a) => a.includes('index.ts')))).toBe(true)

    // Current already flipped to the new release before finalize (finalize is only housekeeping).
    expect(currentTargetOf(fixture.home)).toBe(outcome.releaseDir)

    // The runtime was downloaded and verified.
    const runtimeDir = join(fixture.home.runtimesDir, `node-v${NODE_VERSION}-linux-${ARCH}`)
    expect(existsSync(join(runtimeDir, 'bin', 'node'))).toBe(true)

    // The pre-update backup exists.
    const backups = readdirSync(fixture.home.backupsDir)
    expect(backups.length).toBeGreaterThan(0)

    const result = await finalizeUpdate(optionsFrom(fixture))
    expect(result.outcome).toBe('success')
    expect(result.fromVersion).toBe('0.0.1')
    expect(result.toVersion).toBe('1.2.3')

    // Terminal publication completed: result.json stays, journal archived.
    expect(existsSync(join(fixture.home.stateDir, 'result.json'))).toBe(true)
    expect(journalExists(fixture.home)).toBe(false)
    expect(historyFiles(fixture.home).length).toBe(1)

    // Prune: current + 2 newest others kept (v1.2.3, v0.0.4, v0.0.3); older ones gone.
    const remaining = readdirSync(fixture.home.releasesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(remaining).toEqual(['v0.0.3', 'v0.0.4', 'v1.2.3'])

    // Wrapper self-updated from the new release's deploy/veduta-run.
    const wrapperPath = join(fixture.home.binDir, 'veduta-run')
    expect(existsSync(wrapperPath)).toBe(true)
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o755)

    // Log preserved and non-empty.
    const logPath = join(fixture.home.logsDir, '1.2.3.log')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8').length).toBeGreaterThan(0)
  })

  it('skips migration entirely when the offered dataVersion matches what is installed', async () => {
    const fixture = await buildFixture({ dataVersion: 1, includeTsx: false, needsRuntime: false })
    // installedDataVersion is 1 by default — dataVersion also 1, and no migrate-cli present.
    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('awaiting-stage-2')
    expect(fixture.execCalls.some((c) => c.args.some((a) => a.includes('migrate-cli.ts')))).toBe(
      false,
    )
  })

  it('honors VEDUTA_TEST_FAIL_MIGRATION only with the harness-wide test knob also set', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    const env = { ...process.env, VEDUTA_TEST_FAIL_MIGRATION: '1' }
    // The harness-wide knob is NOT set — the forced failure must not trigger.
    const outcome = await runUpdateTransaction(optionsFrom(fixture, env))
    expect(outcome.status).toBe('awaiting-stage-2')
  })
})

// ---------------------------------------------------------------------------
// AC2-shape refusals — zero mutation
// ---------------------------------------------------------------------------

function assertZeroMutation(fixture: Fixture, seedBefore: string): void {
  expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
  expect(existsSync(fixture.home.backupsDir) ? readdirSync(fixture.home.backupsDir) : []).toEqual(
    [],
  )
  expect(seedFileContent(fixture.dataRootDir)).toBe(seedBefore)
  expect(existsSync(join(fixture.home.releasesDir, 'v1.2.3'))).toBe(false)
}

describe('runUpdateTransaction — AC2-shape refusals (zero mutation)', () => {
  it('refuses a bad content signature', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const seedBefore = seedFileContent(fixture.dataRootDir)
    // Flip one base64 character on the signature line itself (line 2 — line
    // 1 is an untrusted, unverified comment, so tampering it would be a
    // no-op against `verify`).
    const lines = fixture.marker.releaseSig.split('\n')
    const sigLine = lines[1]
    if (sigLine === undefined) throw new Error('test setup: expected a signature line')
    lines[1] = sigLine.replace(/[A-Za-z0-9]/, (c) => (c === 'A' ? 'B' : 'A'))
    const tampered = lines.join('\n')
    const outcome = await runUpdateTransaction(
      optionsFrom({ ...fixture, marker: { ...fixture.marker, releaseSig: tampered } }),
    )
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    assertZeroMutation(fixture, seedBefore)
  })

  it('refuses an un-rooted signing key (self-certified, not signed by the pinned root)', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const seedBefore = seedFileContent(fixture.dataRootDir)
    const forgedSigning = generateKeypair()
    const selfCert = sign({
      contentBytes: Buffer.from(forgedSigning.publicKeyText, 'utf8'),
      secretKey: forgedSigning.secretKey,
      trustedComment: 'signing.pub',
    })
    const releaseSigText = sign({
      contentBytes: fixture.chain.releaseBytes,
      secretKey: forgedSigning.secretKey,
      trustedComment: fixture.release.artifactName,
    })
    const marker: UpdateMarker = {
      ...fixture.marker,
      releaseSig: releaseSigText,
      signingKey: { pub: forgedSigning.publicKeyText, rootSig: selfCert, keyId: 'forged' },
    }
    const outcome = await runUpdateTransaction(optionsFrom({ ...fixture, marker }))
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    assertZeroMutation(fixture, seedBefore)
  })

  it('refuses a non-monotonic (not-newer) offered version', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const seedBefore = seedFileContent(fixture.dataRootDir)
    const outcome = await runUpdateTransaction(
      optionsFrom({ ...fixture, installedVersion: '9.9.9' }),
    )
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    expect(outcome.result.failedStage).toBeDefined()
    assertZeroMutation(fixture, seedBefore)
  })

  it('refuses a renamed/substituted artifact (downloaded bytes do not hash to the signed sha256)', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const seedBefore = seedFileContent(fixture.dataRootDir)
    const artifactUrl = `${FEED_HOST_URL}/artifact/${fixture.release.artifactName}`
    fixture.routes.set(artifactUrl, {
      status: 200,
      bytes: Buffer.from('not the real artifact bytes'),
    })
    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    expect(outcome.result.reason).toMatch(/sha256 mismatch/)
    assertZeroMutation(fixture, seedBefore)
  })
})

// ---------------------------------------------------------------------------
// AC8 — disk guardrail
// ---------------------------------------------------------------------------

describe('runUpdateTransaction — AC8 disk guardrail', () => {
  it('refuses before any download/backup when statfs reports insufficient free space', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const seedBefore = seedFileContent(fixture.dataRootDir)
    fixture.statfsResult.bavail = 1
    fixture.statfsResult.bsize = 1

    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    expect(outcome.result.failedStage).toBe('guardrail')
    expect(outcome.result.reason).toMatch(/insufficient disk space/)
    assertZeroMutation(fixture, seedBefore)
    // Nothing was ever downloaded.
    expect(fixture.execCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC6 — runtime jump
// ---------------------------------------------------------------------------

describe('runUpdateTransaction — AC6 runtime jump', () => {
  it('downloads and SHA-verifies a missing Node runtime, then serves from it', async () => {
    const fixture = await buildFixture({ needsRuntime: true })
    const env = { ...process.env, VEDUTA_NODE_DIST_URL: NODE_DIST_URL }
    const outcome = await runUpdateTransaction(optionsFrom(fixture, env))
    expect(outcome.status).toBe('awaiting-stage-2')
    const runtimeDir = join(fixture.home.runtimesDir, `node-v${NODE_VERSION}-linux-${ARCH}`)
    expect(existsSync(join(runtimeDir, 'bin', 'node'))).toBe(true)
    const releaseDir = outcome.status === 'awaiting-stage-2' ? outcome.releaseDir : ''
    expect(readFileSync(join(releaseDir, 'RUNTIME'), 'utf8').trim()).toBe(
      `node-v${NODE_VERSION}-linux-${ARCH}`,
    )
  })

  it('refuses a tampered Node runtime tarball; nothing is materialized under runtimes/', async () => {
    const fixture = await buildFixture({ needsRuntime: true })
    const env = { ...process.env, VEDUTA_NODE_DIST_URL: NODE_DIST_URL }
    const tarName = `node-v${NODE_VERSION}-linux-${ARCH}.tar.gz`
    const nodeTarUrl = `${NODE_DIST_URL}/v${NODE_VERSION}/${tarName}`
    const original = fixture.routes.get(nodeTarUrl)
    if (original === undefined)
      throw new Error('test setup: expected the node tarball route to exist')
    const tampered = Buffer.from(original.bytes)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    fixture.routes.set(nodeTarUrl, { status: 200, bytes: tampered })

    const seedBefore = seedFileContent(fixture.dataRootDir)
    const outcome = await runUpdateTransaction(optionsFrom(fixture, env))
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('refused')
    expect(outcome.result.reason).toMatch(/sha256 mismatch/)

    // Nothing was ever materialized for the tampered runtime specifically —
    // the (valid, untampered) release artifact itself may still have been
    // extracted before the runtime step ran; "nothing switched" is the
    // actual guarantee here (issues/043-self-update.md AC6), not that the
    // release directory never got created.
    const runtimeDir = join(fixture.home.runtimesDir, `node-v${NODE_VERSION}-linux-${ARCH}`)
    expect(existsSync(runtimeDir)).toBe(false)
    expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
    expect(existsSync(fixture.home.backupsDir) ? readdirSync(fixture.home.backupsDir) : []).toEqual(
      [],
    )
    expect(seedFileContent(fixture.dataRootDir)).toBe(seedBefore)
  })
})

// ---------------------------------------------------------------------------
// AC3-shape — failed stage-1 health rolls back
// ---------------------------------------------------------------------------

describe('runUpdateTransaction — AC3-shape rollback on a failed self-check', () => {
  it('rolls back fully: data restored byte-identical, failed release kept, log preserved', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    fixture.execBehavior.selfCheckCode = 1
    fixture.execBehavior.selfCheckStderr = 'self-check: dataVersion mismatch (simulated)'
    const seedBefore = seedFileContent(fixture.dataRootDir)

    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('rolled-back')
    expect(outcome.result.reason).toMatch(/self-check failed/)

    // Old version serving again.
    expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
    // Data restored, byte-identical to what it was pre-update.
    expect(seedFileContent(fixture.dataRootDir)).toBe(seedBefore)
    // The failed release's tree is kept, not pruned.
    expect(existsSync(join(fixture.home.releasesDir, 'v1.2.3'))).toBe(true)
    // The log is preserved and mentions the concrete failure.
    const logPath = join(fixture.home.logsDir, '1.2.3.log')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toMatch(/dataVersion mismatch \(simulated\)/)
    // Terminal publication completed.
    expect(journalExists(fixture.home)).toBe(false)
    expect(historyFiles(fixture.home).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC4 — interrupted transaction: cooperative stop at every phase boundary
// ---------------------------------------------------------------------------

const PHASES = [
  'started',
  'downloaded',
  'verified',
  'staged',
  'backup-done',
  'migrating',
  'migrated',
  'switched',
  'serving-check',
] as const

describe('runUpdateTransaction / resumeUpdateTransaction — AC4 phase-boundary interruption', () => {
  it.each(PHASES)('stopping right after phase "%s" is resumable', async (phase) => {
    const fixture = await buildFixture({ dataVersion: 2 })
    const stopEnv = {
      ...process.env,
      VEDUTA_UPDATE_TEST_KNOBS: '1',
      VEDUTA_TEST_STOP_AFTER_PHASE: phase,
    }

    await expect(runUpdateTransaction(optionsFrom(fixture, stopEnv))).rejects.toThrow(
      UpdateTransactionStoppedError,
    )
    expect(journalExists(fixture.home)).toBe(true)

    if (phase === 'migrated') {
      // Invariant: old code must never be left serving a migrated store —
      // the current symlink still points at the old release right up until
      // resume runs, and resume flips it before returning control.
      expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
    }

    const resumed = await resumeUpdateTransaction(optionsFrom(fixture))

    if (phase === 'backup-done' || phase === 'migrating') {
      expect(resumed.status).toBe('terminal')
      if (resumed.status !== 'terminal') throw new Error('unreachable')
      expect(resumed.result.outcome).toBe('rolled-back')
      expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
      return
    }

    if (phase === 'migrated') {
      // Resume flips before finishing: by the time it returns, current
      // already points at the new release (health passed with the default
      // fixture's stubbed execFile).
      expect(currentTargetOf(fixture.home)).toBe(join(fixture.home.releasesDir, 'v1.2.3'))
    }

    expect(resumed.status).toBe('awaiting-stage-2')
    if (resumed.status !== 'awaiting-stage-2') throw new Error('unreachable')
    const result = await finalizeUpdate(optionsFrom(fixture))
    expect(result.outcome).toBe('success')
  })

  it('rolls back on resume when stage-1 health still fails after resuming from "switched"', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    fixture.execBehavior.selfCheckCode = 1
    const stopEnv = {
      ...process.env,
      VEDUTA_UPDATE_TEST_KNOBS: '1',
      VEDUTA_TEST_STOP_AFTER_PHASE: 'switched',
    }
    await expect(runUpdateTransaction(optionsFrom(fixture, stopEnv))).rejects.toThrow(
      UpdateTransactionStoppedError,
    )
    const resumed = await resumeUpdateTransaction(optionsFrom(fixture))
    expect(resumed.status).toBe('terminal')
    if (resumed.status !== 'terminal') throw new Error('unreachable')
    expect(resumed.result.outcome).toBe('rolled-back')
    expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
  })

  it('finalize interruption: stopping between the result write and the journal archive resumes to complete the archive without re-running the transaction', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('awaiting-stage-2')

    const stopEnv = {
      ...process.env,
      VEDUTA_UPDATE_TEST_KNOBS: '1',
      VEDUTA_TEST_STOP_AFTER_PHASE: 'result-written',
    }
    await expect(finalizeUpdate(optionsFrom(fixture, stopEnv))).rejects.toThrow(
      UpdateTransactionStoppedError,
    )
    // result.json exists, but the journal has not been archived yet.
    expect(existsSync(join(fixture.home.stateDir, 'result.json'))).toBe(true)
    expect(journalExists(fixture.home)).toBe(true)

    const execCallsBeforeResume = fixture.execCalls.length
    const resumed = await resumeUpdateTransaction(optionsFrom(fixture))
    expect(resumed.status).toBe('terminal')
    if (resumed.status !== 'terminal') throw new Error('unreachable')
    expect(resumed.result.outcome).toBe('success')
    // Nothing was re-run: no new migrate/self-check/exec calls.
    expect(fixture.execCalls.length).toBe(execCallsBeforeResume)
    expect(journalExists(fixture.home)).toBe(false)
    expect(historyFiles(fixture.home).length).toBe(1)
  })

  it('resumeUpdateTransaction is a no-op when there is nothing to resume', async () => {
    const fixture = await buildFixture({ needsRuntime: false })
    const resumed = await resumeUpdateTransaction(optionsFrom(fixture))
    expect(resumed.status).toBe('nothing-to-resume')
  })
})

// ---------------------------------------------------------------------------
// First update — no releases/current symlink exists yet
// ---------------------------------------------------------------------------

describe('runUpdateTransaction — first update (no releases/current yet)', () => {
  it('journals a non-empty executor path from legacyRoot, never the candidate release, when there is no prior release to record', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    rmSync(fixture.home.currentSymlink, { force: true, recursive: true })
    const legacyRoot = freshDir('veduta-legacy-checkout-')

    const outcome = await runUpdateTransaction({ ...optionsFrom(fixture), legacyRoot })
    expect(outcome.status).toBe('awaiting-stage-2')

    const journal = JSON.parse(
      readFileSync(join(fixture.home.stateDir, 'update-state.json'), 'utf8'),
    ) as { executorRelease: string; hadPriorRelease: boolean }
    expect(journal.executorRelease.length).toBeGreaterThan(0)
    expect(journal.executorRelease).toBe(legacyRoot)
    expect(journal.executorRelease).not.toBe(join(fixture.home.releasesDir, 'v1.2.3'))
    expect(journal.hadPriorRelease).toBe(false)
  })

  it('refuses to journal an empty executor path when no legacyRoot is provided', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    rmSync(fixture.home.currentSymlink, { force: true, recursive: true })

    await expect(runUpdateTransaction(optionsFrom(fixture))).rejects.toThrow(/legacyRoot/)
    expect(journalExists(fixture.home)).toBe(false)
  })

  it('rollback on a first update removes releases/current entirely (never leaves it pointing at the failed candidate), data restored', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    rmSync(fixture.home.currentSymlink, { force: true, recursive: true })
    const legacyRoot = freshDir('veduta-legacy-checkout-')
    fixture.execBehavior.selfCheckCode = 1
    fixture.execBehavior.selfCheckStderr = 'self-check: forced failure (first-update rollback test)'
    const seedBefore = seedFileContent(fixture.dataRootDir)

    const outcome = await runUpdateTransaction({ ...optionsFrom(fixture), legacyRoot })
    expect(outcome.status).toBe('terminal')
    if (outcome.status !== 'terminal') throw new Error('unreachable')
    expect(outcome.result.outcome).toBe('rolled-back')

    expect(existsSync(fixture.home.currentSymlink)).toBe(false)
    expect(seedFileContent(fixture.dataRootDir)).toBe(seedBefore)
    expect(journalExists(fixture.home)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rollbackUpdate — external caller path (the wrapper's own stage-2 failing)
// ---------------------------------------------------------------------------

describe('rollbackUpdate — called externally after the transaction paused for stage 2', () => {
  it('rolls back when a stage-2 check outside this module fails', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    const outcome = await runUpdateTransaction(optionsFrom(fixture))
    expect(outcome.status).toBe('awaiting-stage-2')

    const result = await rollbackUpdate(
      optionsFrom(fixture),
      'stage 2 (real daemon) never became ready',
      'stage-2',
    )
    expect(result.outcome).toBe('rolled-back')
    expect(result.failedStage).toBe('stage-2')
    expect(currentTargetOf(fixture.home)).toBe(fixture.oldReleaseDir)
    expect(seedFileContent(fixture.dataRootDir)).toBe('seed-content-v1\n')
  })
})

// ---------------------------------------------------------------------------
// sweepAckedResult
// ---------------------------------------------------------------------------

describe('sweepAckedResult', () => {
  it('archives an acked result only when no journal is active', async () => {
    const fixture = await buildFixture({ dataVersion: 2 })
    await runUpdateTransaction(optionsFrom(fixture))
    const result = await finalizeUpdate(optionsFrom(fixture))
    expect(journalExists(fixture.home)).toBe(false)

    // No ack yet — nothing to sweep.
    expect(sweepAckedResult(fixture.home)).toBe(false)
    expect(existsSync(join(fixture.home.stateDir, 'result.json'))).toBe(true)

    writeFileSync(join(fixture.home.stateDir, `result-acked-${result.id}`), '')
    expect(sweepAckedResult(fixture.home)).toBe(true)
    expect(existsSync(join(fixture.home.stateDir, 'result.json'))).toBe(false)
    expect(historyFiles(fixture.home).some((name) => name.endsWith('-result.json'))).toBe(true)
    expect(
      historyFiles(fixture.home).some((name) => name.includes(`result-acked-${result.id}`)),
    ).toBe(true)
  })
})
