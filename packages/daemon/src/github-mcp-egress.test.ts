import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { GithubMcpEgressProxy } from './github-mcp-egress.ts'

function request(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let text = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('proxy response timed out')))
    socket.on('connect', () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    )
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('ascii')))
    socket.once('end', () => resolve(text))
    socket.once('error', reject)
  })
}

describe('reviewed GitHub MCP egress proxy', () => {
  it('rejects an unreviewed destination before opening an upstream connection', async () => {
    const proxy = await GithubMcpEgressProxy.start()
    try {
      expect(await request(proxy.port, 'example.com:443')).toContain('403 Forbidden')
      expect(await request(proxy.port, 'api.github.com:80')).toContain('403 Forbidden')
    } finally {
      await proxy.close()
    }
  })
})
