import { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubMcpEgressProxy } from './github-mcp-egress.ts'
import { McpStdioClient } from './mcp-stdio-client.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeServer(
  options: {
    changedSchema?: boolean
    hangCall?: boolean
    write?: boolean
    shutdown?: 'sigterm' | 'sigkill'
  } = {},
): {
  root: string
  executable: string
} {
  const root = mkdtempSync(join(tmpdir(), 'veduta-mcp-client-'))
  roots.push(root)
  const executable = join(root, 'server')
  const schema = JSON.parse(
    readFileSync(
      new URL(
        options.write
          ? './fixtures/github-issue-write-v1.12.2.json'
          : './fixtures/github-list-issues-v1.12.2.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  if (options.changedSchema) schema.properties.perPage.maximum = 500
  const script = `#!${process.execPath}
const schema = ${JSON.stringify(schema)};
${options.shutdown ? 'setInterval(() => {}, 1000);' : ''}
${options.shutdown === 'sigkill' ? "process.on('SIGTERM', () => {});" : ''}
if (${options.write ? 'true' : 'false'} && (!process.argv.includes('--tools=issue_write') || process.argv.includes('--read-only'))) process.exit(2);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const frame = JSON.parse(line);
    if (frame.id === undefined) continue;
    let result;
    if (frame.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
    else if (frame.method === 'tools/list') result = { tools: [{ name: '${options.write ? 'issue_write' : 'list_issues'}', description: 'GitHub issues', inputSchema: schema }] };
    else if (frame.method === 'tools/call') {
      if (${options.hangCall ? 'true' : 'false'}) continue;
      result = { content: [{ type: 'text', text: JSON.stringify(frame.params.arguments) }], isError: false };
    } else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
  }
});
`
  writeFileSync(executable, script, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return { root, executable }
}

async function startClient(client: McpStdioClient): Promise<ChildProcess> {
  const children: ChildProcess[] = []
  const emit = ChildProcess.prototype.emit
  const observer = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === 'spawn') children.push(this)
    return emit.call(this, event, ...args)
  })
  try {
    await client.start()
    const child = children[0]
    if (!child) throw new Error('MCP child did not spawn')
    return child
  } finally {
    observer.mockRestore()
  }
}

describe('reviewed GitHub MCP stdio client', () => {
  it('finishes graceful shutdown on actual child exit without advancing the grace clock', async () => {
    const { root, executable } = fakeServer()
    const client = new McpStdioClient({ executable, cwd: root, token: 'test-token' })
    const child = await startClient(client)
    const exitListeners = child.listenerCount('exit')
    const exited = once(child, 'exit')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const kill = vi.spyOn(child, 'kill')
    let stopped = false
    const stopping = client.stop().then(() => {
      stopped = true
    })
    try {
      await exited
      await setImmediate()
      expect(child.exitCode).toBe(0)
      expect(stopped).toBe(true)
      expect(kill).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(child.listenerCount('exit')).toBe(exitListeners)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
      await stopping
      kill.mockRestore()
    }
  })

  it.each(['SIGTERM', 'SIGKILL'] as const)(
    'retains live-child grace periods when shutdown requires %s',
    async (signal) => {
      const { root, executable } = fakeServer({
        shutdown: signal === 'SIGTERM' ? 'sigterm' : 'sigkill',
      })
      const client = new McpStdioClient({ executable, cwd: root, token: 'test-token' })
      const child = await startClient(client)
      const exitListeners = child.listenerCount('exit')
      const exited = once(child, 'exit')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const kill = vi.spyOn(child, 'kill')
      let stopped = false
      const stopping = client.stop().then(() => {
        stopped = true
      })
      try {
        await setImmediate()
        await vi.advanceTimersByTimeAsync(499)
        expect(kill).not.toHaveBeenCalled()
        expect(stopped).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        if (signal === 'SIGKILL') {
          expect(kill.mock.calls).toEqual([['SIGTERM']])
          await vi.advanceTimersByTimeAsync(499)
          expect(kill.mock.calls).toEqual([['SIGTERM']])
          expect(stopped).toBe(false)
          await vi.advanceTimersByTimeAsync(1)
        }
        await exited
        await setImmediate()
        expect(child.signalCode).toBe(signal)
        expect(stopped).toBe(true)
        expect(kill.mock.calls).toEqual(
          signal === 'SIGTERM' ? [['SIGTERM']] : [['SIGTERM'], ['SIGKILL']],
        )
        expect(vi.getTimerCount()).toBe(0)
        expect(child.listenerCount('exit')).toBe(exitListeners)
      } finally {
        await vi.runAllTimersAsync()
        vi.useRealTimers()
        await stopping
        await exited
        kill.mockRestore()
      }
    },
  )

  it('closes authenticated network access immediately when stopping the child', async () => {
    const { root, executable } = fakeServer()
    const start = GithubMcpEgressProxy.start
    let relay: GithubMcpEgressProxy | undefined
    let upstreamCalls = 0
    const factory = vi.spyOn(GithubMcpEgressProxy, 'start').mockImplementation(async (token) => {
      relay = await start(token, async () => {
        upstreamCalls++
        return new Response('{}')
      })
      return relay
    })
    const client = new McpStdioClient({
      executable,
      cwd: root,
      token: 'test-token',
      launch: () => ({ command: executable, args: [] }),
    })
    try {
      await client.start()
      const url = `http://127.0.0.1:${relay!.port}/api/v3/user`
      const headers = { authorization: `Bearer ${relay!.credential}` }
      expect((await fetch(url, { headers })).status).toBe(200)
      const stopping = client.stop()
      await expect(fetch(url, { headers })).rejects.toThrow()
      await stopping
      expect(upstreamCalls).toBe(1)
    } finally {
      await client.stop()
      factory.mockRestore()
    }
  })

  it('selects only the reviewed issue_write tool and fixes method to create', async () => {
    const { root, executable } = fakeServer({ write: true })
    const client = new McpStdioClient({ executable, cwd: root, token: 'test-token', mode: 'write' })
    try {
      await client.start()
      const result = await client.createIssue('example', 'disposable', 'Test title', 'Test body')
      expect(JSON.parse(result.text)).toEqual({
        method: 'create',
        owner: 'example',
        repo: 'disposable',
        title: 'Test title',
        body: 'Test body',
      })
      expect(result.schemaSha256).toBe(
        createHash('sha256')
          .update(
            JSON.stringify(
              JSON.parse(
                readFileSync(
                  new URL('./fixtures/github-issue-write-v1.12.2.json', import.meta.url),
                  'utf8',
                ),
              ),
            ),
          )
          .digest('hex'),
      )
      await expect(client.listOpenIssues('example', 'disposable')).rejects.toThrow('not verified')
    } finally {
      await client.stop()
    }
  })

  it('negotiates and discovers without reading repository content, then fixes the read to one repository', async () => {
    const { root, executable } = fakeServer()
    const client = new McpStdioClient({ executable, cwd: root, token: 'test-token' })
    try {
      await client.start()
      const result = await client.listOpenIssues('example', 'disposable')
      expect(JSON.parse(result.text)).toEqual({
        owner: 'example',
        repo: 'disposable',
        state: 'OPEN',
        perPage: 10,
        fields: ['number', 'title', 'state', 'updated_at'],
      })
      const schema = JSON.parse(
        readFileSync(
          new URL('./fixtures/github-list-issues-v1.12.2.json', import.meta.url),
          'utf8',
        ),
      )
      expect(result.schemaSha256).toBe(
        createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
      )
      await expect(client.listOpenIssues('../other', 'disposable')).rejects.toThrow(
        'Repository scope is invalid',
      )
    } finally {
      await client.stop()
    }
  })

  it('rejects a changed required tool schema before any content call', async () => {
    const { root, executable } = fakeServer({ changedSchema: true })
    const client = new McpStdioClient({ executable, cwd: root, token: 'test-token' })
    await expect(client.start()).rejects.toMatchObject({ kind: 'schema_changed' })
  })

  it('cancels an in-flight call without claiming the remote effect was undone', async () => {
    const { root, executable } = fakeServer({ hangCall: true })
    const client = new McpStdioClient({ executable, cwd: root, token: 'test-token' })
    const controller = new AbortController()
    try {
      await client.start()
      const call = client.listOpenIssues('example', 'disposable', controller.signal)
      controller.abort()
      await expect(call).rejects.toMatchObject({ kind: 'cancelled' })
    } finally {
      await client.stop()
    }
  })
})
