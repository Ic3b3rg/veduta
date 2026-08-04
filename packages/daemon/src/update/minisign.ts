import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * minisign-compatible signature verification (docs/adr/0013-signed-self-update.md, Amendments): the
 * self-update chain (root key signs the signing key, signing key signs each
 * release) is verified by this module instead of shelling out to the
 * `minisign` CLI, so it is testable on every dev machine and in CI without
 * an apt/brew runtime dependency. The wire format matches minisign 0.12
 * exactly — proven by the golden fixtures in `fixtures/minisign/`, which
 * were generated with the real CLI and are verified byte-for-byte by
 * `minisign.test.ts`.
 *
 * Wire format (jedisct1/minisign, `PROTOCOL.md`):
 * - Public key file: 2 lines — an untrusted comment, then base64 of
 *   `signature_algorithm(2) || key_id(8, little-endian) || ed25519_public_key(32)`.
 *   `signature_algorithm` is always the literal bytes `'Ed'` in a public key.
 * - Signature file (`.minisig`): line 1 untrusted comment; line 2 base64 of
 *   `signature_algorithm(2) || key_id(8) || signature(64)`, where
 *   `signature_algorithm` is `'Ed'` for the legacy scheme (signature over the
 *   raw file bytes) or `'ED'` for the prehashed scheme minisign 0.12 uses by
 *   default (signature over BLAKE2b-512(file bytes)); line 3
 *   `trusted comment: <text>`; line 4 base64 of a *global signature* — an
 *   ed25519 signature over `signature(64) || trusted_comment_bytes`, which
 *   binds the trusted comment to the content signature so neither can be
 *   swapped independently.
 *
 * Only the prehashed `'ED'` scheme is accepted (`verify` rejects `'Ed'`
 * outright) — the legacy scheme is not part of this system's trust model.
 */

const PUBLIC_KEY_ALGORITHM = 'Ed'
const PREHASHED_SIGNATURE_ALGORITHM = 'ED'
const LEGACY_SIGNATURE_ALGORITHM = 'Ed'
const TRUSTED_COMMENT_PREFIX = 'trusted comment: '

/** SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410 OID 1.3.101.112, no parameters). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface MinisignPublicKey {
  keyId: Buffer
  publicKey: Buffer
}

/** Parses a minisign public key file (2 text lines). Throws on malformed input or an unsupported key algorithm. */
export function parsePublicKey(text: string): MinisignPublicKey {
  const lines = text.split('\n')
  const encoded = lines[1]
  if (encoded === undefined) throw new Error('malformed minisign public key: missing base64 line')
  const decoded = decodeBase64Line(encoded, 'public key')
  if (decoded.length !== 42)
    throw new Error('malformed minisign public key: expected 42 decoded bytes')
  const algorithm = decoded.subarray(0, 2).toString('latin1')
  if (algorithm !== PUBLIC_KEY_ALGORITHM)
    throw new Error(`unsupported minisign public key algorithm: ${algorithm}`)
  return {
    keyId: Buffer.from(decoded.subarray(2, 10)),
    publicKey: Buffer.from(decoded.subarray(10, 42)),
  }
}

export interface MinisignSignature {
  algorithm: 'Ed' | 'ED'
  keyId: Buffer
  signature: Buffer
  trustedComment: string
  globalSignature: Buffer
}

/** Parses a minisign `.minisig` file (4 text lines). Throws on malformed input; does not reject the legacy algorithm — that is `verify`'s job. */
export function parseSignature(text: string): MinisignSignature {
  const lines = text.split('\n')
  const encodedSig = lines[1]
  const trustedCommentLine = lines[2]
  const encodedGlobalSig = lines[3]
  if (encodedSig === undefined)
    throw new Error('malformed minisign signature: missing signature line')
  if (trustedCommentLine === undefined)
    throw new Error('malformed minisign signature: missing trusted comment line')
  if (encodedGlobalSig === undefined)
    throw new Error('malformed minisign signature: missing global signature line')
  if (!trustedCommentLine.startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new Error('malformed minisign signature: trusted comment line missing required prefix')
  }
  const decoded = decodeBase64Line(encodedSig, 'signature')
  if (decoded.length !== 74)
    throw new Error('malformed minisign signature: expected 74 decoded bytes')
  const algorithm = decoded.subarray(0, 2).toString('latin1')
  if (algorithm !== PREHASHED_SIGNATURE_ALGORITHM && algorithm !== LEGACY_SIGNATURE_ALGORITHM) {
    throw new Error(`unsupported minisign signature algorithm: ${algorithm}`)
  }
  const globalSignature = decodeBase64Line(encodedGlobalSig, 'global signature')
  if (globalSignature.length !== 64)
    throw new Error('malformed minisign signature: expected 64-byte global signature')
  return {
    algorithm,
    keyId: Buffer.from(decoded.subarray(2, 10)),
    signature: Buffer.from(decoded.subarray(10, 74)),
    trustedComment: trustedCommentLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature,
  }
}

