import { connect, createServer, type Server, type Socket } from 'node:net'

const MAX_HEADER_BYTES = 8192
const HOST = 'api.github.com'

/** A per-session CONNECT proxy; the MCP child can only reach the reviewed GitHub API host. */
export class GithubMcpEgressProxy {
  private readonly sockets = new Set<Socket>()
  private readonly server: Server
  private constructor(
    readonly port: number,
    server: Server,
  ) {
    this.server = server
    server.on('connection', (socket) => this.accept(socket))
  }

  static async start(): Promise<GithubMcpEgressProxy> {
    const server = createServer()
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
      throw new Error('GitHub MCP egress proxy did not bind a TCP port')
    }
    return new GithubMcpEgressProxy(address.port, server)
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setTimeout(10_000, () => socket.destroy())
    let header = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      if (header.length > MAX_HEADER_BYTES) {
        socket.destroy()
        return
      }
      const end = header.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const lines = header.subarray(0, end).toString('ascii').split('\r\n')
      if (
        lines[0] !== `CONNECT ${HOST}:443 HTTP/1.1` ||
        !lines.slice(1).some((line) => line.toLowerCase() === `host: ${HOST}:443`)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const upstream = connect({ host: HOST, port: 443, timeout: 10_000 })
      this.sockets.add(upstream)
      upstream.once('close', () => this.sockets.delete(upstream))
      upstream.once('connect', () => {
        socket.setTimeout(0)
        upstream.setTimeout(0)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const remainder = header.subarray(end + 4)
        if (remainder.length) upstream.write(remainder)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.once('close', () => socket.destroy())
    }
    socket.on('data', onData)
  }
}
