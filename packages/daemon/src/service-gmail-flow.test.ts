import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatTimelinePageSchema,
  GMAIL_READ_SCOPE,
  GatewayServerMessageSchema,
  GmailConnectionsSnapshotSchema,
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
  it('preserves reconnect intent across restart and renews OAuth instead of testing the old token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-service-gmail-reconnect-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'isolated-gmail-reconnect-test-key'
    const requests: string[] = []
    const gmailFetch: typeof fetch = async (input) => {
      requests.push(String(input))
      return String(input).endsWith('/token')
        ? json({ access_token: 'access', refresh_token: 'refresh', scope: GMAIL_READ_SCOPE })
        : json({ emailAddress: 'saved@gmail.test' })
    }
    const first = buildServer({ dataDir: root, gmailFetch })
    let attemptId!: string
    let gmailId!: string
    const submissionId = '9709c37f-bb41-4cf7-9587-736351779b63'
    try {
      await first.app.inject({
        method: 'POST',
        url: '/api/gmail-connections/oauth-client',
        payload: { clientId: 'original-client', clientSecret: 'original-secret' },
      })
      const created = await first.app.inject({
        method: 'POST',
        url: '/api/gmail-connections',
        payload: { name: 'Saved Gmail' },
      })
      gmailId = GmailConnectionsSnapshotSchema.parse(created.json()).connections[0]!.id
      const initialBegin = await first.app.inject({
        method: 'POST',
        url: `/api/gmail-connections/${gmailId}/authorize`,
        payload: { redirectOrigin: 'http://localhost:5173' },
      })
      const initial = new URL(initialBegin.json().authorizationUrl)
      const completed = await first.app.inject({
        method: 'POST',
        url: `/api/gmail-connections/${gmailId}/complete`,
        payload: { code: 'first-code', state: initial.searchParams.get('state')! },
      })
      expect(completed.statusCode).toBe(200)
      requests.length = 0
      const reviewed = await first.app.inject({
        method: 'POST',
        url: '/api/service-connections/attempts',
        payload: {
          submissionId,
          service: 'gmail',
          connectionId: gmailId,
          renewAuthorization: true,
        },
      })
      expect(reviewed.statusCode).toBe(200)
      const attempt = ServiceConnectionsSnapshotSchema.parse(reviewed.json()).attempts[0]!
      attemptId = attempt.id
      expect(attempt).toMatchObject({
        connectionId: gmailId,
        renewAuthorization: true,
        state: 'reviewing',
      })
    } finally {
      await first.app.close()
    }
    const restarted = buildServer({ dataDir: root, gmailFetch })
    try {
      const reuseIdentity = await restarted.app.inject({
        method: 'POST',
        url: '/api/service-connections/attempts',
        payload: {
          submissionId,
          service: 'gmail',
          connectionId: gmailId,
          renewAuthorization: true,
        },
      })
      expect(reuseIdentity.statusCode).toBe(200)
      expect(ServiceConnectionsSnapshotSchema.parse(reuseIdentity.json()).attempts[0]?.id).toBe(
        attemptId,
      )
      const changedIntent = await restarted.app.inject({
        method: 'POST',
        url: '/api/service-connections/attempts',
        payload: { submissionId, service: 'gmail', connectionId: gmailId },
      })
      expect(changedIntent.statusCode).toBe(409)
      const bypass = await restarted.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attemptId}/use-connection`,
      })
      expect(bypass.statusCode).toBe(409)
      const begin = await restarted.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        payload: { gmailConnectionId: gmailId, redirectOrigin: 'http://localhost:5173' },
      })
      expect(begin.statusCode).toBe(200)
      const authorization = new URL(begin.json().authorizationUrl)
      expect(authorization.searchParams.get('redirect_uri')).toBe(
        'http://localhost:5173/app/connections',
      )
      expect(authorization.searchParams.get('client_id')).toBe('original-client')
      const gmail = GmailConnectionsSnapshotSchema.parse(
        (await restarted.app.inject({ method: 'GET', url: '/api/gmail-connections' })).json(),
      )
      expect(gmail.connections[0]?.id).toBe(gmailId)
      expect(restarted.serviceConnections.attempt(attemptId)?.state).toBe('authorizing')
      expect(restarted.serviceConnections.snapshot().grants).toEqual([])
      expect(requests).toEqual([])
      const denied = await restarted.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { state: authorization.searchParams.get('state')!, error: 'access_denied' },
      })
      expect(denied.statusCode).toBe(200)
      const retried = await restarted.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attemptId}/retry`,
      })
      expect(retried.statusCode).toBe(200)
      expect(ServiceConnectionsSnapshotSchema.parse(retried.json()).attempts[0]).toMatchObject({
        connectionId: gmailId,
        renewAuthorization: true,
        state: 'reviewing',
      })
      const next = await restarted.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        payload: { gmailConnectionId: gmailId, redirectOrigin: 'http://localhost:5173' },
      })
      expect(next.statusCode).toBe(200)
      expect(new URL(next.json().authorizationUrl).searchParams.get('state')?.split('.')[0]).toBe(
        gmailId,
      )
      expect(requests).toEqual([])
    } finally {
      await restarted.app.close()
    }
  })

  it('keeps the safe Google failure across devices and restart without granting or reading mail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-service-gmail-failure-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'isolated-gmail-failure-test-key'
    const gmailFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'PROVIDER-ECHO-SECRET' }),
          { status: 400 },
        ),
    )
    const first = buildServer({ dataDir: root, gmailFetch })
    let attemptId!: string
    try {
      await first.app.ready()
      const work = first.store.spacesEngine.createSpace({ name: 'Work' })
      const socket = new Socket()
      first.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: first.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Find unread emails receipts from this week using one@gmail.test',
        spaceId: work.id,
        submissionId: '6af37df4-dcc5-40e1-b66c-2e3c97e33f06',
      })
      await vi.waitFor(() => expect(first.serviceConnections.snapshot().attempts).toHaveLength(1))
      attemptId = first.serviceConnections.snapshot().attempts[0]!.id
      const begin = await first.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        payload: {
          redirectOrigin: 'http://localhost:5173',
          name: 'Personal',
          clientId: 'fixture-client',
          clientSecret: 'fixture-secret',
        },
      })
      expect(begin.statusCode).toBe(200)
      const state = new URL(begin.json().authorizationUrl).searchParams.get('state')!
      const failed = await first.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { state, code: 'fixture-code' },
      })
      expect(failed.statusCode).toBe(502)
      expect(failed.json().error).toMatch(/invalid_client.*full Client secret/)
      const observed = ServiceConnectionsSnapshotSchema.parse(
        (await first.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
      )
      expect(observed.attempts[0]).toMatchObject({
        state: 'failed',
        reason: failed.json().error,
      })
      expect(observed.grants).toEqual([])
      expect(observed.connections).toEqual([])
      expect(first.store.listSurfaces(work.id).some((surface) => surface.title === 'Mailbox')).toBe(
        false,
      )
      expect(gmailFetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://oauth2.googleapis.com/token',
      ])
      expect(allFiles(root)).not.toContain('PROVIDER-ECHO')
      expect(allFiles(root)).not.toContain('fixture-secret')
    } finally {
      await first.app.close()
    }
    const restarted = buildServer({ dataDir: root, gmailFetch })
    try {
      const restored = ServiceConnectionsSnapshotSchema.parse(
        (await restarted.app.inject({ method: 'GET', url: '/api/service-connections' })).json(),
      )
      expect(restored.attempts.find((attempt) => attempt.id === attemptId)).toMatchObject({
        state: 'failed',
        reason: expect.stringMatching(/invalid_client.*full Client secret/),
      })
      expect(restored.grants).toEqual([])
    } finally {
      await restarted.app.close()
    }
  })

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
