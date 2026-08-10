import { describe, expect, it } from 'vitest'
import { ModelConnectionError, connectionErrorFrom } from './model-connection-adapter.ts'
import { defaultRedactor } from './redaction.ts'

// Deliberately not shaped like a known secret pattern (`sk-...`, `Bearer ...`,
// `vdt_...`, `AKIA...`): this test proves the registered-value redaction
// path, not `sanitizeErrorText`'s built-in shape patterns, catches the leak.
const DISTINCTIVE_SECRET = 'zzz-adapter-distinctive-marker-135790'

describe('connectionErrorFrom', () => {
  it('redacts a registered secret out of the message', () => {
    defaultRedactor.register(DISTINCTIVE_SECRET)
    const error = connectionErrorFrom(new Error(`upstream rejected ${DISTINCTIVE_SECRET}`))
    expect(error.message).not.toContain(DISTINCTIVE_SECRET)
    expect(error.message).toContain('[redacted]')
  })

  it('maps an AbortError onto unreachable and an unknown Error onto internal', () => {
    const aborted = connectionErrorFrom(new DOMException('The operation was aborted', 'AbortError'))
    expect(aborted.code).toBe('unreachable')

    const timedOut = connectionErrorFrom(
      new DOMException('The operation timed out', 'TimeoutError'),
    )
    expect(timedOut.code).toBe('unreachable')

    const fetchFailed = connectionErrorFrom(new TypeError('fetch failed'))
    expect(fetchFailed.code).toBe('unreachable')

    const unknown = connectionErrorFrom(new Error('something else went wrong'))
    expect(unknown.code).toBe('internal')
  })

  it('sanitizes an existing ModelConnectionError message', () => {
    defaultRedactor.register(DISTINCTIVE_SECRET)
    const original = new ModelConnectionError(
      'unauthorized',
      `the key was rejected: ${DISTINCTIVE_SECRET}`,
    )

    const result = connectionErrorFrom(original)

    expect(result).not.toBe(original)
    expect(result.code).toBe('unauthorized')
    expect(result.message).not.toContain(DISTINCTIVE_SECRET)
    expect(result.message).toContain('[redacted]')
  })
})
