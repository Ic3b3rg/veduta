import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ReleaseMetadata, UpdateMarker, UpdatePinning } from '@veduta/protocol'
import type * as VersionModule from '../version.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackup } from '../backup.ts'
import { generateKeypair, publicKeyIdText, sign } from './minisign.ts'
import { main } from './update-cli.ts'
import {
  ensureUpdateHomeLayout,
  resolveUpdateHome,
  type ExecFileOptions,
  type ExecFileResult,
  type Ports,
} from './update-transaction.ts'

// `VEDUTA_VERSION` in this source tree is the literal dev placeholder `'0.0.0-dev'` (`version.ts`)
// — not parseable as an x.y.z triple, only ever true of the checked-out repository, since the
// release build stamps a real version into the artifact's own copy before signing
// (`docs/adr/0013-signed-self-update.md`'s "Amendments" section). `update-cli.ts` uses this import
// directly as `installedVersion`, so the one test below that runs a real `runUpdateTransaction`
// (which enforces monotonicity against it) needs a parseable stand-in — every other test here
// resumes/finalizes/rolls back an already-started journal, which never re-checks monotonicity.
vi.mock('../version.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof VersionModule>()
  return { ...actual, VEDUTA_VERSION: '0.0.1' }
})

/**
 * `update-cli.ts` (issue #43, `docs/adr/0013-signed-self-update.md`): the environment-wiring +
 * dispatch layer `deploy/veduta-run` invokes from the old (executor) release. These tests call
 * the exported `main(args, env, portsOverride)` directly, exactly as the deliverable specifies,
 * with a `Ports` override so nothing here touches a real network or subprocess — only the parts
 * that genuinely run out-of-band in production (tar extraction via the system `tar` binary, the
 * real encrypted backup/restore round trip) are exercised for real, the same way
 * `update-transaction.test.ts` does.
 */

const execFileAsync = promisify(execFile)

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const real = realpathSync(dir)
  tmpDirs.push(real)
  return real
}

const KEY_MATERIAL_TEXT = 'a test key material, long enough for the backup scrypt call'

function writeVaultKeyfile(dir: string): string {
  const path = join(dir, 'vault.key')
  writeFileSync(path, KEY_MATERIAL_TEXT)
  return path
}

function writePinning(dir: string, pinning: UpdatePinning): string {
  const path = join(dir, 'update.json')
  writeFileSync(path, JSON.stringify(pinning))
  return path
}

function capturedConsole() {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return {
    lastLog: () => String(logSpy.mock.calls.at(-1)?.[0] ?? ''),
    restore: () => {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    },
  }
}

function noopPorts(): Ports {
  return {
    fetchBytes: () => {
      throw new Error('test fixture: no network expected in this test')
    },
    execFile: () => {
      throw new Error('test fixture: no subprocess expected in this test')
    },
    statfs: () => ({ bavail: 100_000_000, bsize: 4096 }),
    diskUsage: async () => 0,
    now: () => new Date('2026-08-05T12:00:00.000Z'),
    log: () => {},
  }
}

// ---------------------------------------------------------------------------
// Fixture builders shared with the marker-driven full-transaction test —
// trimmed copies of update-transaction.test.ts's own chain/tarball helpers.
// ---------------------------------------------------------------------------

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
    requestedAt: '2026-08-05T12:00:00.000Z',
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

