import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatTimelinePageSchema,
  GMAIL_READ_SCOPE,
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
  private handler: ((raw: Buffer | string) => void) | undefined
  send(value: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(value)))
  }
  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void): void {
    if (event === 'message') this.handler = handler
  }
  receive(frame: unknown): void {
    this.handler?.(JSON.stringify(frame))
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

function allFiles(root: string): string {
  return readdirSync(root)
    .map((name) => {
      const path = join(root, name)
      return statSync(path).isDirectory() ? allFiles(path) : readFileSync(path, 'utf8')
    })
    .join('\n')
}

describe('Chat to shared Gmail Service connection', () => {
  it('verifies identity without reading mail, grants one Space, resumes once, and survives restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-service-gmail-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'isolated-gmail-flow-test-key'
    const requests: string[] = []
    const gmailFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      requests.push(url.pathname)
      if (url.pathname === '/token')
        return json({
          access_token: 'access-private-token',
          refresh_token: 'refresh-private-token',
          scope: GMAIL_READ_SCOPE,
          expires_in: 3600,
        })
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'one@gmail.test' })
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'message1' }] })
      if (url.pathname.endsWith('/messages/message1'))
        return json({
          id: 'message1',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1790856000000',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Shop <shop@example.test>' },
              { name: 'Subject', value: 'October receipt' },
            ],
            body: { data: Buffer.from('PRIVATE-GMAIL-BODY').toString('base64url') },
          },
        })
      throw new Error(`Unexpected Gmail endpoint ${url.pathname}`)
    })
    const first = buildServer({
      dataDir: root,
      gmailFetch,
      now: () => new Date('2026-10-01T12:00:00Z'),
    })
    let workId: string
    let otherId: string
    try {
      await first.app.ready()
      workId = first.store.spacesEngine.createSpace({ name: 'Work' }).id
      otherId = first.store.spacesEngine.createSpace({ name: 'Other' }).id
      const socket = new Socket()
      first.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: first.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Find unread emails receipts from this week using one@gmail.test',
        spaceId: workId,
        submissionId: '5e0f9335-ed9f-4344-8c69-a2c7a66d7749',
      })
      await vi.waitFor(() =>
        expect(
          socket.sent.some(
            (frame) => frame.type === 'chat.timeline-entry' && frame.entry.kind === 'connection',
          ),
        ).toBe(true),
      )
      const attempt = first.serviceConnections.snapshot().attempts[0]!
      expect(attempt.state).toBe('reviewing')
      expect(attempt.review.accountHint).toBe('one@gmail.test')
      expect(requests).toEqual([])
      const begin = await first.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
        payload: {
          redirectOrigin: 'http://localhost:5173',
          name: 'Personal',
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
        },
      })
      expect(begin.statusCode).toBe(200)
      const authorizationUrl = (begin.json() as { authorizationUrl: string }).authorizationUrl
      const state = new URL(authorizationUrl).searchParams.get('state')!
      expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/app/connections',
      )
      const verified = await first.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { state, code: 'fixture-code' },
      })
      expect(verified.statusCode).toBe(200)
      const snapshot = ServiceConnectionsSnapshotSchema.parse(verified.json())
      expect(snapshot.attempts[0]).toMatchObject({
        state: 'ready',
        verifiedAccount: 'one@gmail.test',
        verifiedScopes: [GMAIL_READ_SCOPE],
      })
      expect(requests).toEqual(['/token', '/gmail/v1/users/me/profile'])
      expect(first.store.listSurfaces(workId).some((surface) => surface.title === 'Mailbox')).toBe(
        false,
      )
      const duplicate = await first.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { state, code: 'fixture-code' },
      })
      expect(duplicate.statusCode).toBe(200)
      expect(requests).toEqual(['/token', '/gmail/v1/users/me/profile'])
      const grant = await first.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/grant`,
        payload: { account: 'one@gmail.test', scopes: [GMAIL_READ_SCOPE] },
      })
      expect(grant.statusCode).toBe(200)
      const repeatedGrant = await first.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/grant`,
        payload: { account: 'one@gmail.test', scopes: [GMAIL_READ_SCOPE] },
      })
      expect(repeatedGrant.statusCode).toBe(200)
      expect(first.serviceConnections.snapshot().grants).toHaveLength(1)
      await vi.waitFor(() =>
        expect(
          first.store.listSurfaces(workId).filter((surface) => surface.title === 'Mailbox'),
        ).toHaveLength(1),
      )
      expect(
        SurfaceSchema.parse(first.store.listSurfaces(workId).find((s) => s.title === 'Mailbox')),
      ).toMatchObject({ spaceId: workId })
      expect(first.store.eventLog(workId).some((event) => event.type === 'surface.create')).toBe(
        true,
      )
      expect(first.store.listSurfaces(otherId).some((surface) => surface.title === 'Mailbox')).toBe(
        false,
      )
      expect(
        first.serviceConnections.eligible({
          spaceId: otherId,
          service: 'gmail',
          action: 'search_mailbox',
        }),
      ).toBeUndefined()
      await vi.waitFor(async () => {
        const timeline = ChatTimelinePageSchema.parse(
          (
            await first.app.inject({
              method: 'GET',
              url: `/api/chat/timeline?spaceId=${workId}`,
            })
          ).json(),
        )
        expect(timeline.entries.map((entry) => entry.kind)).toEqual([
          'user',
          'connection',
          'assistant',
        ])
      })
      expect(first.serviceConnections.snapshot().attempts[0]?.continuation).toBe('completed')
      const files = allFiles(root)
      expect(files).not.toContain('PRIVATE-GMAIL-BODY')
      expect(files).not.toContain('refresh-private-token')
      expect(files).not.toContain('fixture-secret')
    } finally {
      await first.app.close()
    }
    const restarted = buildServer({ dataDir: root, gmailFetch })
    try {
      const snapshot = restarted.serviceConnections.snapshot()
      expect(snapshot.attempts).toHaveLength(1)
      expect(snapshot.attempts[0]?.continuation).toBe('completed')
      expect(snapshot.grants).toHaveLength(1)
      expect(
        restarted.store.listSurfaces(workId!).some((surface) => surface.title === 'Mailbox'),
      ).toBe(true)
      expect(
        restarted.store.listSurfaces(otherId!).some((surface) => surface.title === 'Mailbox'),
      ).toBe(false)
    } finally {
      await restarted.app.close()
    }
  })
})
