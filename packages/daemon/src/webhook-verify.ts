import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SecretResolver } from './model-routing.ts'

/**
 * Inbound verification for `/api/ingest/:source` (issue #12, Hermes
 * pattern): every source authenticates before anything is parsed or
 * queued, fail closed. Three strategies cover the v1 sources:
 *
 * - `hmac` — HMAC-SHA256 over the raw request bytes for generic webhooks.
 * - `query-token` — shared token in `?token=` (the Google Pub/Sub push
 *   pattern; OIDC JWT verification is issue #15 hardening debt).
 * - `channel-token` — `X-Goog-Channel-Token` for Calendar watch pushes.
 */
export type VerificationKind = 'hmac' | 'query-token' | 'channel-token'

export interface VerifyInput {
  rawBody: Buffer
  headers: Record<string, string | string[] | undefined>
  query: Record<string, unknown>
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export const SIGNATURE_HEADER = 'x-veduta-signature'
export const CHANNEL_TOKEN_HEADER = 'x-goog-channel-token'

export function verifyWebhook(
  kind: VerificationKind,
  secretRef: string,
  secrets: SecretResolver,
  input: VerifyInput,
): VerifyResult {
  const secret = secrets.resolve(secretRef)
  // A missing secret disables the source; it never opens it.
  if (secret === undefined) return { ok: false, reason: 'secret-unresolvable' }

  if (kind === 'hmac') return verifyHmac(secret, input)
  if (kind === 'query-token') {
    const token = input.query['token']
    return constantTimeMatch(typeof token === 'string' ? token : undefined, secret, 'query-token')
  }
  return constantTimeMatch(
    headerValue(input.headers, CHANNEL_TOKEN_HEADER),
    secret,
    'channel-token',
  )
}

export function signBody(secret: string, rawBody: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

function verifyHmac(secret: string, input: VerifyInput): VerifyResult {
  const header = headerValue(input.headers, SIGNATURE_HEADER)
  if (!header) return { ok: false, reason: 'missing-signature' }
  const match = /^sha256=([0-9a-f]{64})$/.exec(header)
  if (!match?.[1]) return { ok: false, reason: 'malformed-signature' }
  const presented = Buffer.from(match[1], 'hex')
  const expected = createHmac('sha256', secret).update(input.rawBody).digest()
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'signature-mismatch' }
  }
  return { ok: true }
}

function constantTimeMatch(
  presented: string | undefined,
  secret: string,
  what: string,
): VerifyResult {
  if (!presented) return { ok: false, reason: `missing-${what}` }
  const presentedBuffer = Buffer.from(presented)
  const secretBuffer = Buffer.from(secret)
  if (
    presentedBuffer.length !== secretBuffer.length ||
    !timingSafeEqual(presentedBuffer, secretBuffer)
  ) {
    return { ok: false, reason: `${what}-mismatch` }
  }
  return { ok: true }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}
