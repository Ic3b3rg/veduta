import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReleaseMetadata } from '@veduta/protocol'
import { fetchChecked, type Ports } from './update-ports.ts'

/**
 * Ensures the Node runtime a release needs is present (issue #43,
 * `docs/adr/0013-signed-self-update.md`'s "Scope: the whole system, honestly
 * bounded" decision — `issues/043-self-update.md` AC6): downloading and
 * verifying it when it is not. Split out of `update-transaction.ts` so the
 * runtime-fetch-and-verify concern is testable and readable on its own,
 * independent of the journal/rollback state machine.
 */

/** The subset of `update-transaction.ts`'s transaction context this module needs — a narrower shape than the full `Ctx`, so this module never has to import (or know about) the transaction's own internal state. */
export interface EnsureRuntimeDeps {
  home: { runtimesDir: string; tmpDir: string }
  ports: Ports
  env: NodeJS.ProcessEnv
  log: (line: string) => void
}

export function normalizeNodeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}

export function computeRuntimeDirName(release: ReleaseMetadata): string {
  return `node-v${normalizeNodeVersion(release.nodeVersion)}-linux-${process.arch}`
}

/** Returns the SHA-256 hex digest `SHASUMS256.txt` records for `fileName`, or `undefined` if no matching line exists — the caller decides whether that is fatal (see `ensureRuntime`: fatal when there is no signed `nodeSha256` to fall back on, a secondary-signal warning otherwise). */
function findShasumLine(shasumsText: string, fileName: string): string | undefined {
  for (const line of shasumsText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+/)
    const hash = parts[0]
    const name = parts[1]
    if (name === fileName && hash !== undefined) return hash
  }
  return undefined
}

/**
 * Ensures `runtimes/node-v<version>-linux-<arch>` exists, downloading and
 * SHA-256-verifying it when it does not. A hash mismatch throws before
 * anything is extracted or renamed into place — nothing is materialized for
 * a tampered tarball.
 *
 * Verification trust boundary (issue #43 review follow-up — AC6): when the
 * signed release metadata carries `nodeSha256` (`packages/protocol/src/update.ts`'s
 * `ReleaseMetadataSchema`), that SIGNED hash is authoritative — it cannot be
 * forged without the signing key, unlike `SHASUMS256.txt`, which is fetched
 * from the very same dist host/CDN as the tarball itself and so cannot by
 * itself catch a compromised host serving a tarball and a matching
 * `SHASUMS256.txt` together. When both are present and disagree, the signed
 * hash wins and the disagreement is only logged, never trusted over it.
 * `nodeSha256` is optional on the schema (the CI release pipeline that
 * populates it is separate work — not yet every release carries it), so a
 * release without it still needs a real check: `SHASUMS256.txt` alone is
 * used and any mismatch is fatal, same as before this hardening landed.
 */
export async function ensureRuntime(
  deps: EnsureRuntimeDeps,
  release: ReleaseMetadata,
): Promise<{ runtimeDirName: string }> {
  const runtimeDirName = computeRuntimeDirName(release)
  const runtimeDir = join(deps.home.runtimesDir, runtimeDirName)
  if (existsSync(runtimeDir)) return { runtimeDirName }

  const version = normalizeNodeVersion(release.nodeVersion)
  const distBase = (deps.env['VEDUTA_NODE_DIST_URL'] ?? 'https://nodejs.org/dist').replace(
    /\/+$/,
    '',
  )
  const distHost = new URL(distBase).hostname
  const tarName = `node-v${version}-linux-${process.arch}.tar.gz`
  const tarUrl = `${distBase}/v${version}/${tarName}`
  const shasumsUrl = `${distBase}/v${version}/SHASUMS256.txt`

  const tarBytes = await fetchChecked(
    deps.ports,
    tarUrl,
    distHost,
    release.nodeTarSize,
    'node runtime tarball',
  )
  const shasumsBytes = await fetchChecked(
    deps.ports,
    shasumsUrl,
    distHost,
    5_000_000,
    'node SHASUMS256.txt',
  )
  const shasumsHash = findShasumLine(shasumsBytes.toString('utf8'), tarName)
  const actualSha = createHash('sha256').update(tarBytes).digest('hex')

  if (release.nodeSha256 !== undefined) {
    if (actualSha !== release.nodeSha256) {
      throw new Error(
        `node runtime tarball sha256 mismatch against the signed release metadata for ${tarName}: expected ${release.nodeSha256}, got ${actualSha}`,
      )
    }
    if (shasumsHash !== undefined && shasumsHash !== actualSha) {
      deps.log(
        `warning: ${tarName} SHASUMS256.txt entry (${shasumsHash}) disagrees with the signed nodeSha256 (${actualSha}) — trusting the signed hash, since SHASUMS256.txt is fetched from the same host as the download itself`,
      )
    }
  } else {
    if (shasumsHash === undefined) {
      throw new Error(`no SHASUMS256 entry found for ${tarName}`)
    }
    if (actualSha !== shasumsHash) {
      throw new Error(
        `node runtime tarball sha256 mismatch for ${tarName}: expected ${shasumsHash}, got ${actualSha}`,
      )
    }
  }

  if (tarBytes.length !== release.nodeTarSize) {
    throw new Error(
      `node runtime tarball size mismatch for ${tarName}: expected ${release.nodeTarSize}, got ${tarBytes.length}`,
    )
  }

  const tmpTarPath = join(deps.home.tmpDir, `node-${randomBytes(6).toString('hex')}.tar.gz`)
  const stagingDir = join(deps.home.tmpDir, `node-staging-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmpTarPath, tarBytes)
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  try {
    const result = await deps.ports.execFile('tar', ['-xzf', tmpTarPath, '-C', stagingDir])
    if (result.code !== 0) {
      throw new Error(
        `extracting the node runtime tarball failed: ${result.stderr || result.stdout}`,
      )
    }
    const innerDir = join(stagingDir, tarName.replace(/\.tar\.gz$/, ''))
    if (!existsSync(innerDir)) {
      throw new Error(
        `node runtime tarball did not contain the expected top-level directory: ${innerDir}`,
      )
    }
    renameSync(innerDir, runtimeDir)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
    rmSync(tmpTarPath, { force: true })
  }
  return { runtimeDirName }
}
