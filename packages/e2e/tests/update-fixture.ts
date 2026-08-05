import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReleaseMetadataSchema,
  UpdateManifestSchema,
  UpdatePinningSchema,
  type ReleaseMetadata,
  type SigningKeyCert,
  type UpdateManifest,
  type UpdatePinning,
} from '../../protocol/src/update.ts'
import {
  generateKeypair,
  publicKeyIdText,
  sign,
  type GeneratedKeypair,
} from '../../daemon/src/update/minisign.ts'
import { preflightArchive } from '../../daemon/src/update/tar-reader.ts'
import { findFreePort } from './stack.ts'

/**
 * Builds the self-contained release artifact + minisign trust chain the
 * signed self-update e2e (`self-update.spec.ts`, issue #43,
 * `docs/adr/0013-signed-self-update.md`) needs, without depending on the
 * real `minisign` CLI or a real GitHub release: `generateKeypair`/`sign`
 * (`packages/daemon/src/update/minisign.ts`) produce the identical wire
 * format the daemon's own `verifyReleaseChain` accepts, and the artifact
 * itself is built by tarring this very checkout -- pnpm's node_modules
 * layout is a relative, in-tree symlink forest, so a plain tar of the
 * checkout (sources + the built PWA + every workspace `node_modules` tree)
 * is self-contained by construction (the updater's own containment preflight
 * in `packages/daemon/src/update/tar-reader.ts` proves it: a tar whose
 * symlinks escaped the tree would be refused outright).
 *
 * `packages/e2e` declares no dependency on `@veduta/protocol`/`@veduta/daemon`
 * in its own `package.json` -- the imports above resolve by relative path
 * straight to each package's own `src/`, which is a plain TypeScript module
 * resolution (no pnpm linking involved) and lets each imported file's own
 * transitive dependencies (e.g. `zod`, resolved from `packages/protocol`'s
 * own `node_modules`) resolve normally from its actual location on disk.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// --- Release artifact -------------------------------------------------------

export interface BuiltArtifact {
  artifactPath: string
  artifactName: string
  version: string
  sha256: string
  artifactSize: number
  unpackedSize: number
  entryCount: number
  /** This checkout's own pinned Node version (`.node-version`) -- see `preCreateRuntimeDir`. */
  nodeVersion: string
}

/** Every workspace `node_modules` tree that actually exists (root + each `packages/*`). */
function workspaceNodeModulesDirs(repoRoot: string): string[] {
  const dirs: string[] = []
  if (existsSync(join(repoRoot, 'node_modules'))) dirs.push('node_modules')
  const packagesDir = join(repoRoot, 'packages')
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join('packages', entry.name, 'node_modules')
    if (existsSync(join(repoRoot, candidate))) dirs.push(candidate)
  }
  return dirs
}

const VERSION_TS_PLACEHOLDER = "export const VEDUTA_VERSION = '0.0.0-dev'"

/**
 * Stages a runnable copy of this checkout under a fresh temp dir (git-tracked
 * sources via `git ls-files`, the built PWA, every workspace `node_modules`
 * tree -- symlinks preserved verbatim, never dereferenced), stamps the
 * staged copy's own `packages/daemon/src/version.ts` to `version` (the
 * tracked source itself is never touched -- `docs/adr/0013-signed-self-update.md`'s
 * "Amendments" section: only a release build's artifact copy carries a real
 * `x.y.z`), and tars the whole staged tree into `veduta-v<version>-linux.tar.gz`
 * under `workDir`. `COPYFILE_DISABLE=1` suppresses macOS's AppleDouble
 * (`._*`) sidecar files that `tar` would otherwise emit for every entry on a
 * dev machine -- irrelevant, but harmless, on Linux CI.
 *
 * Exact `entryCount`/`unpackedSize` come from `preflightArchive`
 * (`packages/daemon/src/update/tar-reader.ts`) run over the artifact this
 * function just built -- the same reader the real transaction's own
 * preflight uses, so the signed metadata this fixture produces can never
 * under-count what extraction will actually see.
 */