function decodeBase64Line(line: string, what: string): Buffer {
  const decoded = Buffer.from(line, 'base64')
  // Buffer.from silently ignores invalid base64 characters rather than throwing; re-encoding
  // and comparing (modulo padding) is the standard way to catch garbage input.
  if (decoded.toString('base64').replace(/=+$/, '') !== line.trim().replace(/=+$/, '')) {
    throw new Error(`malformed minisign ${what}: not valid base64`)
  }
  return decoded
}

function importEd25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

function blake2b512(data: Buffer): Buffer {
  return createHash('blake2b512').update(data).digest()
}

export interface VerifyInput {
  contentBytes: Buffer
  signatureText: string
  publicKeyText: string
}

/**
 * Verifies a minisign signature over `contentBytes` against `publicKeyText`.
 * Returns the signature's trusted comment on success. Throws a plain,
 * distinct-per-cause `Error` on: key id mismatch, the legacy `'Ed'` algorithm
 * (rejected outright — this system only accepts prehashed `'ED'`), a bad
 * content signature, or a bad global signature (which also covers a
 * tampered trusted comment, since the global signature binds the two).
 */
export function verify(input: VerifyInput): string {
  const publicKey = parsePublicKey(input.publicKeyText)
  const signature = parseSignature(input.signatureText)
  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new Error('minisign verification failed: signature key id does not match public key id')
  }
  if (signature.algorithm === LEGACY_SIGNATURE_ALGORITHM) {
    throw new Error(
      'minisign verification failed: legacy (non-prehashed) signature algorithm is not accepted',
    )
  }
  const keyObject = importEd25519PublicKey(publicKey.publicKey)
  const hash = blake2b512(input.contentBytes)
  if (!edVerify(null, hash, keyObject, signature.signature)) {
    throw new Error('minisign verification failed: bad content signature')
  }
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, 'utf8'),
  ])
  if (!edVerify(null, globalMessage, keyObject, signature.globalSignature)) {
    throw new Error(
      'minisign verification failed: bad global signature (trusted comment may have been tampered with)',
    )
  }
  return signature.trustedComment
}

const SIGNING_KEY_CERT_TRUSTED_COMMENT = 'signing.pub'

export interface VerifyReleaseChainInput {
  releaseBytes: Buffer
  releaseSigText: string
  signingKeyText: string
  signingKeyRootSigText: string
  rootPublicKeyText: string
  expectedArtifactName: string
}

/**
 * Verifies the full trust chain for a release: the root key's certificate
 * over the signing key's public key text, then the signing key's signature
 * over the release metadata bytes. Also asserts that the release signature's
 * trusted comment equals `expectedArtifactName` — the name+contents binding
 * that closes the rename/downgrade hole (docs/adr/0013-signed-self-update.md, Amendments): a release
 * can only be offered under the exact artifact name it was signed for.
 * Throws a plain, distinct-per-cause `Error`; callers should not need to
 * inspect anything beyond the message.
 */
