import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkMonotonic,
  generateKeypair,
  parsePublicKey,
  parseSignature,
  sign,
  verify,
  verifyReleaseChain,
} from './minisign.ts'

// Golden fixtures generated once with the real minisign 0.12 CLI (throwaway,
// unencrypted `-W` keys) — see docs/adr/0013-signed-self-update.md, Amendments. root signs signing.pub
// (trusted comment 'signing.pub'); the signing key signs both release.json
// and the artifact (each trusted comment 'veduta-v9.9.9-linux.tar.gz').
const fixturesDir = fileURLToPath(new URL('./fixtures/minisign', import.meta.url))

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8')
}

function readFixtureBytes(name: string): Buffer {
  return readFileSync(join(fixturesDir, name))
}

const ARTIFACT_NAME = 'veduta-v9.9.9-linux.tar.gz'

describe('parsePublicKey / parseSignature', () => {
  it('parses a well-formed public key', () => {
    const key = parsePublicKey(readFixture('root.pub'))
    expect(key.keyId).toHaveLength(8)
    expect(key.publicKey).toHaveLength(32)
  })

  it('rejects a public key with the wrong algorithm tag', () => {
    const corrupt = readFixture('root.pub').replace('RWR+', 'XXR+')
    expect(() => parsePublicKey(corrupt)).toThrow(/algorithm/)
  })

  it('rejects a malformed public key line', () => {
    expect(() => parsePublicKey('untrusted comment: x\nnot-base64!!!\n')).toThrow()
  })

  it('parses a well-formed signature file', () => {
    const signature = parseSignature(readFixture('artifact.minisig'))
    expect(signature.algorithm).toBe('ED')
    expect(signature.keyId).toHaveLength(8)
    expect(signature.signature).toHaveLength(64)
    expect(signature.globalSignature).toHaveLength(64)
    expect(signature.trustedComment).toBe(ARTIFACT_NAME)
  })

  it('rejects a signature file missing the trusted comment prefix', () => {
    const lines = readFixture('artifact.minisig').split('\n')
    lines[2] = (lines[2] as string).replace('trusted comment: ', '')
    expect(() => parseSignature(lines.join('\n'))).toThrow(/trusted comment/)
  })
})

describe('verify — golden fixtures (interop proof)', () => {
  it('accepts the root signature over signing.pub', () => {
    const comment = verify({
      contentBytes: Buffer.from(readFixture('signing.pub'), 'utf8'),
      signatureText: readFixture('signing.pub.minisig'),
      publicKeyText: readFixture('root.pub'),
    })
    expect(comment).toBe('signing.pub')
  })

  it('accepts the signing key signature over release.json', () => {
    const comment = verify({
      contentBytes: readFixtureBytes('release.json'),
      signatureText: readFixture('release.json.minisig'),
      publicKeyText: readFixture('signing.pub'),
    })
    expect(comment).toBe(ARTIFACT_NAME)
  })

  it('accepts the signing key signature over the artifact', () => {
    const comment = verify({
      contentBytes: readFixtureBytes(ARTIFACT_NAME),
      signatureText: readFixture('artifact.minisig'),
      publicKeyText: readFixture('signing.pub'),
    })
    expect(comment).toBe(ARTIFACT_NAME)
  })
})