export async function buildReleaseArtifact(options: {
  workDir: string
  version: string
}): Promise<BuiltArtifact> {
  const { workDir, version } = options
  const stagingDir = mkdtempSync(join(workDir, 'veduta-release-staging-'))
  const env = { ...process.env, COPYFILE_DISABLE: '1' }

  execFileSync(
    'bash',
    ['-c', `git ls-files -z | tar --null -T - -cf - | tar -xf - -C "${stagingDir}"`],
    { cwd: REPO_ROOT, env },
  )

  // `server.ts`'s `defaultPwaDistDir` resolves relative to its own module
  // location, so the built PWA must land at this same path inside the
  // staged tree for the flipped-to release to serve it.
  execFileSync('pnpm', ['--filter', '@veduta/pwa', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' })
  mkdirSync(join(stagingDir, 'packages', 'pwa'), { recursive: true })
  execFileSync('cp', [
    '-a',
    join(REPO_ROOT, 'packages', 'pwa', 'dist'),
    join(stagingDir, 'packages', 'pwa', 'dist'),
  ])

  for (const rel of workspaceNodeModulesDirs(REPO_ROOT)) {
    const dest = join(stagingDir, rel)
    mkdirSync(join(dest, '..'), { recursive: true })
    execFileSync('cp', ['-a', join(REPO_ROOT, rel), dest])
  }

  const versionTsPath = join(stagingDir, 'packages', 'daemon', 'src', 'version.ts')
  const versionTsSource = readFileSync(versionTsPath, 'utf8')
  if (!versionTsSource.includes(VERSION_TS_PLACEHOLDER)) {
    throw new Error(
      `buildReleaseArtifact: expected to find "${VERSION_TS_PLACEHOLDER}" in ${versionTsPath} -- version.ts's literal changed?`,
    )
  }
  writeFileSync(
    versionTsPath,
    versionTsSource.replace(VERSION_TS_PLACEHOLDER, `export const VEDUTA_VERSION = '${version}'`),
  )

  const artifactName = `veduta-v${version}-linux.tar.gz`
  const artifactPath = join(workDir, artifactName)
  execFileSync('bash', ['-c', `tar -cf - -C "${stagingDir}" . | gzip -1 > "${artifactPath}"`], {
    env,
  })

  const artifactBytes = readFileSync(artifactPath)
  const sha256 = createHash('sha256').update(artifactBytes).digest('hex')
  const { entries, unpackedBytes } = await preflightArchive(artifactPath, {
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxUnpackedBytes: Number.MAX_SAFE_INTEGER,
  })
  const nodeVersion = readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim()

  return {
    artifactPath,
    artifactName,
    version,
    sha256,
    artifactSize: artifactBytes.length,
    unpackedSize: unpackedBytes,
    entryCount: entries,
    nodeVersion,
  }
}

/**
 * Pre-creates the runtime directory `update-transaction.ts`'s `ensureRuntime`
 * looks for before ever downloading anything, so this harness never needs a
 * fake Node-dist server: every `ReleaseMetadata` this fixture signs pins
 * `nodeVersion` to this checkout's own `.node-version`
 * (`BuiltArtifact.nodeVersion`), so the runtime this very process is already
 * running under is exactly what the "new" release would install anyway --
 * the runtime-jump path itself (issue #43 AC6) is exercised by
 * `update-transaction.test.ts`'s harness tests, with a fake dist server, not
 * here. `deploy/veduta-run`'s `resolve_node_bin` falls back to the system
 * `node` on PATH whenever this directory has no `bin/node` inside it, which
 * is exactly what an empty directory produces -- all `ensureRuntime`'s own
 * `existsSync` check needs to skip the download entirely.
 */
export function preCreateRuntimeDir(updateHome: string, nodeVersion: string): void {
  const normalized = nodeVersion.startsWith('v') ? nodeVersion.slice(1) : nodeVersion
  const dirName = `node-v${normalized}-linux-${process.arch}`
  mkdirSync(join(updateHome, 'runtimes', dirName), { recursive: true })
}

// --- Minisign trust chain ----------------------------------------------------

export interface FixtureKeys {
  root: GeneratedKeypair
  signing: GeneratedKeypair
}

export function generateFixtureKeys(): FixtureKeys {
  return { root: generateKeypair(), signing: generateKeypair() }
}

/** Mirrors `minisign.ts`'s own private `SIGNING_KEY_CERT_TRUSTED_COMMENT` constant -- `verifyReleaseChain` requires the signing key cert's trusted comment to equal this exact literal. */
const SIGNING_KEY_CERT_TRUSTED_COMMENT = 'signing.pub'

/** Signs `keys.signing`'s public key text with `rootKeys.root` -- the normal case. Tests that need an "un-rooted" cert (AC2) pass a *different* `FixtureKeys.root` here than the one written into the pinning file. */
export function signSigningKeyCert(
  keys: FixtureKeys,
  rootKeys: FixtureKeys = keys,
): SigningKeyCert {
  const rootSig = sign({
    contentBytes: Buffer.from(keys.signing.publicKeyText, 'utf8'),
    secretKey: rootKeys.root.secretKey,
    trustedComment: SIGNING_KEY_CERT_TRUSTED_COMMENT,
  })
  return {
    pub: keys.signing.publicKeyText,
    rootSig,
    keyId: publicKeyIdText(keys.signing.publicKeyText),
  }
}

export function buildReleaseMetadata(
  artifact: BuiltArtifact,
  options: { dataVersion: number; notesMarker: string },
): ReleaseMetadata {
  return ReleaseMetadataSchema.parse({
    version: artifact.version,
    artifactName: artifact.artifactName,
    sha256: artifact.sha256,
    artifactSize: artifact.artifactSize,
    unpackedSize: artifact.unpackedSize,
    entryCount: artifact.entryCount,
    dataVersion: options.dataVersion,
    nodeVersion: artifact.nodeVersion,
    // The runtime-jump path is not exercised by this e2e (`preCreateRuntimeDir`
    // makes `ensureRuntime` skip any download) -- small honest placeholders,
    // per issues/043-self-update.md's AC6 (exercised instead by
    // `update-transaction.test.ts`'s harness tests, with a fake dist server).
    nodeTarSize: 1024,
    nodeUnpackedSize: 4096,
    notes: `Test release notes: ${options.notesMarker}`,
  })
}

export function signReleaseMetadata(
  release: ReleaseMetadata,
  signingKey: GeneratedKeypair,
): { releaseBytes: Buffer; releaseSig: string } {
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8')
  const releaseSig = sign({
    contentBytes: releaseBytes,
    secretKey: signingKey.secretKey,
    trustedComment: release.artifactName,
  })
  return { releaseBytes, releaseSig }
}

export function buildManifest(options: {
  releaseBytes: Buffer
  releaseSig: string
  signingKeyCert: SigningKeyCert
  artifactUrl: string
}): UpdateManifest {
  return UpdateManifestSchema.parse({
    schemaVersion: 1,
    release: options.releaseBytes.toString('base64'),
    releaseSig: options.releaseSig,
    signingKey: options.signingKeyCert,
    artifactUrl: options.artifactUrl,
  })
}

/** Flips one byte of a copy of `bytes` -- tamper helper for AC2's "artifact bytes do not match the signed sha256" scenario. */
export function flipByte(bytes: Buffer, index = 0): Buffer {
  const copy = Buffer.from(bytes)
  copy[index] = (copy[index] ?? 0) ^ 0xff
  return copy
}

// --- Local feed server -------------------------------------------------------

export interface FeedServer {
  readonly origin: string
  readonly feedUrl: string
  setManifest(bytes: Buffer): void
  setArtifact(name: string, bytes: Buffer): void
  close(): Promise<void>
}

/**
 * A 127.0.0.1 http server standing in for the real gated `stable.json` feed
 * (`docs/adr/0013-signed-self-update.md`): serves whatever `setManifest`/
 * `setArtifact` last set, so one server instance can be reconfigured across
 * a scenario's sequential steps (e.g. AC2's bad-signature check followed by
 * a validly-signed-but-tampered-artifact apply) without restarting anything.
 */
export async function startFeedServer(): Promise<FeedServer> {
  const port = await findFreePort()
  let manifestBytes: Buffer | undefined
  const artifacts = new Map<string, Buffer>()

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/stable.json') {
      if (!manifestBytes) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(manifestBytes)
      return
    }
    const name = url.startsWith('/') ? url.slice(1) : url
    const bytes = artifacts.get(name)
    if (!bytes) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(bytes)
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    origin: `http://127.0.0.1:${port}`,
    feedUrl: `http://127.0.0.1:${port}/stable.json`,
    setManifest: (bytes) => {
      manifestBytes = bytes
    },
    setArtifact: (name, bytes) => {
      artifacts.set(name, bytes)
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// --- Pinning -----------------------------------------------------------------

/** Writes `<base-dir>/update.json` (`UpdatePinningSchema`) -- must exist BEFORE the stack boots, since `server.ts` only wires `UpdateManager` when the pinning file already parses at daemon startup. */
export function writePinningFile(path: string, pinning: UpdatePinning): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(UpdatePinningSchema.parse(pinning), null, 2)}\n`)
}