function buildFakeReleaseTree(baseDir: string): void {
  mkdirSync(join(baseDir, 'deploy'), { recursive: true })
  writeFileSync(join(baseDir, 'deploy', 'veduta-run'), '#!/bin/sh\necho fake wrapper\n')
  const daemonDir = join(baseDir, 'packages', 'daemon')
  mkdirSync(join(daemonDir, 'src', 'update'), { recursive: true })
  writeFileSync(join(daemonDir, 'src', 'index.ts'), '// fake daemon entry point\n')
  writeFileSync(join(daemonDir, 'src', 'update', 'migrate-cli.ts'), '// fake migrate cli\n')
  mkdirSync(join(daemonDir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(daemonDir, 'node_modules', '.bin', 'tsx'), '#!/bin/sh\necho fake tsx\n')
}

async function buildFakeArtifactTarball(destTarPath: string): Promise<void> {
  const treeDir = mkdtempSync(join(tmpdir(), 'veduta-cli-fake-release-'))
  try {
    buildFakeReleaseTree(treeDir)
    await execFileAsync('tar', ['-czf', destTarPath, '-C', treeDir, '.'])
  } finally {
    rmSync(treeDir, { recursive: true, force: true })
  }
}

const FEED_HOST_URL = 'http://127.0.0.1:1'

describe('update-cli main — environment contract', () => {
  it('exits 2 with a plain message when VEDUTA_DATA_DIR is missing', async () => {
    const { restore } = capturedConsole()
    const home = freshDir('veduta-cli-home-')
    const code = await main(['run'], { VEDUTA_UPDATE_HOME: home })
    expect(code).toBe(2)
    restore()
  })

  it('exits 2 with a plain message when VEDUTA_UPDATE_HOME is missing', async () => {
    const { restore } = capturedConsole()
    const dataDir = freshDir('veduta-cli-data-')
    const code = await main(['run'], { VEDUTA_DATA_DIR: dataDir })
    expect(code).toBe(2)
    restore()
  })
})

describe('update-cli main — run mode', () => {
  it('prints "none" and exits 0 when there is neither a marker nor a journal', async () => {
    const home = freshDir('veduta-cli-home-')
    const dataDir = freshDir('veduta-cli-data-')
    const { lastLog, restore } = capturedConsole()

    const code = await main(
      ['run'],
      { VEDUTA_UPDATE_HOME: home, VEDUTA_DATA_DIR: dataDir },
      noopPorts(),
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: none')
    restore()
  })

  it('runs a full transaction from a marker.json through to awaiting-stage-2', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(join(dataDir, 'spaces'), { recursive: true })
    writeFileSync(join(dataDir, 'seed.txt'), 'seed\n')

    // A pre-existing "current" release, so the transaction has an executorRelease to record.
    const oldReleaseDir = join(homeLayout.releasesDir, 'v0.0.1')
    mkdirSync(oldReleaseDir, { recursive: true })
    symlinkSync(oldReleaseDir, homeLayout.currentSymlink)

    // Node runtime already present, so no runtime download route is needed.
    const runtimeDirName = `node-v9.9.9-linux-${process.arch}`
    mkdirSync(join(homeLayout.runtimesDir, runtimeDirName, 'bin'), { recursive: true })
    writeFileSync(join(homeLayout.runtimesDir, runtimeDirName, 'bin', 'node'), 'x')

    const artifactDir = freshDir('veduta-cli-artifact-')
    const artifactTarPath = join(artifactDir, 'veduta-v1.2.3-linux.tar.gz')
    await buildFakeArtifactTarball(artifactTarPath)
    const artifactBytes = readFileSync(artifactTarPath)

    // Same dataVersion installed and offered: the migrate step is a no-op, so this test never
    // needs a working migrate-cli subprocess (only self-check does).
    const release: ReleaseMetadata = {
      version: '1.2.3',
      artifactName: 'veduta-v1.2.3-linux.tar.gz',
      sha256: sha256Hex(artifactBytes),
      artifactSize: artifactBytes.length,
      unpackedSize: 1_000_000,
      entryCount: 1_000,
      dataVersion: 1,
      nodeVersion: '9.9.9',
      nodeTarSize: 1,
      nodeUnpackedSize: 1,
      notes: 'fixture release',
    }
    const chain = buildChain(release)
    const artifactUrl = `${FEED_HOST_URL}/artifact/${release.artifactName}`
    const marker = markerFrom(chain, artifactUrl)
    const pinning: UpdatePinning = {
      feedUrl: `${FEED_HOST_URL}/feed/stable.json`,
      rootPublicKey: chain.rootPublicKeyText,
    }

    writeFileSync(join(homeLayout.stateDir, 'marker.json'), JSON.stringify(marker))

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const pinningPath = writePinning(secretsDir, pinning)

    const logLines: string[] = []
    const ports: Ports = {
      fetchBytes: async (url) => {
        if (url === artifactUrl) return { status: 200, bytes: artifactBytes }
        throw new Error(`test fixture: no fake route registered for ${url}`)
      },
      execFile: async (cmd, args, opts?: ExecFileOptions): Promise<ExecFileResult> => {
        if (cmd === 'tar') {
          const { stdout, stderr } = await execFileAsync(cmd, args, {
            ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts?.env !== undefined ? { env: opts.env } : {}),
          })
          return { code: 0, stdout, stderr }
        }
        // The self-check invocation (`src/index.ts --self-check`) — mocked to pass.
        return { code: 0, stdout: '', stderr: '' }
      },
      statfs: () => ({ bavail: 1_000_000_000, bsize: 4096 }),
      diskUsage: async () => 4096,
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      log: (line) => logLines.push(line),
    }

    const { lastLog, restore } = capturedConsole()
    const code = await main(
      ['run'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      ports,
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: awaiting-stage-2')
    expect(logLines.some((line) => line.includes('release chain verified'))).toBe(true)
    restore()
  })

  it('resumes an existing journal at serving-check and reports awaiting-stage-2 on a passing health check', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'seed.txt'), 'seed\n')

    const releaseDir = join(homeLayout.releasesDir, 'v1.2.3')
    mkdirSync(releaseDir, { recursive: true })

    const journal = fixtureJournal({ phase: 'serving-check', releaseDir })
    writeFileSync(join(homeLayout.stateDir, 'update-state.json'), JSON.stringify(journal))

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const pinningPath = writePinning(secretsDir, {
      feedUrl: 'https://example.invalid/feed/stable.json',
      rootPublicKey: 'unused-in-this-test',
    })

    const ports: Ports = {
      ...noopPorts(),
      execFile: async () => ({ code: 0, stdout: '', stderr: '' }),
      log: () => {},
    }

    const { lastLog, restore } = capturedConsole()
    const code = await main(
      ['run'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      ports,
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: awaiting-stage-2')
    restore()
  })

  it('rolls back and reports "rolled-back" when the resumed health check fails', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(join(dataDir, 'spaces'), { recursive: true })
    writeFileSync(join(dataDir, 'seed.txt'), 'pre-update content\n')

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const keyMaterial = Buffer.from(KEY_MATERIAL_TEXT, 'utf8')
    const backupFile = await createBackup({
      rootDir: dataDir,
      outDir: homeLayout.backupsDir,
      keyMaterial,
      workDir: homeLayout.tmpDir,
    })

    const oldReleaseDir = join(homeLayout.releasesDir, 'v0.0.1')
    mkdirSync(oldReleaseDir, { recursive: true })
    symlinkSync(oldReleaseDir, homeLayout.currentSymlink)

    const releaseDir = join(homeLayout.releasesDir, 'v1.2.3')
    mkdirSync(releaseDir, { recursive: true })

    const journal = fixtureJournal({
      phase: 'serving-check',
      releaseDir,
      backupFile,
      executorRelease: oldReleaseDir,
    })
    writeFileSync(join(homeLayout.stateDir, 'update-state.json'), JSON.stringify(journal))

    const pinningPath = writePinning(secretsDir, {
      feedUrl: 'https://example.invalid/feed/stable.json',
      rootPublicKey: 'unused-in-this-test',
    })

    const ports: Ports = {
      ...noopPorts(),
      execFile: async () => ({ code: 1, stdout: '', stderr: 'self-check forced failure' }),
      log: () => {},
    }

    const { lastLog, restore } = capturedConsole()
    const code = await main(
      ['run'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      ports,
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: rolled-back')
    expect(readFileSync(join(dataDir, 'seed.txt'), 'utf8')).toBe('pre-update content\n')
    restore()
  })
})

describe('update-cli main — finalize mode', () => {
  it('finalizes a matching journal and prints "finalized"', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(dataDir, { recursive: true })

    const releaseDir = join(homeLayout.releasesDir, 'v1.2.3')
    mkdirSync(releaseDir, { recursive: true })
    const journal = fixtureJournal({ phase: 'serving-check', releaseDir })
    writeFileSync(join(homeLayout.stateDir, 'update-state.json'), JSON.stringify(journal))

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const pinningPath = writePinning(secretsDir, {
      feedUrl: 'https://example.invalid/feed/stable.json',
      rootPublicKey: 'unused-in-this-test',
    })

    const { lastLog, restore } = capturedConsole()
    const code = await main(
      ['finalize', '--version', '1.2.3'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      noopPorts(),
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: finalized')
    restore()
  })

  it('refuses to finalize when --version does not match the active journal', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(dataDir, { recursive: true })

    const releaseDir = join(homeLayout.releasesDir, 'v1.2.3')
    mkdirSync(releaseDir, { recursive: true })
    const journal = fixtureJournal({ phase: 'serving-check', releaseDir })
    writeFileSync(join(homeLayout.stateDir, 'update-state.json'), JSON.stringify(journal))

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const pinningPath = writePinning(secretsDir, {
      feedUrl: 'https://example.invalid/feed/stable.json',
      rootPublicKey: 'unused-in-this-test',
    })

    const { restore } = capturedConsole()
    const code = await main(
      ['finalize', '--version', '9.9.9'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      noopPorts(),
    )

    expect(code).toBe(1)
    restore()
  })
})

describe('update-cli main — rollback mode', () => {
  it('rolls back an active journal and prints "rolled-back"', async () => {
    const home = freshDir('veduta-cli-home-')
    const homeLayout = resolveUpdateHome(home)
    ensureUpdateHomeLayout(homeLayout)
    const dataDir = freshDir('veduta-cli-data-')
    mkdirSync(join(dataDir, 'spaces'), { recursive: true })
    writeFileSync(join(dataDir, 'seed.txt'), 'pre-update content\n')

    const secretsDir = freshDir('veduta-cli-secrets-')
    const vaultKeyfile = writeVaultKeyfile(secretsDir)
    const keyMaterial = Buffer.from(KEY_MATERIAL_TEXT, 'utf8')
    const backupFile = await createBackup({
      rootDir: dataDir,
      outDir: homeLayout.backupsDir,
      keyMaterial,
      workDir: homeLayout.tmpDir,
    })

    const oldReleaseDir = join(homeLayout.releasesDir, 'v0.0.1')
    mkdirSync(oldReleaseDir, { recursive: true })
    symlinkSync(oldReleaseDir, homeLayout.currentSymlink)

    const releaseDir = join(homeLayout.releasesDir, 'v1.2.3')
    mkdirSync(releaseDir, { recursive: true })
    const journal = fixtureJournal({
      phase: 'switched',
      releaseDir,
      backupFile,
      executorRelease: oldReleaseDir,
    })
    writeFileSync(join(homeLayout.stateDir, 'update-state.json'), JSON.stringify(journal))

    const pinningPath = writePinning(secretsDir, {
      feedUrl: 'https://example.invalid/feed/stable.json',
      rootPublicKey: 'unused-in-this-test',
    })

    const { lastLog, restore } = capturedConsole()
    const code = await main(
      ['rollback', '--reason', 'manual rollback for this test'],
      {
        VEDUTA_UPDATE_HOME: home,
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_UPDATE_PINNING: pinningPath,
        VEDUTA_VAULT_KEYFILE: vaultKeyfile,
      },
      noopPorts(),
    )

    expect(code).toBe(0)
    expect(lastLog()).toBe('update-cli: rolled-back')
    expect(readFileSync(join(dataDir, 'seed.txt'), 'utf8')).toBe('pre-update content\n')
    restore()
  })
})

describe('update-cli main — misc', () => {
  it('returns 1 for an unrecognized mode', async () => {
    const home = freshDir('veduta-cli-home-')
    const dataDir = freshDir('veduta-cli-data-')
    const { restore } = capturedConsole()

    const code = await main(
      ['bogus-mode'],
      { VEDUTA_UPDATE_HOME: home, VEDUTA_DATA_DIR: dataDir },
      noopPorts(),
    )

    expect(code).toBe(1)
    restore()
  })
})

/**
 * A minimal, schema-valid journal (`update-transaction.ts`'s private `JournalSchema` shape,
 * mirrored here on purpose — that module keeps it unexported, so a test that wants to seed an
 * *already in-progress* transaction has no other way to construct one) at a chosen phase. Chain
 * verification only runs when `phase` is at or before `started` (`update-transaction.ts`'s
 * `runFromJournal`), so every field under `marker`/`release` below only needs to satisfy the
 * zod schemas, never a real signature, for any test that seeds a later phase.
 */
function fixtureJournal(options: {
  phase: string
  releaseDir: string
  backupFile?: string
  executorRelease?: string
}): unknown {
  const release: ReleaseMetadata = {
    version: '1.2.3',
    artifactName: 'veduta-v1.2.3-linux.tar.gz',
    sha256: 'a'.repeat(64),
    artifactSize: 1,
    unpackedSize: 1,
    entryCount: 1,
    dataVersion: 1,
    nodeVersion: '9.9.9',
    nodeTarSize: 1,
    nodeUnpackedSize: 1,
    notes: '',
  }
  return {
    phase: options.phase,
    toVersion: '1.2.3',
    fromVersion: '0.0.1',
    executorRelease: options.executorRelease ?? '',
    release,
    marker: {
      requestedAt: '2026-08-05T12:00:00.000Z',
      release: Buffer.from(JSON.stringify(release), 'utf8').toString('base64'),
      releaseSig: 'unused-past-the-started-phase',
      signingKey: { pub: 'unused', rootSig: 'unused', keyId: 'test-key' },
      artifactUrl: 'http://127.0.0.1:1/artifact/veduta-v1.2.3-linux.tar.gz',
    },
    startedAt: '2026-08-05T12:00:00.000Z',
    releaseDir: options.releaseDir,
    runtimeDirName: `node-v9.9.9-linux-${process.arch}`,
    ...(options.backupFile !== undefined ? { backupFile: options.backupFile } : {}),
  }
}
