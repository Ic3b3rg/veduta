import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatTimelinePageSchema,
  GatewayServerMessageSchema,
  ServiceConnectionsSnapshotSchema,
  SurfaceSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'

const roots: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class Socket {
  sent: GatewayServerMessage[] = []
  private onMessage: ((raw: Buffer | string) => void) | undefined
  send(value: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(value)))
  }
  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void): void {
    if (event === 'message') this.onMessage = handler
  }
  receive(frame: unknown): void {
    this.onMessage?.(JSON.stringify(frame))
  }
}

describe('Chat to reviewed GitHub MCP connection', () => {
  it('uses the shared connection flow and a separate L1 decision for an exact issue write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-service-write-route-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'isolated-service-write-test-key'
    const activity: string[] = []
    const server = buildServer({
      dataDir: root,
      githubMcp: {
        fetchFn: async (input) => {
          if (String(input).endsWith('/user'))
            return new Response(JSON.stringify({ login: 'reviewed-user' }), { status: 200 })
          expect(String(input)).toBe('https://api.github.com/repos/example/disposable/issues/44')
          return new Response(
            JSON.stringify({ number: 44, title: 'Test title', body: 'Test body' }),
            {
              status: 200,
            },
          )
        },
        install: async () => '/reviewed/github-mcp-server',
        createClient: ({ mode }) => ({
          start: async () => {},
          discoverTools: async () => ({
            name: mode === 'write' ? 'issue_write' : 'list_issues',
            schemaSha256: '97fade9d761e39e29714162058cbcc5a484d65372be703889dd86f9d062c811b',
          }),
          listOpenIssues: async () => {
            throw new Error('Unexpected GitHub issue read')
          },
          createIssue: async (owner, repo, title, body) => {
            activity.push(`write:${owner}/${repo}:${title}:${body}`)
            return {
              text: JSON.stringify({ number: 44 }),
              schemaSha256: '97fade9d761e39e29714162058cbcc5a484d65372be703889dd86f9d062c811b',
            }
          },
          stop: async () => {},
        }),
      },
    })
    try {
      await server.app.ready()
      const work = server.store.spacesEngine.createSpace({ name: 'Work' })
      const other = server.store.spacesEngine.createSpace({ name: 'Other' })
      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Create a GitHub issue in example/disposable titled "Test title" with body "Test body"',
        spaceId: work.id,
        submissionId: 'b038dcee-5166-428a-a982-f8b818ab74a4',
      })
      await vi.waitFor(() => {
        expect(
          socket.sent.some(
            (frame) => frame.type === 'chat.timeline-entry' && frame.entry.kind === 'connection',
          ),
        ).toBe(true)
      })
      const attempt = ServiceConnectionsSnapshotSchema.parse(
        (await server.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
      ).attempts[0]!
      expect(attempt.review.actions).toEqual(['issue_write'])
      expect(activity).toEqual([])
      const verified = await server.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
        payload: { token: 'github_pat_' + 'x'.repeat(30) },
      })
      expect(verified.statusCode).toBe(200)
      const granted = await server.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/grant`,
        payload: { account: 'reviewed-user', scopes: attempt.review.scopes },
      })
      expect(granted.statusCode).toBe(200)
      await vi.waitFor(() =>
        expect(socket.sent.some((frame) => frame.type === 'approval.card')).toBe(true),
      )
      const card = socket.sent.find(
        (frame): frame is Extract<GatewayServerMessage, { type: 'approval.card' }> =>
          frame.type === 'approval.card',
      )!.card
      expect(card.level).toBe('L1')
      expect(JSON.stringify(card)).toContain('Test title')
      expect(JSON.stringify(card)).toContain('Test body')
      expect(activity).toEqual([])
      expect(
        server.store.listSurfaces(work.id).some((surface) => surface.title === 'GitHub issue #44'),
      ).toBe(false)
      const approved = await server.app.inject({
        method: 'POST',
        url: `/api/pending-decisions/${encodeURIComponent(`approval:${card.id}`)}/resolve`,
        payload: { resolution: 'approve' },
      })
      expect(approved.statusCode).toBe(200)
      await vi.waitFor(() =>
        expect(activity).toEqual(['write:example/disposable:Test title:Test body']),
      )
      const surface = server.store
        .listSurfaces(work.id)
        .find((item) => item.title === 'GitHub issue #44')!
      expect(SurfaceSchema.parse(surface).spaceId).toBe(work.id)
      expect(JSON.stringify(surface.tree)).toContain(
        'https://github.com/example/disposable/issues/44',
      )
      expect(
        server.store.eventLog(work.id).some((event) => event.type === 'github.issue.created'),
      ).toBe(true)
      expect(
        server.store.listSurfaces(other.id).some((item) => item.title === 'GitHub issue #44'),
      ).toBe(false)
    } finally {
      await server.app.close()
    }
  })

  it.each(['focused', 'global'] as const)(
    'pauses a %s request before content, then produces one Space Surface and Event after grant',
    async (scope) => {
      const root = mkdtempSync(join(tmpdir(), 'veduta-service-route-'))
      roots.push(root)
      process.env['VEDUTA_VAULT_KEY'] = 'isolated-service-flow-test-key'
      const activity: string[] = []
      const server = buildServer({
        dataDir: root,
        githubMcp: {
          fetchFn: async (input) => {
            expect(String(input)).toBe('https://api.github.com/user')
            activity.push('identity')
            return new Response(JSON.stringify({ login: 'reviewed-user' }), { status: 200 })
          },
          install: async () => {
            activity.push('artifact')
            return '/reviewed/github-mcp-server'
          },
          createClient: () => ({
            start: async () => {
              activity.push('start')
            },
            discoverTools: async () => {
              activity.push('discover')
              return {
                name: 'list_issues',
                schemaSha256: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
              }
            },
            listOpenIssues: async (owner, repo) => {
              activity.push(`read:${owner}/${repo}`)
              return {
                text: JSON.stringify({ issues: [{ number: 12, title: 'Disposable issue' }] }),
                schemaSha256: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
              }
            },
            createIssue: async () => {
              throw new Error('Unexpected GitHub issue write')
            },
            stop: async () => {
              activity.push('stop')
            },
          }),
        },
      })
      try {
        await server.app.ready()
        const work = server.store.spacesEngine.createSpace({ name: 'Work' })
        const other = server.store.spacesEngine.createSpace({ name: 'Other' })
        const socket = new Socket()
        server.gateway.connect(socket)
        socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
        socket.receive({
          type: 'chat.send',
          text:
            scope === 'global'
              ? 'List open issues in example/disposable in Work Space'
              : 'List open issues in example/disposable',
          ...(scope === 'focused' ? { spaceId: work.id } : {}),
          submissionId: '4bdf604d-4046-4c25-b03e-12803c2ff4a1',
        })
        await vi.waitFor(() => {
          expect(
            socket.sent.some(
              (frame) => frame.type === 'chat.timeline-entry' && frame.entry.kind === 'connection',
            ),
          ).toBe(true)
        })
        let snapshot = ServiceConnectionsSnapshotSchema.parse(
          (await server.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
        )
        expect(snapshot.attempts).toHaveLength(1)
        const attempt = snapshot.attempts[0]!
        expect(attempt.state).toBe('reviewing')
        expect(activity).toEqual([])
        expect(
          server.store.listSurfaces(work.id).filter((surface) => surface.title === 'GitHub issues'),
        ).toHaveLength(0)

        const verified = await server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
          payload: { token: 'github_pat_' + 'x'.repeat(30) },
        })
        expect(verified.statusCode).toBe(200)
        snapshot = ServiceConnectionsSnapshotSchema.parse(verified.json())
        expect(snapshot.attempts[0]).toMatchObject({
          state: 'ready',
          verifiedAccount: 'reviewed-user',
        })
        expect(activity).not.toContain('read:example/disposable')
        expect(
          server.store.listSurfaces(work.id).filter((surface) => surface.title === 'GitHub issues'),
        ).toHaveLength(0)

        const granted = await server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/grant`,
          payload: {
            account: 'reviewed-user',
            scopes: attempt.review.scopes,
          },
        })
        expect(granted.statusCode).toBe(200)
        await vi.waitFor(
          () =>
            expect(activity.filter((item) => item === 'read:example/disposable')).toHaveLength(1),
          { timeout: 5000 },
        )
        await vi.waitFor(() => {
          expect(
            server.store
              .listSurfaces(work.id)
              .filter((surface) => surface.title === 'GitHub issues'),
          ).toHaveLength(1)
        })
        const surface = server.store
          .listSurfaces(work.id)
          .find((item) => item.title === 'GitHub issues')!
        expect(SurfaceSchema.parse(surface).spaceId).toBe(work.id)
        expect(JSON.stringify(surface.tree)).toContain('Disposable issue')
        expect(
          server.store.eventLog(work.id).some((event) => event.type === 'surface.create'),
        ).toBe(true)
        expect(
          server.store.listSurfaces(other.id).some((item) => item.title === 'GitHub issues'),
        ).toBe(false)
        let page: ReturnType<typeof ChatTimelinePageSchema.parse> | undefined
        await vi.waitFor(async () => {
          page = ChatTimelinePageSchema.parse(
            (
              await server.app.inject({
                method: 'GET',
                url:
                  scope === 'focused'
                    ? `/api/chat/timeline?spaceId=${work.id}`
                    : '/api/chat/timeline',
              })
            ).json(),
          )
          expect(page.entries.map((entry) => entry.kind)).toEqual([
            'user',
            'connection',
            'assistant',
          ])
        })
        expect(page).toBeDefined()
        expect(page!.entries[0]).toMatchObject({ turnState: 'completed' })
        expect(page!.entries.at(-1)?.message.text).toContain('open issues')
        expect(
          ServiceConnectionsSnapshotSchema.parse(
            (await server.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
          ).attempts[0]?.continuation,
        ).toBe('completed')
      } finally {
        await server.app.close()
      }
    },
  )
})
