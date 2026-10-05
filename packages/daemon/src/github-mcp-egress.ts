import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

const MAX_BODY_BYTES = 1024 * 1024
const API_ORIGIN = 'https://api.github.com'

/** Fixed-origin API relay: the reviewed child needs no TLS or trust-service access. */
export class GithubMcpEgressProxy {
  readonly credential = randomBytes(32).toString('hex')
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Set<AbortController>()

  private constructor(
    readonly port: number,
    private readonly server: Server,
    private readonly token: string,
    private readonly fetchFn: typeof fetch,
  ) {
    server.on('request', (request, response) => void this.accept(request, response))
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'))
    server.on('upgrade', (_request, socket) => socket.destroy())
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
  }

  static async start(token: string, fetchFn: typeof fetch = fetch): Promise<GithubMcpEgressProxy> {
    const server = createServer({ maxHeaderSize: 8192 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('GitHub MCP API relay did not bind a TCP port')
    }
    return new GithubMcpEgressProxy(address.port, server, token, fetchFn)
  }

  async close(): Promise<void> {
    for (const controller of this.pending) controller.abort()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async accept(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? ''
    const target =
      path === '/api/graphql' ? '/graphql' : path.startsWith('/api/v3/') ? path.slice(7) : undefined
    const rawHeaderNames = request.rawHeaders
      .filter((_value, index) => index % 2 === 0)
      .map((name) => name.toLowerCase())
    if (
      request.headers.host !== `127.0.0.1:${this.port}` ||
      rawHeaderNames.filter((name) => name === 'host').length !== 1 ||
      rawHeaderNames.filter((name) => name === 'authorization').length !== 1 ||
      ![`Bearer ${this.credential}`, `token ${this.credential}`].includes(
        request.headers.authorization ?? '',
      ) ||
      !['GET', 'POST'].includes(request.method ?? '') ||
      !target
    ) {
      response.writeHead(403).end()
      return
    }
    const url = URL.parse(`${API_ORIGIN}${target}`)
    if (!url || url.origin !== API_ORIGIN || url.username || url.password) {
      response.writeHead(403).end()
      return
    }
    if (this.pending.size >= 4) {
      response.writeHead(429).end()
      return
    }
    const controller = new AbortController()
    this.pending.add(controller)
    const timer = setTimeout(() => {
      controller.abort()
      request.destroy()
      response.destroy()
    }, 10_000)
    const cancel = () => controller.abort()
    request.once('aborted', cancel)
    response.once('close', cancel)
    try {
      const body = await boundedBody(request)
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.token}`,
        'user-agent': 'veduta-github-mcp-v1.12.2',
      }
      for (const name of ['accept', 'content-type', 'x-github-api-version']) {
        const value = request.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      const upstream = await this.fetchFn(url, {
        method: request.method!,
        headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body.length ? { body: new Uint8Array(body) } : {}),
      })
      if (upstream.status >= 300 && upstream.status < 400) throw new Error('Redirect refused')
      const bytes = upstream.body ? await boundedBody(upstream.body) : Buffer.alloc(0)
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'content-length': bytes.length,
      })
      response.end(bytes)
    } catch {
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    } finally {
      clearTimeout(timer)
      request.off('aborted', cancel)
      response.off('close', cancel)
      this.pending.delete(controller)
      controller.abort()
    }
  }
}

async function boundedBody(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('GitHub API payload exceeds the bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