describe('verify — failure modes', () => {
  it('refuses tampered content', () => {
    const tampered = Buffer.concat([readFixtureBytes(ARTIFACT_NAME), Buffer.from('x')])
    expect(() =>
      verify({
        contentBytes: tampered,
        signatureText: readFixture('artifact.minisig'),
        publicKeyText: readFixture('signing.pub'),
      }),
    ).toThrow(/content signature/)
  })

  it('refuses verification against the wrong public key', () => {
    expect(() =>
      verify({
        contentBytes: readFixtureBytes(ARTIFACT_NAME),
        signatureText: readFixture('artifact.minisig'),
        publicKeyText: readFixture('root.pub'),
      }),
    ).toThrow(/key id/)
  })

  it('refuses a tampered trusted comment (global signature)', () => {
    const corrupt = readFixture('artifact.minisig').replace(
      ARTIFACT_NAME,
      'veduta-v9.9.9-evil.tar.gz',
    )
    expect(() =>
      verify({
        contentBytes: readFixtureBytes(ARTIFACT_NAME),
        signatureText: corrupt,
        publicKeyText: readFixture('signing.pub'),
      }),
    ).toThrow(/global signature/)
  })

  it('rejects the legacy (non-prehashed) signature algorithm', () => {
    // Flip the 'ED' algorithm tag byte back to legacy 'Ed' inside the base64 blob.
    const lines = readFixture('artifact.minisig').split('\n')
    const decoded = Buffer.from(lines[1] as string, 'base64')
    decoded[1] = 0x64 // 'd' — 'ED' -> 'Ed'
    lines[1] = decoded.toString('base64')
    const corrupt = lines.join('\n')
    expect(() =>
      verify({
        contentBytes: readFixtureBytes(ARTIFACT_NAME),
        signatureText: corrupt,
        publicKeyText: readFixture('signing.pub'),
      }),
    ).toThrow(/legacy/)
  })
})

describe('verifyReleaseChain — golden fixtures', () => {
  it('succeeds for the fixture set with the matching artifact name', () => {
    expect(() =>
      verifyReleaseChain({
        releaseBytes: readFixtureBytes('release.json'),
        releaseSigText: readFixture('release.json.minisig'),
        signingKeyText: readFixture('signing.pub'),
        signingKeyRootSigText: readFixture('signing.pub.minisig'),
        rootPublicKeyText: readFixture('root.pub'),
        expectedArtifactName: ARTIFACT_NAME,
      }),
    ).not.toThrow()
  })

  it('refuses a renamed artifact (expectedArtifactName mismatch)', () => {
    expect(() =>
      verifyReleaseChain({
        releaseBytes: readFixtureBytes('release.json'),
        releaseSigText: readFixture('release.json.minisig'),
        signingKeyText: readFixture('signing.pub'),
        signingKeyRootSigText: readFixture('signing.pub.minisig'),
        rootPublicKeyText: readFixture('root.pub'),
        expectedArtifactName: 'veduta-v9.9.9-windows.tar.gz',
      }),
    ).toThrow(/different artifact/)
  })

  it('refuses an un-rooted signing key (self-generated, no genuine root cert)', () => {
    // A forged chain: a fresh signing key "certifies" itself instead of being
    // certified by the pinned root — models an attacker who controls a
    // signing key but was never endorsed by the real root.
    const forgedSigning = generateKeypair()
    const selfCert = sign({
      contentBytes: Buffer.from(forgedSigning.publicKeyText, 'utf8'),
      secretKey: forgedSigning.secretKey,
      trustedComment: 'signing.pub',
    })
    expect(() =>
      verifyReleaseChain({
        releaseBytes: readFixtureBytes('release.json'),
        releaseSigText: readFixture('release.json.minisig'),
        signingKeyText: forgedSigning.publicKeyText,
        signingKeyRootSigText: selfCert,
        rootPublicKeyText: readFixture('root.pub'),
        expectedArtifactName: ARTIFACT_NAME,
      }),
    ).toThrow(/not rooted/)
  })

  it('accepts a root-signed replacement signing key (throwaway generated chain)', () => {
    // AC7 positive case: rotating the signing key under an unchanged root
    // requires no client re-trust. The committed fixtures don't include the
    // root secret key, so this builds an entire fresh chain with the
    // test-only keygen/sign helpers to exercise the same chain logic.
    const root = generateKeypair()
    const signing = generateKeypair()
    const signingCert = sign({
      contentBytes: Buffer.from(signing.publicKeyText, 'utf8'),
      secretKey: root.secretKey,
      trustedComment: 'signing.pub',
    })
    const release = Buffer.from(
      JSON.stringify({ version: '1.2.3', artifactName: 'veduta-v1.2.3-linux.tar.gz' }),
    )
    const releaseSig = sign({
      contentBytes: release,
      secretKey: signing.secretKey,
      trustedComment: 'veduta-v1.2.3-linux.tar.gz',
    })
    expect(() =>
      verifyReleaseChain({
        releaseBytes: release,
        releaseSigText: releaseSig,
        signingKeyText: signing.publicKeyText,
        signingKeyRootSigText: signingCert,
        rootPublicKeyText: root.publicKeyText,
        expectedArtifactName: 'veduta-v1.2.3-linux.tar.gz',
      }),
    ).not.toThrow()
  })

  it('refuses a downgrade re-advertisement (old signed release offered again)', () => {
    // The chain itself has no notion of "newer" — that is checkMonotonic's
    // job (tested below). A validly-signed old release still verifies here;
    // this test documents that boundary so the two checks are never confused.
    expect(() =>
      verifyReleaseChain({
        releaseBytes: readFixtureBytes('release.json'),
        releaseSigText: readFixture('release.json.minisig'),
        signingKeyText: readFixture('signing.pub'),
        signingKeyRootSigText: readFixture('signing.pub.minisig'),
        rootPublicKeyText: readFixture('root.pub'),
        expectedArtifactName: ARTIFACT_NAME,
      }),
    ).not.toThrow()
    expect(() =>
      checkMonotonic({
        offeredVersion: '9.9.9',
        installedVersion: '9.9.9',
        offeredDataVersion: 1,
        installedDataVersion: 1,
      }),
    ).toThrow(/not newer/)
  })
})

