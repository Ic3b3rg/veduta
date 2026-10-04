import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { GithubMcpEgressProxy } from './github-mcp-egress.ts'

function connectRequest(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let text = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('relay response timed out')))
    socket.on('connect', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    )
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('ascii')))
    socket.once('end', () => resolve(text))
    socket.once('error', reject)
  })
}

describe('reviewed GitHub MCP API relay', () => {
  it('rejects CONNECT, unreviewed paths/methods and unauthenticated callers before upstream access', async () => {
    let calls = 0
    const relay = await GithubMcpEgressProxy.start('test-token', async () => {
      calls++
      return new Response('{}')
    })
    try {
      expect(await connectRequest(relay.port, 'example.com:443')).toContain('403 Forbidden')
      expect(await connectRequest(relay.port, 'api.github.com:443')).toContain('403 Forbidden')
      const cases: [string, string, string][] = [
        ['/api/v3/user', 'GET', 'wrong-token'],
        ['/api/uploads/file', 'POST', relay.credential],
        ['/api/v3/repos/example/repo', 'DELETE', relay.credential],
        ['//other.example/api/v3/user', 'GET', relay.credential],
      ]
      for (const [path, method, token] of cases) {
        expect(
          (
            await fetch(`http://127.0.0.1:${relay.port}${path}`, {
              method,
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(403)
      }
      expect(calls).toBe(0)
    } finally {
      await relay.close()
    }
  })

  it('maps REST and GraphQL to verified fixed-origin HTTPS without redirects or ambient headers', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const relay = await GithubMcpEgressProxy.start('test-token', async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) })
      return new Response('{"ok":true}', { status: 200 })
    })
    try {
      for (const path of [
        '/api/v3/repos/example/repo/contents/README.md?ref=abc',
        '/api/graphql',
      ]) {
        const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${relay.credential}`, cookie: 'private-cookie' },
          body: '{"query":"test"}',
        })
        expect(await response.json()).toEqual({ ok: true })
      }
      expect(requests.map((request) => request.url)).toEqual([
        'https://api.github.com/repos/example/repo/contents/README.md?ref=abc',
        'https://api.github.com/graphql',
      ])
      for (const { init } of requests) {
        expect(init?.redirect).toBe('error')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
        expect(new Headers(init?.headers).get('cookie')).toBeNull()
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      }
    } finally {
      await relay.close()
    }
  })

  it('limits concurrent upstream requests and aborts them when the MCP session stops', async () => {
    const signals: AbortSignal[] = []
    const relay = await GithubMcpEgressProxy.start('test-token', async (_input, init) => {
      const signal = init?.signal
      if (!signal) throw new Error('Missing upstream cancellation')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    })
    const requests = Array.from({ length: 4 }, () =>
      fetch(`http://127.0.0.1:${relay.port}/api/v3/user`, {
        headers: { authorization: `Bearer ${relay.credential}` },
      }).catch(() => undefined),
    )
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(4))
      expect(
        (
          await fetch(`http://127.0.0.1:${relay.port}/api/v3/user`, {
            headers: { authorization: `Bearer ${relay.credential}` },
          })
        ).status,
      ).toBe(429)
    } finally {
      await relay.close()
      await Promise.all(requests)
    }
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it.each([302, 200])('refuses a redirect or oversized upstream response (%s)', async (status) => {
    const relay = await GithubMcpEgressProxy.start(
      'test-token',
      async () =>
        new Response(status === 200 ? 'x'.repeat(1024 * 1024 + 1) : '', {
          status,
          headers: { location: 'https://other.example/' },
        }),
    )
    try {
      const response = await fetch(`http://127.0.0.1:${relay.port}/api/v3/user`, {
        headers: { authorization: `Bearer ${relay.credential}` },
      })
      expect(response.status).toBe(502)
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toBe('')
    } finally {
      await relay.close()
    }
  })
})
