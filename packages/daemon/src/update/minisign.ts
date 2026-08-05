import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { compareVersions } from '../version.ts'

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
  /**
   * The manifest's `signingKey.keyId` (`packages/protocol/src/update.ts`,
   * `SigningKeyCertSchema`) — minisign's own key-id text convention: hex of
   * the wire-format key id bytes in reverse order (`deploy/release.sh`'s
   * `extract_key_id` pulls this straight out of a real minisign pubkey
   * file's "untrusted comment: minisign public key <HEX>" line, which
   * minisign itself renders byte-reversed relative to the little-endian
   * `key_id` field it embeds — this module's own fixtures confirm the
   * reversal: `signing.pub`'s file bytes decode to `dd2a...1c3b`, and its
   * comment reads `3B1C...2ADD`). When given, checked against the key id
   * actually embedded in `signingKeyText`, so a feed cannot advertise a
   * certified key under any id it likes; that field would otherwise carry
   * no enforceable meaning. Optional so existing callers keep compiling —
   * every caller should pass it once available.
   */
  expectedSigningKeyId?: string
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
/**
 * The key id of a minisign public key in minisign's own text convention:
 * uppercase hex of the embedded `key_id` bytes in reverse order, exactly as
 * `minisign -G` renders it in the "untrusted comment: minisign public key
 * <HEX>" line and as `deploy/release.sh`'s `extract_key_id` reads it back out.
 * This is the form a manifest's `signingKey.keyId` carries
 * (`packages/protocol/src/update.ts`), so anything that builds or checks that
 * field goes through here rather than re-deriving the reversal.
 */
export function publicKeyIdText(publicKeyText: string): string {
  return Buffer.from(parsePublicKey(publicKeyText).keyId).reverse().toString('hex').toUpperCase()
}

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

  if (input.expectedSigningKeyId !== undefined) {
    const actualKeyId = publicKeyIdText(input.signingKeyText)
    const expectedKeyId = input.expectedSigningKeyId.toUpperCase()
    if (actualKeyId !== expectedKeyId) {
      throw new Error(
        `signing key id mismatch: manifest advertised '${input.expectedSigningKeyId}', the certified key's actual id is '${actualKeyId}'`,
      )
    }
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
 * A stricter gate than `compareVersions` (../version.ts) applies on its own:
 * exactly `v?<digits>.<digits>.<digits>`, no sign, no empty component, no
 * exponent or other numeric-string trivia `Number()` would tolerate. Applied
 * before every `checkMonotonic` comparison rather than trusting
 * `compareVersions` to reject the same inputs — `compareVersions`'s contract
 * is to compare feed version tags, and its tolerance is free to widen for
 * that purpose (e.g. for the in-tree dev placeholder) without silently
 * loosening this security gate too.
 */
const STRICT_VERSION_TRIPLE = /^v?\d+\.\d+\.\d+$/

function assertStrictVersionTriple(version: string): void {
  if (!STRICT_VERSION_TRIPLE.test(version)) {
    throw new Error(`malformed version string: ${version}`)
  }
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
  assertStrictVersionTriple(input.offeredVersion)
  assertStrictVersionTriple(input.installedVersion)
  if (compareVersions(input.offeredVersion, input.installedVersion) <= 0) {
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
  // Real minisign renders the key id in its untrusted comment byte-reversed
  // relative to the little-endian bytes it embeds in the file (see
  // `verifyReleaseChain`'s `expectedSigningKeyId` doc comment above) —
  // matched here even though this comment line is cosmetic and never parsed
  // by `parsePublicKey`, so a generated fixture's displayed id means what a
  // real minisign-generated one would.
  const displayKeyId = Buffer.from(keyId).reverse().toString('hex').toUpperCase()
  const untrustedComment = `untrusted comment: minisign public key ${displayKeyId}`
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