describe('generateKeypair / sign — round trip', () => {
  it('produces a signature this module accepts', () => {
    const { publicKeyText, secretKey } = generateKeypair()
    const content = Buffer.from('round-trip test content\n')
    const signatureText = sign({ contentBytes: content, secretKey, trustedComment: 'round-trip' })
    expect(verify({ contentBytes: content, signatureText, publicKeyText })).toBe('round-trip')
  })

  it('refuses tampered content signed by a fresh keypair', () => {
    const { publicKeyText, secretKey } = generateKeypair()
    const content = Buffer.from('round-trip test content\n')
    const signatureText = sign({ contentBytes: content, secretKey, trustedComment: 'round-trip' })
    expect(() =>
      verify({ contentBytes: Buffer.from('different content\n'), signatureText, publicKeyText }),
    ).toThrow(/content signature/)
  })
})

describe('checkMonotonic', () => {
  it('accepts a newer version with an unchanged dataVersion', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: '1.2.0',
        installedVersion: '1.1.9',
        offeredDataVersion: 1,
        installedDataVersion: 1,
      }),
    ).not.toThrow()
  })

  it('accepts a newer version with an increased dataVersion', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: '2.0.0',
        installedVersion: '1.9.9',
        offeredDataVersion: 2,
        installedDataVersion: 1,
      }),
    ).not.toThrow()
  })

  it('tolerates a leading v on both versions', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: 'v1.0.1',
        installedVersion: 'v1.0.0',
        offeredDataVersion: 1,
        installedDataVersion: 1,
      }),
    ).not.toThrow()
  })

  it('refuses an equal version', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: '1.0.0',
        installedVersion: '1.0.0',
        offeredDataVersion: 1,
        installedDataVersion: 1,
      }),
    ).toThrow(/not newer/)
  })

  it('refuses an older version', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: '1.0.0',
        installedVersion: '1.1.0',
        offeredDataVersion: 1,
        installedDataVersion: 1,
      }),
    ).toThrow(/not newer/)
  })

  it('refuses a dataVersion regression even when the version is newer', () => {
    expect(() =>
      checkMonotonic({
        offeredVersion: '2.0.0',
        installedVersion: '1.0.0',
        offeredDataVersion: 0,
        installedDataVersion: 1,
      }),
    ).toThrow(/dataVersion/)
  })
})
