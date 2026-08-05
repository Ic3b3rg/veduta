/**
 * Rehearsal of the signed-update ceremony against a REAL installed instance,
 * with THROWAWAY keys and a loopback feed (issue #43,
 * `docs/adr/0013-signed-self-update.md`; the maintainer ceremony with real keys
 * is `RELEASING.md`, and nothing here replaces it).
 *
 * What this is for: proving the whole path end to end — root -> signing key ->
 * signed release metadata -> artifact hash -> containment preflight -> backup ->
 * symlink flip -> deep health check -> outcome on the Surface — on your own
 * install, before a real root key exists. It exercises the same code the real
 * updater runs; only the trust anchor and the feed host are disposable.
 *
 * What it deliberately does NOT do: generate, read, or touch a production root
 * key. The keys minted here live in the staging directory and are meant to be
 * thrown away.
 *
 * Usage (from the repository checkout, on the machine running the daemon):
 *
 *   pnpm --filter @veduta/daemon exec tsx ../../scripts/rehearse-update.ts \
 *     --base-dir ~/.veduta-local-vps --version 0.0.1
 *
 * It stages everything, prints the feed URL and the pinning file it wrote, and
 * then serves the feed in the foreground until you stop it with Ctrl-C. Leave it
 * running while you restart the daemon and tap "Check now" -> "Apply update".
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeypair, publicKeyIdText, sign } from '../packages/daemon/src/update/minisign.ts'
import { preflightArchive } from '../packages/daemon/src/update/tar-reader.ts'
import { execFileSync } from 'node:child_process'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The trusted comment the verifier requires on a signing key's certificate. */
const SIGNING_KEY_CERT_TRUSTED_COMMENT = 'signing.pub'