export function verifyReleaseChain(input: VerifyReleaseChainInput): void {
  let certComment: string
  try {
    certComment = verify({
      contentBytes: Buffer.from(input.signingKeyText, 'utf8'),
      signatureText: input.signingKeyRootSigText,
      publicKeyText: input.rootPublicKeyText,
    })
  } catch (cause) {
    throw new Error(`signing key certificate not rooted: ${messageOf(cause)}`)
  }
  if (certComment !== SIGNING_KEY_CERT_TRUSTED_COMMENT) {
    throw new Error(
      `signing key certificate not rooted: expected trusted comment '${SIGNING_KEY_CERT_TRUSTED_COMMENT}', got '${certComment}'`,
    )
  }

  let releaseComment: string
  try {
    releaseComment = verify({
      contentBytes: input.releaseBytes,
      signatureText: input.releaseSigText,
      publicKeyText: input.signingKeyText,
    })
  } catch (cause) {
    throw new Error(`release metadata signature invalid: ${messageOf(cause)}`)
  }

  if (releaseComment !== input.expectedArtifactName) {
    throw new Error(
      `release metadata signed for a different artifact: expected '${input.expectedArtifactName}', got '${releaseComment}'`,
    )
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export interface CheckMonotonicInput {
  offeredVersion: string
  installedVersion: string
  offeredDataVersion: number
  installedDataVersion: number
}

/**
 * Enforces the updater's independent monotonicity rule (docs/adr/0013-signed-self-update.md,
 * Amendments), regardless of what a compromised or stale feed offers: the offered
 * version must be strictly greater than the installed version, and the
 * offered dataVersion must be greater than or equal to the installed
 * dataVersion (a dataVersion regression would mean old code serving a
 * migrated store). Throws a plain `Error` naming the violated rule.
 */
export function checkMonotonic(input: CheckMonotonicInput): void {
  const offered = parseVersionTriple(input.offeredVersion)
  const installed = parseVersionTriple(input.installedVersion)
  if (compareVersionTriples(offered, installed) <= 0) {
    throw new Error(
      `offered version ${input.offeredVersion} is not newer than installed version ${input.installedVersion}`,
    )
  }
  if (input.offeredDataVersion < input.installedDataVersion) {
    throw new Error(
      `offered dataVersion ${input.offeredDataVersion} is older than installed dataVersion ${input.installedDataVersion}`,
    )
  }
}

type VersionTriple = readonly [number, number, number]

function parseVersionTriple(version: string): VersionTriple {
  const stripped = version.startsWith('v') ? version.slice(1) : version
  const parts = stripped.split('.')
  if (parts.length !== 3) throw new Error(`malformed version string: ${version}`)
  const triple = parts.map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`malformed version string: ${version}`)
    return Number.parseInt(part, 10)
  })
  return [triple[0] ?? 0, triple[1] ?? 0, triple[2] ?? 0]
}

function compareVersionTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// --- Test-only helpers below this line -------------------------------------
//
// Used by this module's own tests, other update-system test suites, and the
// e2e harness to build throwaway keypairs and minisign-format
// signatures without depending on the real `minisign` CLI being installed.
// The wire format is identical to what `verify` accepts and what real
// minisign produces — see `minisign.test.ts`'s round-trip and golden tests.

export interface MinisignSecretKey {
  privateKey: KeyObject
  keyId: Buffer
}

export interface GeneratedKeypair {
  publicKeyText: string
  secretKey: MinisignSecretKey
}

/** Generates a throwaway ed25519 keypair in minisign public-key-file format, with a random 8-byte key id. Test-only. */
export function generateKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const rawPublicKey = rawEd25519PublicKey(publicKey)
  const encoded = Buffer.concat([Buffer.from(PUBLIC_KEY_ALGORITHM, 'latin1'), keyId, rawPublicKey])
  const untrustedComment = `untrusted comment: minisign public key ${keyId.toString('hex').toUpperCase()}`
  const publicKeyText = `${untrustedComment}\n${encoded.toString('base64')}\n`
  return { publicKeyText, secretKey: { privateKey, keyId } }
}

function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - 32)
}

export interface SignInput {
  contentBytes: Buffer
  secretKey: MinisignSecretKey
  keyId?: Buffer
  trustedComment: string
}

/**
 * Produces a prehashed minisign `.minisig` text for `contentBytes`, signed
 * by `secretKey`. `keyId` overrides `secretKey.keyId` in the emitted
 * signature — used by adversarial tests that need a signature whose key id
 * does not match the key that produced it. The output is real minisign wire
 * format: both this module's `verify` and the real `minisign` CLI accept it
 * (proven by the round-trip test). Test-only.
 */
export function sign(input: SignInput): string {
  const keyId = input.keyId ?? input.secretKey.keyId
  const hash = blake2b512(input.contentBytes)
  const signature = edSign(null, hash, input.secretKey.privateKey)
  const globalMessage = Buffer.concat([signature, Buffer.from(input.trustedComment, 'utf8')])
  const globalSignature = edSign(null, globalMessage, input.secretKey.privateKey)
  const encoded = Buffer.concat([
    Buffer.from(PREHASHED_SIGNATURE_ALGORITHM, 'latin1'),
    keyId,
    signature,
  ])
  return [
    'untrusted comment: signature from minisign secret key',
    encoded.toString('base64'),
    `${TRUSTED_COMMENT_PREFIX}${input.trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n')
}
