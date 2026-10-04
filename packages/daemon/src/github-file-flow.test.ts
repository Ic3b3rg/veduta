import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayServerMessageSchema, type GatewayServerMessage } from '@veduta/protocol'
import { expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'
import { McpStdioClient } from './mcp-stdio-client.ts'

class Socket {
  sent: GatewayServerMessage[] = []
  private handler: ((raw: string) => void) | undefined
  send(raw: string) {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }
  on(event: string, handler: (raw: string) => void) {
    if (event === 'message') this.handler = handler
  }
  receive(frame: unknown) {
    this.handler?.(JSON.stringify(frame))
  }
}
const json = (value: unknown) => new Response(JSON.stringify(value))
const revision = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const content = 'Hello from the reviewed repository.\n'

it.each([
  ['default', 'Hello from the reviewed repository.'],
  ['tag', 'Hello from the reviewed repository.'],
  ['binary', 'Binary files cannot be summarized as text.'],
  ['large', 'The file exceeds the 32 KiB text read limit.'],
  ['missing', 'The requested path does not exist at this revision.'],
  ['missing_ref', 'missing or inaccessible'],
  ['restricted', 'not granted'],
  ['revoked', 'aborted'],
  ['integrity', 'did not match its pinned Git revision'],
  ['auth_expired', 'authorization expired'],
])(
  'handles the %s file-read outcome through Gateway Chat, reviewed MCP and source attribution',
  async (scenario, expected) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'veduta-github-file-'))
    process.env['VEDUTA_VAULT_KEY'] = 'github-file-fixture-key'
    const reads: unknown[][] = []
    const requests: string[] = []
    const requestedRef =
      scenario === 'tag'
        ? 'refs/tags/v1'
        : scenario === 'missing_ref'
          ? 'refs/tags/missing'
          : undefined
    const executable = join(dataDir, 'fixture-server')
    const schemas = Object.fromEntries(
      ['list-issues', 'get-file-contents'].map((name) => [
        name.replaceAll('-', '_'),
        JSON.parse(
          readFileSync(new URL(`./fixtures/github-${name}-v1.12.2.json`, import.meta.url), 'utf8'),
        ),
      ]),
    )
    writeFileSync(
      executable,
      `#!${process.execPath}
const name = process.argv.find(arg => arg.startsWith('--tools=')).slice(8)
if (!process.argv.includes('--read-only')) process.exit(2)
const schemas = ${JSON.stringify(schemas)}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result = request.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
    : request.method === 'tools/list' ? { tools: [{ name, inputSchema: schemas[name] }] }
    : { content: [{ type: 'text', text: 'Downloaded text' }, { type: 'resource', resource: ${JSON.stringify({ uri: 'repo://example/allowed/README.md', mimeType: scenario === 'binary' ? 'application/octet-stream' : 'text/plain', ...(scenario === 'binary' ? { blob: 'AAAB' } : { text: scenario === 'integrity' ? 'Different content' : content }) })} }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})`,
      { mode: 0o700 },
    )
    const server = buildServer({
      dataDir,
      serviceRequestComplete: async () =>
        JSON.stringify({
          status: 'resolved',
          spaceId: 'spc-health',
          operation: {
            service: 'github',
            action: 'read_files',
            owner: 'example',
            repo: 'allowed',
            path: 'README.md',
            ...(requestedRef ? { ref: requestedRef } : {}),
          },
        }),
      githubMcp: {
        fetchFn: async (input, init) => {
          const url = new URL(String(input))
          requests.push(url.pathname)
          if (url.pathname === '/user') return json({ login: 'example' })
          if (
            url.pathname ===
            `/repos/example/allowed/commits/${encodeURIComponent(requestedRef ?? 'HEAD')}`
          ) {
            expect(new Headers(init?.headers).get('accept')).toBe('application/vnd.github.sha')
            if (scenario === 'missing_ref') return new Response('', { status: 404 })
            if (scenario === 'auth_expired') return new Response('', { status: 401 })
            return new Response(revision)
          }
          if (url.pathname === `/repos/example/allowed/git/commits/${revision}`)
            return json({ sha: revision, tree: { sha: tree } })
          if (url.pathname === `/repos/example/allowed/git/trees/${tree}`) {
            if (scenario === 'revoked') {
              const grant = server.serviceConnections.snapshot().grants[0]!
              expect(
                (
                  await server.app.inject({
                    method: 'POST',
                    url: `/api/service-connections/grants/${grant.id}/disable`,
                    payload: {},
                  })
                ).statusCode,
              ).toBe(200)
            }
            return json({
              sha: tree,
              truncated: false,
              tree:
                scenario === 'missing'
                  ? []
                  : [
                      {
                        path: 'README.md',
                        mode: '100644',
                        type: 'blob',
                        sha: 'ab11d0c88e5dac19667566617b7c62ce54ad29ff',
                        size: scenario === 'large' ? 32769 : 36,
                      },
                    ],
            })
          }
          throw new Error(`Unexpected endpoint ${url.pathname}`)
        },
        install: async () => executable,
        createClient: (input) => {
          const client = new McpStdioClient(input)
          return {
            start: () => client.start(),
            stop: () => client.stop(),
            discoverTools: () => client.discoverTools(),
            listOpenIssues: async () => {
              throw new Error('Unrequested issues')
            },
            createIssue: async () => {
              throw new Error('Unrequested write')
            },
            readFile: (...args) => {
              reads.push(args.slice(0, 4))
              return client.readFile(...args)
            },
          }
        },
      },
    })
    try {
      await server.app.ready()
      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: `Leggi README.md nella repository example/allowed${requestedRef ? ` alla revisione ${requestedRef}` : ''}`,
        spaceId: 'spc-health',
        submissionId: randomUUID(),
      })
      await vi.waitFor(() => expect(server.serviceConnections.snapshot().attempts).toHaveLength(1))
      const attempt = server.serviceConnections.snapshot().attempts[0]!
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
            payload: { token: 'github_pat_read_files_fixture_token' },
          })
        ).statusCode,
      ).toBe(200)
      expect(requests).toEqual(['/user'])
      const verified = server.serviceConnections.attempt(attempt.id)!
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${attempt.id}/grant`,
            payload: {
              account: 'example',
              scopes: verified.verifiedScopes,
              ...(scenario === 'restricted'
                ? {
                    repositoryScopes: {
                      'spc-health': {
                        mode: 'selected',
                        repositories: [{ owner: 'example', name: 'another' }],
                      },
                    },
                  }
                : {}),
            },
          })
        ).statusCode,
      ).toBe(200)
      await vi.waitFor(() => expect(JSON.stringify(socket.sent)).toContain(expected), {
        timeout: 5000,
      })
      expect(reads).toEqual(
        ['default', 'tag', 'binary', 'integrity'].includes(scenario)
          ? [['example', 'allowed', 'README.md', revision]]
          : [],
      )
      if (scenario === 'restricted') expect(requests).toEqual(['/user'])
      const surfaces = JSON.stringify(server.store.listSurfaces('spc-health'))
      const createsSurface = ['default', 'tag', 'binary', 'large'].includes(scenario)
      if (createsSurface)
        expect(surfaces).toContain(`https://github.com/example/allowed/blob/${revision}/README.md`)
      else expect(surfaces).not.toContain('GitHub repository')
      expect(
        server.store
          .eventLog('spc-health')
          .some(
            (event) =>
              event.type === 'surface.create' && event.origin?.startsWith('untrusted:github'),
          ),
      ).toBe(createsSurface)
      if (scenario === 'auth_expired') {
        expect(server.serviceConnections.snapshot().connections[0]?.state).toBe('needs_reconnect')
        const before = requests.length
        socket.receive({
          type: 'chat.send',
          text: 'Riprova a leggere README.md in example/allowed',
          spaceId: 'spc-health',
          submissionId: randomUUID(),
        })
        await vi.waitFor(() =>
          expect(server.serviceConnections.snapshot().attempts).toHaveLength(2),
        )
        expect(requests).toHaveLength(before)
      }
    } finally {
      await server.app.close()
      delete process.env['VEDUTA_VAULT_KEY']
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)
