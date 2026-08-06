import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReleaseMetadataSchema, UpdateManifestSchema } from '@veduta/protocol'
import type { ReleaseMetadata } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeypair, publicKeyIdText, sign, verifyReleaseChain } from './minisign.ts'

/**
 * The seam between the two halves of signed self-update: `deploy/release.sh`
 * writes `feed/stable.json`, and this package's `verifyReleaseChain` is what
 * every installed instance runs against it. Both were tested — separately —
 * and both passed while disagreeing about the exact bytes the root signature
 * covers, so the first two promoted feeds verified perfectly with the
 * `minisign` CLI and would have been refused by every instance on earth
 * (issue #46; the cause was the signing key's trailing newline, dropped on
 * the way into the JSON and re-added only on the way back out, inside the
 * script that wrote it).
 *
 * This test exists so that class of divergence cannot come back: it runs the
 * real ceremony script and hands what it produced to the real verifier. It
 * needs no `minisign` binary — `promote` only embeds and re-encodes files
 * others produced, so the test-only signer here stands in for the maintainer's
 * key, exactly as it does in `minisign.test.ts`.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const RELEASE_SH = join(REPO_ROOT, 'deploy', 'release.sh')

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-ceremony-'))
  tmpDirs.push(dir)
  return dir
}

function releaseFixture(): ReleaseMetadata {
  return ReleaseMetadataSchema.parse({
    version: '1.2.3',
    artifactName: 'veduta-v1.2.3-linux.tar.gz',
    artifactUrl: 'https://example.test/releases/download/v1.2.3/veduta-v1.2.3-linux.tar.gz',
    sha256: 'a'.repeat(64),
    artifactSize: 1024,
    unpackedSize: 4096,
    entryCount: 12,
    dataVersion: 1,
    nodeVersion: '24.11.1',
    nodeTarSize: 2048,
    nodeUnpackedSize: 8192,
    notes: 'a fixture release',
  })
}

describe('deploy/release.sh promote — what the ceremony writes, an instance must accept', () => {
  it('produces a manifest whose chain verifies with the daemon verifier, not only with minisign', () => {
    const dir = freshDir()
    const root = generateKeypair()
    const signing = generateKeypair()

    // Same on-disk shapes the real ceremony has: minisign writes every file
    // with a trailing newline, and CI writes `release.json` pretty-printed —
    // the layout `release.sh`'s anchored field reader expects.
    const release = releaseFixture()
    const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8')
    const releaseJson = join(dir, 'release.json')
    writeFileSync(releaseJson, releaseBytes)

    const signingPub = join(dir, 'signing.pub')
    writeFileSync(signingPub, signing.publicKeyText)
    const signingPubSig = join(dir, 'signing.pub.minisig')
    writeFileSync(
      signingPubSig,
      sign({
        contentBytes: Buffer.from(signing.publicKeyText, 'utf8'),
        secretKey: root.secretKey,
        trustedComment: 'signing.pub',
      }),
    )
    const releaseSig = join(dir, 'release.json.minisig')
    writeFileSync(
      releaseSig,
      sign({
        contentBytes: releaseBytes,
        secretKey: signing.secretKey,
        trustedComment: release.artifactName,
      }),
    )

    const out = join(dir, 'stable.json')
    execFileSync(
      'bash',
      [
        RELEASE_SH,
        'promote',
        releaseJson,
        releaseSig,
        '--signing-pub',
        signingPub,
        '--signing-pub-sig',
        signingPubSig,
        '--out',
        out,
      ],
      { stdio: 'pipe' },
    )

    const manifest = UpdateManifestSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    const embedded = Buffer.from(manifest.release, 'base64')
    // The signed bytes must survive the round trip untouched — re-serializing
    // the object would change key order or whitespace and break the signature.
    expect(embedded.equals(releaseBytes)).toBe(true)
    // The one that regressed: the manifest must carry the key file verbatim,
    // trailing newline included, because that is what the root signed.
    expect(manifest.signingKey.pub).toBe(signing.publicKeyText)
    expect(manifest.artifactUrl).toBe(release.artifactUrl)

    expect(() =>
      verifyReleaseChain({
        releaseBytes: embedded,
        releaseSigText: manifest.releaseSig,
        signingKeyText: manifest.signingKey.pub,
        signingKeyRootSigText: manifest.signingKey.rootSig,
        rootPublicKeyText: root.publicKeyText,
        expectedArtifactName: release.artifactName,
        expectedSigningKeyId: publicKeyIdText(signing.publicKeyText),
      }),
    ).not.toThrow()
  })
})
