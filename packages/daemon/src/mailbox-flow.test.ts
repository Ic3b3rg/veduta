import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayServerMessageSchema,
  GmailConnectionsSnapshotSchema,
  GMAIL_READ_SCOPE,
  SurfaceSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'

class Socket {
  sent: GatewayServerMessage[] = []
  private receiveFrame: ((raw: Buffer | string) => void) | undefined

  send(raw: string) {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }

  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void) {
    if (event === 'message') this.receiveFrame = handler
  }

  receive(frame: unknown) {
    this.receiveFrame?.(JSON.stringify(frame))
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const roots: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-mailbox-flow-'))
  roots.push(dir)
  process.env['VEDUTA_VAULT_KEY'] = 'mailbox-flow-test-vault-key'
  return dir
}

function allFileContents(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? allFileContents(path) : readFileSync(path, 'utf8')
    })
    .join('\n')
}

async function connectedAccount(
  app: ReturnType<typeof buildServer>['app'],
  name: string,
  code: string,
) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/gmail-connections',
    payload: { name, clientId: 'fixture-client', clientSecret: 'fixture-secret' },
  })
  expect(created.statusCode).toBe(200)
  const id = GmailConnectionsSnapshotSchema.parse(created.json()).connections.at(-1)!.id
  const begin = await app.inject({
    method: 'POST',
    url: `/api/gmail-connections/${id}/authorize`,
    payload: { redirectOrigin: 'http://localhost:5173' },
  })
  const state = new URL(
    (begin.json() as { authorizationUrl: string }).authorizationUrl,
  ).searchParams.get('state')!
  const completed = await app.inject({
    method: 'POST',
    url: `/api/gmail-connections/${id}/complete`,
    payload: { code, state },
  })
  expect(completed.statusCode).toBe(200)
  return id
}

describe('focused Mailbox Chat with Gmail', () => {
  it('loads both Skills, asks before ambiguous access, preserves unread state, and persists only summaries', async () => {
    const dataDir = root()
    const labels = ['INBOX', 'UNREAD']
    const requests: { url: string; method: string }[] = []
    const gmailFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      requests.push({ url: url.toString(), method: init?.method ?? 'GET' })
      if (url.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body))
        const code = body.get('code') ?? 'refresh'
        return json({
          access_token: `access-${code}`,
          refresh_token: `refresh-${code}`,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
          expires_in: 3600,
        })
      }
      if (url.pathname.endsWith('/profile')) {
        const auth = String((init?.headers as Record<string, string>)?.authorization)
        return json({ emailAddress: auth.includes('work') ? 'work@gmail.test' : 'one@gmail.test' })
      }
      if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'message1' }] })
      if (url.pathname.endsWith('/messages/message1')) {
        return json({
          id: 'message1',
          labelIds: labels,
          internalDate: '1790856000000',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Shop <shop@example.test>' },
              { name: 'Subject', value: 'October receipt' },
            ],
            body: { data: Buffer.from('PRIVATE-MAIL-BODY-DO-NOT-PERSIST').toString('base64url') },
          },
        })
      }
      throw new Error(`Unexpected endpoint: ${url}`)
    })
    const first = buildServer({ dataDir, gmailFetch, now: () => new Date('2026-10-01T12:00:00Z') })
    try {
      const personalId = await connectedAccount(first.app, 'Personal', 'personal')
      const workId = await connectedAccount(first.app, 'Work', 'work')
      for (const [id, account] of [
        [personalId, 'one@gmail.test'],
        [workId, 'work@gmail.test'],
      ] as const) {
        const attempt = first.serviceConnections.createAttempt({
          submissionId: randomUUID(),
          turnId: `cht-grant-${id}`,
          spaceId: 'spc-health',
          requestSummary: 'Read bounded Mailbox summaries',
          review: {
            service: 'gmail',
            scopes: [GMAIL_READ_SCOPE],
            actions: ['search_mailbox'],
            executionHost: 'Gateway native HTTPS',
          },
        })
        first.serviceConnections.beginAuthorization(attempt.id)
        first.serviceConnections.beginVerification(attempt.id)
        first.serviceConnections.verified(attempt.id, {
          connectionId: id,
          account,
          scopes: [GMAIL_READ_SCOPE],
          mechanism: 'gmail-oauth',
        })
        first.serviceConnections.grant(attempt.id, account, [GMAIL_READ_SCOPE])
      }
      expect(requests.filter((request) => request.url.includes('/messages'))).toHaveLength(0)
      const socket = new Socket()
      first.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: first.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Show unread receipts from this week',
        spaceId: 'spc-health',
      })
      await vi.waitFor(() =>
        expect(socket.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true),
      )
      expect(requests.filter((request) => request.url.includes('/messages'))).toHaveLength(0)
      expect(socket.sent.find((frame) => frame.type === 'chat.turn-end')).toMatchObject({
        message: { text: expect.stringContaining('Which Mailbox account') },
      })

      const secondSocket = new Socket()
      first.gateway.connect(secondSocket)
      secondSocket.receive({ type: 'hello', surfaceCursor: first.store.latestSurfaceCursor() })
      secondSocket.receive({
        type: 'chat.send',
        text: 'Show unread receipts from this week in Personal',
        spaceId: 'spc-health',
      })
      await vi.waitFor(() =>
        expect(secondSocket.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true),
      )
      expect(secondSocket.sent.some((frame) => frame.type === 'chat.turn-error')).toBe(false)
      expect(labels).toEqual(['INBOX', 'UNREAD'])
      const list = requests.find(
        (request) => request.url.endsWith('/messages') || request.url.includes('/messages?'),
      )!
      const query = new URL(list.url).searchParams
      expect(query.get('q')).toBe(
        '{receipt invoice} label:"Personal" is:unread after:1790553600 before:1791158400',
      )
      expect(query.get('maxResults')).toBe('20')
      expect(
        requests
          .filter((request) => request.url.includes('/messages'))
          .every((request) => request.method === 'GET'),
      ).toBe(true)
      const mailbox = first.store
        .listAuthorableSurfaces('spc-health')
        .surfaces.filter((surface) => surface.title === 'Mailbox')
      expect(mailbox).toHaveLength(1)
      const surface = SurfaceSchema.parse(first.store.getSurface(mailbox[0]!.id))
      expect(JSON.stringify(surface)).toContain('Last checked')
      expect(JSON.stringify(surface)).not.toContain('PRIVATE-MAIL-BODY')
      const events = first.store.eventLog('spc-health')
      expect(
        events.some(
          (event) => event.type === 'surface.create' && event.origin === 'untrusted:gmail',
        ),
      ).toBe(true)
      expect(events.at(-1)?.payload?.['toolCalls']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'load_skill' }),
          expect.objectContaining({ toolName: 'resolve_mailbox_scope' }),
          expect.objectContaining({ toolName: 'search_mailbox' }),
        ]),
      )
      expect(allFileContents(dataDir)).not.toContain('PRIVATE-MAIL-BODY-DO-NOT-PERSIST')
    } finally {
      await first.app.close()
    }
    const restarted = buildServer({
      dataDir,
      gmailFetch,
      now: () => new Date('2026-10-01T12:05:00Z'),
    })
    try {
      expect(
        GmailConnectionsSnapshotSchema.parse(
          (await restarted.app.inject({ method: 'GET', url: '/api/gmail-connections' })).json(),
        ).connections,
      ).toHaveLength(2)
      expect(
        restarted.store
          .listAuthorableSurfaces('spc-health')
          .surfaces.some((surface) => surface.title === 'Mailbox'),
      ).toBe(true)
    } finally {
      await restarted.app.close()
    }
  })
})
