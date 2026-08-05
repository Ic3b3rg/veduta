import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPorts } from './update-ports.ts'

/**
 * `defaultPorts().fetchBytes` (issue #46,
 * `docs/adr/0013-signed-self-update.md`): exercised against real
 * `node:http` servers rather than mocks. The behaviour under test —
 * redirect-host comparison ignoring port, idle/total deadlines racing real
 * socket timeout events, and destroying (not draining) a 3xx body — lives
 * in the interaction between `node:http` and this module's own bookkeeping,
 * not in anything a mock could stand in for.
 */

const ports = defaultPorts()

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  servers = []
})

/** Binds `server` on port 0 (an OS-assigned port — never a hardcoded one) and returns the assigned port. Registers the server for `afterEach` cleanup even if binding fails. */
function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a network address'))
        return
      }
      resolve(address.port)
    })
  })
}

describe('fetchBytes', () => {
  it('returns the bytes and status of a 200 response', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('hello')
    })
    const port = await listen(server)

    const result = await ports.fetchBytes(`http://127.0.0.1:${port}/`, { maxBytes: 1_000 })

    expect(result.status).toBe(200)
    expect(result.bytes.toString('utf8')).toBe('hello')
  })

  it('rejects a response larger than maxBytes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(100))
    })
    const port = await listen(server)

    await expect(ports.fetchBytes(`http://127.0.0.1:${port}/`, { maxBytes: 10 })).rejects.toThrow(
      /exceeded the maximum allowed 10 bytes/,
    )
  })

  it('follows a same-host redirect to a different port on 127.0.0.1', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200)
      res.end('target body')
    })
    const targetPort = await listen(target)

    const front = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` })
      res.end()
    })
    const frontPort = await listen(front)

    const result = await ports.fetchBytes(`http://127.0.0.1:${frontPort}/`, { maxBytes: 1_000 })

    expect(result.bytes.toString('utf8')).toBe('target body')
  })

  it('refuses a 127.0.0.1 -> [::1] redirect unless allowCrossHostRedirects is true', async (ctx) => {
    const target = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ipv6 body')
    })
    let targetPort: number
    try {
      targetPort = await listen(target, '::1')
    } catch {
      // No IPv6 loopback on this runner — skip rather than fail.
      ctx.skip()
      return
    }

    const front = createServer((_req, res) => {
      res.writeHead(302, { location: `http://[::1]:${targetPort}/` })
      res.end()
    })
    const frontPort = await listen(front)

    // Omits `allowCrossHostRedirects` entirely — the documented `?? false`
    // default is what this assertion exercises, not an explicit `false`.
    await expect(
      ports.fetchBytes(`http://127.0.0.1:${frontPort}/`, { maxBytes: 1_000 }),
    ).rejects.toThrow(/refusing a cross-host redirect: 127\.0\.0\.1 -> ::1/)

    const result = await ports.fetchBytes(`http://127.0.0.1:${frontPort}/`, {
      maxBytes: 1_000,
      allowCrossHostRedirects: true,
    })
    expect(result.bytes.toString('utf8')).toBe('ipv6 body')
  })

  it('rejects at the redirect depth cap for a server that redirects to itself forever', async () => {
    let port = 0
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/` })
      res.end()
    })
    port = await listen(server)

    await expect(
      ports.fetchBytes(`http://127.0.0.1:${port}/`, { maxBytes: 1_000 }),
    ).rejects.toThrow(/too many redirects/)
  })

  it('rejects on the idle timeout when the server writes headers and then never a body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      // Deliberately no res.end() and no further writes — a dead transfer.
    })
    const port = await listen(server)

    await expect(
      ports.fetchBytes(`http://127.0.0.1:${port}/`, { maxBytes: 1_000, idleTimeoutMs: 100 }),
    ).rejects.toThrow(/idle timeout/)
  })

  it('rejects on the total deadline when the server trickles a byte at a time forever', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => {
        res.write('x')
      }, 20)
      res.on('close', () => clearInterval(timer))
    })
    const port = await listen(server)

    await expect(
      ports.fetchBytes(`http://127.0.0.1:${port}/`, { maxBytes: 1_000_000, totalTimeoutMs: 150 }),
    ).rejects.toThrow(/total download deadline/)
  })

  it('rejects on the total deadline across a chain of redirects, not a fresh deadline per hop', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200)
      res.end('final')
    })
    const targetPort = await listen(target)

    const mid = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` })
        res.end()
      }, 80)
    })
    const midPort = await listen(mid)

    const front = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: `http://127.0.0.1:${midPort}/` })
        res.end()
      }, 80)
    })
    const frontPort = await listen(front)

    // Each hop's own delay (80ms) is comfortably under the 110ms budget, so
    // an implementation that re-armed the deadline per hop — instead of
    // sharing one `opts.deadline` across the whole recursive chain — would
    // let both hops complete and this would wrongly resolve. Only the *sum*
    // of the two hops' delays (160ms) exceeds the one shared 110ms budget.
    await expect(
      ports.fetchBytes(`http://127.0.0.1:${frontPort}/`, {
        maxBytes: 1_000,
        totalTimeoutMs: 110,
      }),
    ).rejects.toThrow(/exceeded the total download deadline/)
  })

  it('does not drain an endless 3xx body — the redirect resolves promptly', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200)
      res.end('resolved')
    })
    const targetPort = await listen(target)

    const front = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` })
      // A res.resume() implementation would either hang on this (the body
      // never ends) or accumulate it forever; res.destroy() must ignore it.
      const timer = setInterval(() => {
        res.write('y')
      }, 5)
      res.on('close', () => clearInterval(timer))
    })
    const frontPort = await listen(front)

    const start = Date.now()
    const result = await ports.fetchBytes(`http://127.0.0.1:${frontPort}/`, { maxBytes: 1_000 })
    const elapsed = Date.now() - start

    expect(result.bytes.toString('utf8')).toBe('resolved')
    expect(elapsed).toBeLessThan(2_000)
  })
})
