import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeErrorText } from './model-routing.ts'
import { defaultRedactor, installConsoleRedaction, SecretRedactor } from './redaction.ts'

describe('SecretRedactor', () => {
  describe('redactText — built-in patterns', () => {
    it('redacts an Anthropic-style key', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('key was sk-ant-api03-abcdefgh12345678 in the log')
      expect(text).toContain('[redacted]')
      expect(text).not.toContain('sk-ant')
    })

    it('redacts a generic OpenAI-style key', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('key was sk-abcdefgh12345678 in the log')
      expect(text).toContain('[redacted]')
      expect(text).not.toContain('sk-abcdefgh12345678')
    })

    it('redacts a Bearer token, case-insensitive', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('Authorization: bearer abcDEF123.456~789+/==')
      expect(text).toContain('[redacted]')
      expect(text).not.toContain('abcDEF123')
    })

    it('redacts a Veduta session token', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('token vdt_abcdefgh12345678 attached')
      expect(text).toContain('[redacted]')
      expect(text).not.toContain('vdt_abcdefgh12345678')
    })

    it('redacts an AWS access key', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('AKIAABCDEFGH12345678 was used')
      expect(text).toContain('[redacted]')
      expect(text).not.toContain('AKIAABCDEFGH12345678')
    })

    it('fully redacts an sk-ant- value, leaving no fragment of the key', () => {
      const redactor = new SecretRedactor()
      const text = redactor.redactText('leaked: sk-ant-api03-SUPERSECRET12345678 end')
      expect(text).not.toMatch(/sk-ant/)
      expect(text).not.toMatch(/SUPERSECRET/)
      // Must not degrade into a partial match like '[redacted]-ant-...'
      expect(text).toBe('leaked: [redacted] end')
    })
  })

  describe('redactText — registered literal values', () => {
    it('redacts a registered non-pattern secret', () => {
      const redactor = new SecretRedactor()
      const refreshToken = '1//0abcDEFghijklmnopqrstuvwxyz0123456789'
      redactor.register(refreshToken)
      const text = redactor.redactText(`refresh_token=${refreshToken} in payload`)
      expect(text).not.toContain(refreshToken)
      expect(text).toContain('[redacted]')
    })

    it('ignores very short values so it cannot mass-redact unrelated text', () => {
      const redactor = new SecretRedactor()
      redactor.register('ab')
      const text = redactor.redactText('abcdef contains ab twice: ab')
      expect(text).toBe('abcdef contains ab twice: ab')
    })

    it('matches longest-first so overlapping registered values leave no residue', () => {
      const redactor = new SecretRedactor()
      const short = 'abcd1234'
      const long = 'abcd1234efgh5678'
      redactor.register(short)
      redactor.register(long)
      const text = redactor.redactText(`secret=${long} end`)
      expect(text).not.toContain(short)
      expect(text).not.toContain(long)
      expect(text).not.toContain('efgh5678')
      expect(text).toBe('secret=[redacted] end')
    })
  })

  describe('redactDeep', () => {
    it('redacts leaf strings in nested objects/arrays, preserves structure and non-string types', () => {
      const redactor = new SecretRedactor()
      const secret = '1//0abcDEFghijklmnopqrstuvwxyz0123456789'
      redactor.register(secret)
      const input = {
        name: 'router',
        retries: 3,
        active: true,
        nothing: null,
        tokens: [secret, 'plain text', 42],
        nested: { auth: { token: secret }, count: 7 },
      }
      const result = redactor.redactDeep(input) as typeof input
      expect(result.name).toBe('router')
      expect(result.retries).toBe(3)
      expect(result.active).toBe(true)
      expect(result.nothing).toBeNull()
      expect(result.tokens[0]).toBe('[redacted]')
      expect(result.tokens[1]).toBe('plain text')
      expect(result.tokens[2]).toBe(42)
      expect(result.nested.auth.token).toBe('[redacted]')
      expect(result.nested.count).toBe(7)
    })

    it('does not throw on a cyclic object, rendering the cycle as [cycle]', () => {
      const redactor = new SecretRedactor()
      const cyclic: Record<string, unknown> = { name: 'cyclic' }
      cyclic['self'] = cyclic
      expect(() => redactor.redactDeep(cyclic)).not.toThrow()
      const result = redactor.redactDeep(cyclic) as Record<string, unknown>
      expect(result['name']).toBe('cyclic')
      expect(result['self']).toBe('[cycle]')
    })

    it('turns an Error into a redacted message string', () => {
      const redactor = new SecretRedactor()
      const result = redactor.redactDeep(new Error('token sk-ant-abcdefgh12345678 leaked'))
      expect(typeof result).toBe('string')
      expect(result).not.toContain('sk-ant-abcdefgh12345678')
    })
  })

  describe('redactError', () => {
    it('redacts the key inside an Error message', () => {
      const redactor = new SecretRedactor()
      const message = redactor.redactError(new Error('key sk-ant-XXXXXXXX leaked'))
      expect(typeof message).toBe('string')
      expect(message).not.toContain('sk-ant-XXXXXXXX')
      expect(message).toContain('[redacted]')
    })
  })
})

describe('installConsoleRedaction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts a registered secret and a built-in-pattern secret reaching console.error as a string, an Error, and a nested object, and never re-wraps on a second install', () => {
    const secret = 'registered-console-secret-abcdefghijklmnop'
    const patternSecret = 'sk-ant-api03-consoletest12345678'
    defaultRedactor.register(secret)
    // Spy first so `installConsoleRedaction` captures this spy as the
    // "original" it delegates to — the redacted output is only observable
    // through what actually reaches the underlying stream.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    installConsoleRedaction()
    const wrapped = console.error

    console.error(`string arg leaked ${secret} and ${patternSecret}`)
    console.error(new Error(`error arg leaked ${secret}`))
    console.error({ nested: { token: secret, other: patternSecret } })

    expect(spy).toHaveBeenCalledTimes(3)
    for (const call of spy.mock.calls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain(patternSecret)
    }

    // Idempotency: a second call must not wrap console.error a second time,
    // and the (single) wrapper must keep delegating to the same original.
    installConsoleRedaction()
    expect(console.error).toBe(wrapped)
    console.error('one more call after the second install')
    expect(spy).toHaveBeenCalledTimes(4)
  })
})

describe('sanitizeErrorText delegation to defaultRedactor', () => {
  it('redacts a value registered with defaultRedactor and still truncates to 300 chars', () => {
    // Secret straddles the 300-char boundary: if truncation ran BEFORE
    // redaction, only a fragment of the secret would remain in the
    // pre-redaction slice and the full-string pattern match would fail,
    // leaking that fragment. Redaction-then-truncate (the required order)
    // replaces the whole secret with '[redacted]' first, so no fragment
    // survives regardless of where the cut falls.
    const secret = 'registered-secret-value-abcdefghijklmnop-0123456789'
    defaultRedactor.register(secret)
    const leadIn = 'x'.repeat(280)
    const trailer = 'y'.repeat(50)
    const message = `${leadIn}${secret}${trailer}`
    const result = sanitizeErrorText(new Error(message))
    expect(result.length).toBeLessThanOrEqual(300)
    expect(result).not.toContain(secret)
    expect(result).not.toContain(secret.slice(0, 15))
  })
})
