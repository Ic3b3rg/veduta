/**
 * Interactive signed-update rehearsal for a disposable Local VPS instance.
 * Shares artifact staging and signing with the self-update browser tests, then
 * serves a loopback feed with a cross-host redirect (ADR-0013, issue #46).
 * Private keys are generated in memory; production signing keys are never read.
 *
 * Run from the repository root:
 *   pnpm --filter @veduta/e2e exec tsx scripts/rehearse-update.ts \
 *     --base-dir ~/.veduta-local-vps --version 0.0.1
 *
 * Restart the disposable daemon to load its new update.json, then use Check now
 * and Apply. Keep this process running until the update completes. RELEASING.md
 * describes restoring the instance's trust pinning and discarding staging data.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_DATA_VERSION } from '../../daemon/src/update/data-version.ts'
import { ReleaseMetadataSchema } from '../../protocol/src/update.ts'
import {
  buildManifest,
  buildReleaseArtifact,
  buildReleaseMetadata,
  generateFixtureKeys,
  preCreateRuntimeDir,
  signReleaseMetadata,
  signSigningKeyCert,
  writePinningFile,
} from '../tests/update-fixture.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FEED_HOST = '127.0.0.1'
const ARTIFACT_HOST = '::1'

function flag(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`)
  const value = idx === -1 ? undefined : process.argv[idx + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

function formatOrigin(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

async function tryStartArtifactServer(
  artifactName: string,
  artifactBytes: Buffer,
): Promise<{ server: ReturnType<typeof createServer>; port: number } | undefined> {
  const server = createServer((request, response) => {
    if (request.url === `/${artifactName}`) {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(artifactBytes)
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, ARTIFACT_HOST, () => done())
    })
  } catch (error) {
    server.close()
    console.error(
      `rehearse-update: no loopback interface on ${ARTIFACT_HOST} ` +
        `(${error instanceof Error ? error.message : String(error)}); serving the artifact from ` +
        'the feed host instead — this run cannot exercise the cross-host redirect fix (issue #46)',
    )
    return undefined
  }
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('rehearse-update: artifact server started without an assigned port')
  }
  return { server, port: address.port }
}

async function main(): Promise<void> {
  const baseDir = resolve(expandHome(flag('base-dir', join(homedir(), '.veduta-local-vps'))))
  const version = ReleaseMetadataSchema.shape.version.parse(flag('version', '0.0.1'))
  const port = Number(flag('port', '8799'))
  const updateHome = join(baseDir, 'updates')
  const staging = join(baseDir, 'rehearsal')

  if (!existsSync(baseDir)) throw new Error(`no such base dir: ${baseDir}`)
  mkdirSync(staging, { recursive: true })

  console.error('building the PWA…')
  execFileSync('pnpm', ['--filter', '@veduta/pwa', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  console.error('staging the release…')
  const artifact = await buildReleaseArtifact({ workDir: staging, version })
  const artifactBytes = readFileSync(artifact.artifactPath)
  const artifactName = artifact.artifactName
  preCreateRuntimeDir(updateHome, artifact.nodeVersion)

  // GitHub release URLs redirect to a different host. The IPv6 loopback
  // reproduces that hop; without IPv6 the same-host download remains usable.
  const artifactAttempt = await tryStartArtifactServer(artifactName, artifactBytes)
  const feedOrigin = formatOrigin(FEED_HOST, port)
  const artifactOrigin = artifactAttempt
    ? formatOrigin(ARTIFACT_HOST, artifactAttempt.port)
    : feedOrigin
  const artifactUrl = `${feedOrigin}/${artifactName}`
  const release = {
    ...buildReleaseMetadata(artifact, { dataVersion: CURRENT_DATA_VERSION, notesMarker: version }),
    // Sign the feed-origin URL before creating the redirecting manifest.
    artifactUrl,
    notes: `Rehearsal release ${version} — throwaway keys, loopback feed. Not a real release.`,
  }
  const keys = generateFixtureKeys()
  const manifest = buildManifest({
    ...signReleaseMetadata(release, keys.signing),
    signingKeyCert: signSigningKeyCert(keys),
    artifactUrl,
  })
  const pinningPath = join(baseDir, 'update.json')
  writePinningFile(pinningPath, {
    feedUrl: `${feedOrigin}/stable.json`,
    rootPublicKey: keys.root.publicKeyText,
  })

  const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8')
  const feedServer = createServer((request, response) => {
    if (request.url === '/stable.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(manifestBody)
      return
    }
    if (request.url === `/${artifactName}`) {
      if (artifactAttempt !== undefined) {
        response.writeHead(302, { location: `${artifactOrigin}/${artifactName}` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(artifactBytes)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((done) => feedServer.listen(port, FEED_HOST, () => done()))

  console.error('\n  rehearsal feed ready')
  console.error(`    feed          ${feedOrigin}/stable.json`)
  console.error(`    artifact url  ${artifactUrl}  (signed, issue #46)`)
  console.error(
    artifactAttempt
      ? `    redirect      302 from the feed -> ${artifactOrigin}/${artifactName} (cross-host)`
      : '    redirect      none — no IPv6 loopback here, the feed serves the bytes itself',
  )
  console.error(
    `    size          ${(artifactBytes.length / 1_048_576).toFixed(1)} MiB, ${artifact.entryCount} entries`,
  )
  console.error(`    version       ${version}  (dataVersion ${release.dataVersion})`)
  console.error(`    pinning       ${pinningPath}`)
  console.error(`    update home   ${updateHome}`)
  console.error('\n  Restart the disposable daemon, then use Check now -> Apply update.')
  console.error('  Leave this running until the update finishes. Ctrl-C to stop.')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
