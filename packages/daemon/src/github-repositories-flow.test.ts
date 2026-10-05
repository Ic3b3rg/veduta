import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayServerMessageSchema, type GatewayServerMessage } from '@veduta/protocol'
import { expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'

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

it('discovers token-authorized repositories only on request and applies each Space restriction before publishing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'veduta-repository-discovery-'))
  process.env['VEDUTA_VAULT_KEY'] = 'repository-discovery-fixture-key'
  const calls: string[] = []
  const server = buildServer({
    dataDir,
    serviceRequestComplete: async (prompt) =>
      JSON.stringify({
        status: 'resolved',
        spaceId: JSON.parse(prompt.split('Focused scope: ')[1]!.split('\n')[0]!).spaceId,
        operation: { service: 'github', action: 'list_repositories', owner: 'example' },
      }),
    githubMcp: {
      fetchFn: async (input) => {
        const url = new URL(String(input))
        calls.push(url.pathname)
        if (url.pathname === '/user') return json({ login: 'example' })
        if (url.pathname === '/user/repos')
          return json(
            ['allowed', 'private-other'].map((name) => ({
              name,
              owner: { login: 'example' },
              private: true,
              default_branch: 'main',
            })),
          )
        throw new Error('Unexpected repository endpoint')
      },
      install: async () => '/fixture/github-mcp-server',
      createClient: ({ mode }) => ({
        start: async () => {},
        stop: async () => {},
        discoverTools: async () =>
          mode === 'files'
            ? {
                name: 'get_file_contents',
                schemaSha256: '5d7f569392e212ac9b5b8a985d986c69f317f3052f265626498aa3d0a4ec2bb8',
              }
            : {
                name: 'list_issues',
                schemaSha256: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
              },
        listOpenIssues: async () => {
          throw new Error('Unrequested issues')
        },
        createIssue: async () => {
          throw new Error('Unrequested write')
        },
      }),
    },
  })
  try {
    await server.app.ready()
    const other = server.store.spacesEngine.createSpace({ name: 'Repository review' })
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/service-connections/attempts',
      payload: { submissionId: randomUUID(), service: 'github' },
    })
    expect(created.statusCode).toBe(200)
    const attempt = server.serviceConnections.snapshot().attempts[0]!
    expect(attempt.review.actions).toEqual(['list_repositories', 'list_issues', 'read_files'])
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
          payload: { token: 'github_pat_repository_discovery_fixture' },
        })
      ).statusCode,
    ).toBe(200)
    expect(calls).toEqual(['/user'])
    const verified = server.serviceConnections.attempt(attempt.id)!
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/grant`,
          payload: {
            account: 'example',
            scopes: verified.verifiedScopes,
            spaceIds: ['spc-health', other.id],
            repositoryScopes: {
              'spc-health': {
                mode: 'selected',
                repositories: [{ owner: 'example', name: 'allowed' }],
              },
              [other.id]: { mode: 'authorized' },
            },
          },
        })
      ).statusCode,
    ).toBe(200)
    expect(calls).toEqual(['/user'])
    const first = new Socket()
    server.gateway.connect(first)
    first.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    first.receive({
      type: 'chat.send',
      text: 'Quali mie repo private di example puoi leggere?',
      spaceId: 'spc-health',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(JSON.stringify(first.sent)).toContain('example/allowed'))
    expect(JSON.stringify(first.sent)).not.toContain('private-other')
    expect(JSON.stringify(server.store.listSurfaces('spc-health'))).not.toContain('private-other')
    const second = new Socket()
    server.gateway.connect(second)
    second.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    second.receive({
      type: 'chat.send',
      text: 'Elenca le repository autorizzate di example',
      spaceId: other.id,
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(JSON.stringify(second.sent)).toContain('example/private-other'))
    expect(server.store.eventLog(other.id).some((event) => event.type === 'surface.create')).toBe(
      true,
    )
    const restored = await server.app.inject({ method: 'GET', url: '/api/service-connections' })
    expect(restored.json().grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spaceId: 'spc-health',
          repositoryScope: {
            mode: 'selected',
            repositories: [{ owner: 'example', name: 'allowed' }],
          },
        }),
      ]),
    )
  } finally {
    await server.app.close()
    delete process.env['VEDUTA_VAULT_KEY']
    rmSync(dataDir, { recursive: true, force: true })
  }
})
