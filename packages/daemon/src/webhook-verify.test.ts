import { describe, expect, it } from 'vitest'
import type { SecretResolver } from './model-routing.ts'
import { signBody, verifyWebhook, type VerifyInput } from './webhook-verify.ts'

const secrets: SecretResolver = {
  resolve: (ref) => (ref === 'secret://env/GOOD' ? 'shhh' : undefined),
}

const input = (overrides: Partial<VerifyInput> = {}): VerifyInput => ({
  rawBody: Buffer.from('{"a":1}'),
  headers: {},
  query: {},
  ...overrides,
})

describe('verifyWebhook hmac', () => {
  it('accepts a signature computed over the exact raw bytes', () => {
    const body = Buffer.from('{"a":1}')
    const result = verifyWebhook('hmac', 'secret://env/GOOD', secrets, {
      rawBody: body,
      headers: { 'x-veduta-signature': signBody('shhh', body) },
      query: {},
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects a valid signature over different bytes', () => {
    const result = verifyWebhook('hmac', 'secret://env/GOOD', secrets, {
      rawBody: Buffer.from('{"a":2}'),
      headers: { 'x-veduta-signature': signBody('shhh', Buffer.from('{"a":1}')) },
      query: {},
    })
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' })
  })

  it('rejects missing and malformed signatures', () => {
    expect(verifyWebhook('hmac', 'secret://env/GOOD', secrets, input())).toEqual({
      ok: false,
      reason: 'missing-signature',
    })
    expect(
      verifyWebhook('hmac', 'secret://env/GOOD', secrets, {
        ...input(),
        headers: { 'x-veduta-signature': 'md5=abc' },
      }),
    ).toEqual({ ok: false, reason: 'malformed-signature' })
  })

  it('fails closed when the secret does not resolve', () => {
    expect(verifyWebhook('hmac', 'secret://env/MISSING', secrets, input())).toEqual({
      ok: false,
      reason: 'secret-unresolvable',
    })
  })
})

describe('verifyWebhook tokens', () => {
  it('accepts a matching query token and rejects a wrong one', () => {
    expect(
      verifyWebhook('query-token', 'secret://env/GOOD', secrets, {
        ...input(),
        query: { token: 'shhh' },
      }),
    ).toEqual({ ok: true })
    expect(
      verifyWebhook('query-token', 'secret://env/GOOD', secrets, {
        ...input(),
        query: { token: 'nope' },
      }),
    ).toEqual({ ok: false, reason: 'query-token-mismatch' })
    expect(verifyWebhook('query-token', 'secret://env/GOOD', secrets, input())).toEqual({
      ok: false,
      reason: 'missing-query-token',
    })
  })

  it('verifies the Calendar channel token header', () => {
    expect(
      verifyWebhook('channel-token', 'secret://env/GOOD', secrets, {
        ...input(),
        headers: { 'x-goog-channel-token': 'shhh' },
      }),
    ).toEqual({ ok: true })
    expect(
      verifyWebhook('channel-token', 'secret://env/GOOD', secrets, {
        ...input(),
        headers: { 'x-goog-channel-token': 'longer-than-secret' },
      }),
    ).toEqual({ ok: false, reason: 'channel-token-mismatch' })
  })
})
