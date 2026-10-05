import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayServerMessageSchema,
  ServiceConnectionsSnapshotSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'
import { githubConnectionReview } from './github-mcp-service.ts'

const roots: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class Socket {
  sent: GatewayServerMessage[] = []
  private receiveFrame: ((raw: string) => void) | undefined
  send(raw: string) {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }
  on(event: string, handler: (raw: string) => void) {
    if (event === 'message') this.receiveFrame = handler
  }
  receive(frame: unknown) {
    this.receiveFrame?.(JSON.stringify(frame))
  }
}

it('keeps the Loopback bounded unread-mail request eligible for protected setup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'veduta-service-request-'))
  roots.push(root)
  process.env['VEDUTA_VAULT_KEY'] = 'service-request-fixture-key'
  const gmailFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Setup must not contact Gmail')
  })
  const server = buildServer({ dataDir: root, gmailFetch })
  try {
    await server.app.ready()
    const work = server.store.spacesEngine.createSpace({ name: 'Work' })
    const socket = new Socket()
    server.gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    socket.receive({
      type: 'chat.send',
      text: 'Find unread emails since 2026-09-30 in Work Space',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() =>
      expect(JSON.stringify(socket.sent)).toContain('Review Gmail access in Service connections'),
    )
    const snapshot = ServiceConnectionsSnapshotSchema.parse(
      (await server.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
    )
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.attempts[0]).toMatchObject({
      spaceId: work.id,
      state: 'reviewing',
      review: { service: 'gmail', actions: ['search_mailbox'] },
    })
    expect(gmailFetch).not.toHaveBeenCalled()
  } finally {
    await server.app.close()
  }
})

it('keeps an Italian GitHub clarification through reconnect and executes the resolved request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'veduta-service-request-'))
  roots.push(root)
  process.env['VEDUTA_VAULT_KEY'] = 'service-request-fixture-key'
  const calls: string[] = []
  const prompts: string[] = []
  const server = buildServer({
    dataDir: root,
    serviceRequestComplete: async (prompt) => {
      prompts.push(prompt)
      return JSON.stringify(
        prompt.includes('Voltarella')
          ? {
              status: 'resolved',
              spaceId: 'spc-health',
              operation: {
                service: 'github',
                action: 'list_issues',
                owner: 'example',
                repo: 'Voltarella',
              },
            }
          : { status: 'clarify', question: 'Quale repository di example devo leggere?' },
      )
    },
    githubMcp: {
      fetchFn: async () => new Response(JSON.stringify({ login: 'example' })),
      install: async () => '/fixture/github-mcp-server',
      createClient: () => ({
        start: async () => {},
        stop: async () => {},
        discoverTools: async () => ({
          name: 'list_issues',
          schemaSha256: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
        }),
        listOpenIssues: async (owner, repo) => {
          calls.push(`${owner}/${repo}`)
          return {
            text: '{"issues":[{"number":7,"title":"Conversational request works"}]}',
            schemaSha256: '',
          }
        },
        createIssue: async () => {
          throw new Error('Unexpected write')
        },
      }),
    },
  })
  try {
    await server.app.ready()
    const attempt = server.serviceConnections.createAttempt({
      submissionId: randomUUID(),
      turnId: 'cht-fixture',
      spaceId: 'spc-health',
      requestSummary: 'Read issues',
      review: githubConnectionReview('example', 'Voltarella'),
    })
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
          payload: { token: 'github_pat_service_request_fixture_12345' },
        })
      ).statusCode,
    ).toBe(200)
    const verified = server.serviceConnections.attempt(attempt.id)!
    server.serviceConnections.grant(attempt.id, verified.verifiedAccount!, verified.verifiedScopes!)
    const first = new Socket()
    server.gateway.connect(first)
    first.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    first.receive({
      type: 'chat.send',
      text: 'Mostrami le issue aperte di una repo di example',
      spaceId: 'spc-health',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(JSON.stringify(first.sent)).toContain('Quale repository'))
    expect(calls).toEqual([])
    const second = new Socket()
    server.gateway.connect(second)
    second.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    second.receive({
      type: 'chat.send',
      text: 'Voltarella, prova questa',
      spaceId: 'spc-health',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(calls).toEqual(['example/Voltarella']))
    await vi.waitFor(() =>
      expect(JSON.stringify(second.sent)).toContain('Conversational request works'),
    )
    expect(prompts.at(-1)).toContain('Mostrami le issue aperte di una repo di example')
    const surfaces = server.store.listSurfaces('spc-health')
    expect(JSON.stringify(surfaces)).toContain('Conversational request works')
  } finally {
    await server.app.close()
  }
})
