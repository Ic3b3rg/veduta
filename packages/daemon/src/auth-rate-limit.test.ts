import { describe, expect, it } from 'vitest'
import { ProgressiveAuthLockout } from './auth-rate-limit.ts'

describe('ProgressiveAuthLockout', () => {
  it('allows initial attempts, then progressively locks out the key after failures', () => {
    let current = Date.parse('2026-07-03T12:00:00.000Z')
    const lockout = new ProgressiveAuthLockout({ now: () => new Date(current) })

    expect(lockout.check('ip:127.0.0.1').allowed).toBe(true)
    lockout.recordFailure('ip:127.0.0.1')
    lockout.recordFailure('ip:127.0.0.1')
    expect(lockout.check('ip:127.0.0.1').allowed).toBe(true)

    lockout.recordFailure('ip:127.0.0.1')
    const blocked = lockout.check('ip:127.0.0.1')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)

    current += blocked.retryAfterSeconds * 1000
    expect(lockout.check('ip:127.0.0.1').allowed).toBe(true)

    lockout.recordSuccess('ip:127.0.0.1')
    expect(lockout.check('ip:127.0.0.1').allowed).toBe(true)
  })
})
