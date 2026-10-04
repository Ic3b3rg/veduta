import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayServerMessageSchema, type GatewayServerMessage } from '@veduta/protocol'
import { expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'
import { GITHUB_MCP_SCHEMAS } from './github-mcp-review.ts'

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
const commit = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const body = 'Account-scoped file'

it.each([
  { action: 'list_repositories', sameLogin: false },
  { action: 'list_issues', sameLogin: false },
  { action: 'read_files', sameLogin: false },
  { action: 'list_repositories', sameLogin: true },
] as const)(
  'retains GitHub clarification for $action (same login: $sameLogin) and uses the selected credential',
  async ({ action, sameLogin }) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'veduta-github-account-'))
    process.env['VEDUTA_VAULT_KEY'] = 'github-account-fixture-key'
    const calls: { account: string; path: string }[] = []
    const identity = (token: string) => (token.includes('work') ? 'work' : 'personal')
    let selectedConnectionId = ''
    const server = buildServer({
      dataDir,
      serviceRequestComplete: async (prompt) =>
        JSON.stringify({
          status: 'resolved',
          spaceId: 'spc-health',
          operation: {
            service: 'github',
            action,
            ...(action === 'list_repositories' ? {} : { owner: 'example', repo: 'allowed' }),
            ...(action === 'read_files' ? { path: 'README.md' } : {}),
            ...(prompt.includes(
              `CURRENT user message: ${JSON.stringify(sameLogin ? selectedConnectionId : 'work')}`,
            )
              ? { account: sameLogin ? selectedConnectionId : 'work' }
              : {}),
          },
        }),
      githubMcp: {
        fetchFn: async (input, init) => {
          const path = new URL(String(input)).pathname
          const account = identity(new Headers(init?.headers).get('authorization')!)
          if (path === '/user') return json({ login: sameLogin ? 'same-login' : account })
          calls.push({ account, path })
          if (path === '/user/repos')
            return json([{ owner: { login: 'example' }, name: 'allowed', private: true }])
          if (path.endsWith('/commits/HEAD')) return new Response(commit)
          if (path.endsWith(`/git/commits/${commit}`))
            return json({ sha: commit, tree: { sha: tree } })
          if (path.endsWith(`/git/trees/${tree}`))
            return json({
              sha: tree,
              truncated: false,
              tree: [
                {
                  path: 'README.md',
                  type: 'blob',
                  mode: '100644',
                  size: Buffer.byteLength(body),
                  sha: createHash('sha1')
                    .update(`blob ${Buffer.byteLength(body)}\0${body}`)
                    .digest('hex'),
                },
              ],
            })
          throw new Error('Unexpected fixture request')
        },
        install: async () => '/fixture/github-mcp-server',
        createClient: ({ mode, token }) => ({
          start: async () => {},
          stop: async () => {},
          discoverTools: async () => ({
            name: GITHUB_MCP_SCHEMAS[mode].name,
            schemaSha256: GITHUB_MCP_SCHEMAS[mode].hash,
          }),
          listOpenIssues: async () => {
            calls.push({ account: identity(token), path: 'issues' })
            return {
              text: '{"issues":[{"number":1,"title":"Account-scoped issue"}]}',
              schemaSha256: '',
            }
          },
          readFile: async () => {
            calls.push({ account: identity(token), path: 'file' })
            return { kind: 'text', text: body }
          },
          createIssue: async () => {
            throw new Error('Unexpected write')
          },
        }),
      },
    })
    try {
      await server.app.ready()
      for (const account of ['personal', 'work']) {
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: '/api/service-connections/attempts',
              payload: { submissionId: randomUUID(), service: 'github' },
            })
          ).statusCode,
        ).toBe(200)
        const attempt = server.serviceConnections.snapshot().attempts.at(-1)!
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
              payload: { token: `github_pat_${account}_fixture_account_token_12345` },
            })
          ).statusCode,
        ).toBe(200)
        const verified = server.serviceConnections.attempt(attempt.id)!
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: `/api/service-connections/attempts/${attempt.id}/grant`,
              payload: {
                account: sameLogin ? 'same-login' : account,
                scopes: verified.verifiedScopes,
                spaceIds: ['spc-health'],
              },
            })
          ).statusCode,
        ).toBe(200)
      }
      selectedConnectionId = server.serviceConnections.snapshot().connections.at(-1)!.id
      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Controlla la repository example/allowed',
        spaceId: 'spc-health',
        submissionId: randomUUID(),
      })
      await vi.waitFor(() => expect(JSON.stringify(socket.sent)).toContain('Which GitHub account'))
      expect(calls).toEqual([])
      const reconnected = new Socket()
      server.gateway.connect(reconnected)
      reconnected.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      reconnected.receive({
        type: 'chat.send',
        text: sameLogin ? selectedConnectionId : 'work',
        spaceId: 'spc-health',
        submissionId: randomUUID(),
      })
      await vi.waitFor(() =>
        expect(reconnected.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true),
      )
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((call) => call.account === 'work')).toBe(true)
      expect(
        server.store.eventLog('spc-health').some((event) => event.type === 'surface.create'),
      ).toBe(true)
      expect(server.serviceConnections.snapshot().attempts).toHaveLength(2)
    } finally {
      await server.app.close()
      delete process.env['VEDUTA_VAULT_KEY']
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)