function flag(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`)
  const value = idx === -1 ? undefined : process.argv[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    if (fallback !== undefined) return fallback
    throw new Error(`missing required --${name}`)
  }
  return value
}

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/**
 * Stages a runnable copy of this checkout and tars it into
 * `veduta-v<version>-linux.tar.gz`, stamping the staged copy's own `version.ts`
 * so the release genuinely reports the new version once it serves. Symlinks are
 * preserved (never dereferenced): pnpm's `node_modules` is a relative in-tree
 * symlink forest, so the tar stays self-contained — and the updater's own
 * containment preflight is what proves it.
 */
function buildArtifact(stagingRoot: string, version: string): string {
  const stage = join(stagingRoot, 'tree')
  mkdirSync(stage, { recursive: true })
  const env = { ...process.env, COPYFILE_DISABLE: '1' }

  console.error('staging the tracked sources…')
  execFileSync(
    'bash',
    ['-c', `git ls-files -z | tar --null -T - -cf - | tar -xf - -C "${stage}"`],
    {
      cwd: REPO_ROOT,
      env,
    },
  )

  console.error('building the PWA…')
  execFileSync('pnpm', ['--filter', '@veduta/pwa', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' })
  mkdirSync(join(stage, 'packages', 'pwa'), { recursive: true })
  execFileSync('cp', [
    '-a',
    join(REPO_ROOT, 'packages', 'pwa', 'dist'),
    join(stage, 'packages', 'pwa', 'dist'),
  ])

  console.error('copying node_modules (this is the slow part)…')
  for (const rel of nodeModulesDirs()) {
    execFileSync('cp', ['-a', join(REPO_ROOT, rel), join(stage, rel)])
  }

  const versionTs = join(stage, 'packages', 'daemon', 'src', 'version.ts')
  const placeholder = "export const VEDUTA_VERSION = '0.0.0-dev'"
  const source = readFileSync(versionTs, 'utf8')
  if (!source.includes(placeholder)) {
    throw new Error(`rehearse-update: ${versionTs} no longer carries the expected placeholder`)
  }
  writeFileSync(
    versionTs,
    source.replace(placeholder, `export const VEDUTA_VERSION = '${version}'`),
  )

  const artifactPath = join(stagingRoot, `veduta-v${version}-linux.tar.gz`)
  console.error('tarring the release…')
  execFileSync('bash', ['-c', `tar -cf - -C "${stage}" . | gzip -1 > "${artifactPath}"`], { env })
  return artifactPath
}

function nodeModulesDirs(): string[] {
  const dirs: string[] = []
  if (existsSync(join(REPO_ROOT, 'node_modules'))) dirs.push('node_modules')
  for (const pkg of ['protocol', 'daemon', 'catalog', 'pwa', 'e2e']) {
    const rel = join('packages', pkg, 'node_modules')
    if (existsSync(join(REPO_ROOT, rel))) dirs.push(rel)
  }
  return dirs
}

async function main(): Promise<void> {
  const baseDir = resolve(expandHome(flag('base-dir', join(homedir(), '.veduta-local-vps'))))
  const version = flag('version', '0.0.1')
  const port = Number(flag('port', '8799'))
  const updateHome = join(baseDir, 'updates')
  const staging = join(baseDir, 'rehearsal')

  if (!existsSync(baseDir)) throw new Error(`no such base dir: ${baseDir}`)
  mkdirSync(staging, { recursive: true })

  const artifactPath = buildArtifact(staging, version)
  const artifactBytes = readFileSync(artifactPath)
  const artifactName = `veduta-v${version}-linux.tar.gz`

  // Entry count and unpacked size come from the SAME reader the updater's own
  // preflight uses, so the signed numbers can never under-count what extraction
  // will see (the failure mode that made the first release workflow unusable).
  const { entries, unpackedBytes } = await preflightArchive(artifactPath, {
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxUnpackedBytes: Number.MAX_SAFE_INTEGER,
  })

  const nodeVersion = readFileSync(join(REPO_ROOT, '.node-version'), 'utf8').trim()
  // Pre-create the runtime directory the release pins, so `ensureRuntime` finds
  // it and never downloads: this rehearsal is about the update transaction, not
  // about a runtime jump (that path has its own harness tests).
  mkdirSync(join(updateHome, 'runtimes', `node-v${nodeVersion}-linux-${process.arch}`), {
    recursive: true,
  })

  const release = {
    version,
    artifactName,
    sha256: createHash('sha256').update(artifactBytes).digest('hex'),
    artifactSize: artifactBytes.length,
    unpackedSize: unpackedBytes,
    entryCount: entries,
    dataVersion: 1,
    nodeVersion,
    nodeTarSize: 1,
    nodeUnpackedSize: 1,
    notes: `Rehearsal release ${version} — throwaway keys, loopback feed. Not a real release.`,
  }

  // The throwaway two-tier chain: a root that signs the signing key's pubkey,
  // and a signing key that signs the canonical release bytes with the artifact
  // name as the trusted comment (the name+contents binding).
  const root = generateKeypair()
  const signing = generateKeypair()
  const signingCert = sign({
    contentBytes: Buffer.from(signing.publicKeyText, 'utf8'),
    secretKey: root.secretKey,
    trustedComment: SIGNING_KEY_CERT_TRUSTED_COMMENT,
  })
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8')
  const releaseSig = sign({
    contentBytes: releaseBytes,
    secretKey: signing.secretKey,
    trustedComment: artifactName,
  })

  const origin = `http://127.0.0.1:${port}`
  const manifest = {
    schemaVersion: 1 as const,
    release: releaseBytes.toString('base64'),
    releaseSig,
    signingKey: {
      pub: signing.publicKeyText,
      rootSig: signingCert,
      keyId: publicKeyIdText(signing.publicKeyText),
    },
    artifactUrl: `${origin}/${artifactName}`,
  }

  const pinningPath = join(baseDir, 'update.json')
  writeFileSync(
    pinningPath,
    `${JSON.stringify({ feedUrl: `${origin}/stable.json`, rootPublicKey: root.publicKeyText }, null, 2)}\n`,
  )

  const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8')
  const server = createServer((request, response) => {
    if (request.url === '/stable.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(manifestBody)
      return
    }
    if (request.url === `/${artifactName}`) {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(artifactBytes)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', () => done()))

  console.error('')
  console.error('  rehearsal feed ready')
  console.error(`    feed          ${origin}/stable.json`)
  console.error(
    `    artifact      ${(artifactBytes.length / 1_048_576).toFixed(1)} MiB, ${entries} entries`,
  )
  console.error(`    version       ${version}  (dataVersion ${release.dataVersion})`)
  console.error(`    pinning       ${pinningPath}`)
  console.error(`    update home   ${updateHome}`)
  console.error('')
  console.error('  next, in another shell:')
  console.error('    sudo systemctl restart veduta-local     # picks up the pinning file')
  console.error('    then in the browser: Check now -> Apply update')
  console.error('')
  console.error('  leave this running until the update finishes. Ctrl-C to stop.')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
