import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GMAIL_READ_SCOPE,
  GatewayServerMessageSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
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
async function connectAccount(server: ReturnType<typeof buildServer>, address: string) {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/service-connections/attempts',
    payload: {
      submissionId: randomUUID(),
      service: 'gmail',
    },
  })
  expect(created.statusCode).toBe(200)
  const attempt = server.serviceConnections.snapshot().attempts.at(-1)!
  const begin = await server.app.inject({
    method: 'POST',
    url: `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
    payload: {
      redirectOrigin: 'http://localhost:5173',
      name: address.split('@')[0],
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
    },
  })
  expect(begin.statusCode).toBe(200)
  const state = new URL(begin.json().authorizationUrl).searchParams.get('state')!
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { state, code: address },
      })
    ).statusCode,
  ).toBe(200)
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/grant`,
        payload: { account: address, scopes: [GMAIL_READ_SCOPE], spaceIds: ['spc-health'] },
      })
    ).statusCode,
  ).toBe(200)
}
function persisted(root: string): string {
  return readdirSync(root)
    .map((name) => {
      const path = join(root, name)
      return statSync(path).isDirectory() ? persisted(path) : readFileSync(path, 'utf8')
    })
    .join('\n')
}

it.each(['focused', 'global', 'paginated', 'filtered'])(
  'continues the %s latest Inbox request after setup, selects by timestamp, and preserves unread state on reconnect',
  async (scenario) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'veduta-latest-mail-'))
    process.env['VEDUTA_VAULT_KEY'] = 'latest-mail-fixture-key'
    const requests: { url: URL; method: string }[] = []
    const labels = ['INBOX', 'UNREAD']
    const text =
      scenario === 'global'
        ? 'Leggi la mia ultima mail e fammi un recap nello Space Health'
        : 'Leggi la mia ultima mail e fammi un recap'
    const chatScope = scenario === 'global' ? {} : { spaceId: 'spc-health' }
    const server = buildServer({
      dataDir,
      serviceRequestComplete: async () =>
        JSON.stringify({
          status: 'resolved',
          spaceId: 'spc-health',
          operation: {
            service: 'gmail',
            action: 'search_mailbox',
            folder: scenario === 'filtered' ? 'Receipts' : 'INBOX',
            query:
              scenario === 'filtered'
                ? 'from:shop@example.test OR from:other@example.test after:1790000000'
                : '',
            limit: scenario === 'filtered' ? 2 : 1,
            newest: true,
            unreadOnly: false,
          },
        }),
      gmailFetch: async (input, init) => {
        const url = new URL(String(input))
        requests.push({ url, method: init?.method ?? 'GET' })
        if (url.pathname === '/token')
          return json({
            access_token: 'access',
            refresh_token: 'refresh',
            scope: GMAIL_READ_SCOPE,
            expires_in: 3600,
          })
        if (url.pathname.endsWith('/profile'))
          return json({ emailAddress: 'personal@example.test' })
        if (url.pathname.endsWith('/messages'))
          return json({
            messages: [{ id: 'old' }, { id: 'latest' }],
            ...(scenario === 'paginated' && !url.searchParams.get('q')?.includes('after:')
              ? { nextPageToken: 'more-older-mail' }
              : {}),
          })
        const id = url.pathname.split('/').at(-1)
        if (id !== 'old' && id !== 'latest') throw new Error('Unexpected provider request')
        const metadata = {
          id,
          labelIds: labels,
          internalDate:
            scenario === 'paginated'
              ? String(Date.now() - (id === 'latest' ? 60000 : 3600000))
              : id === 'latest'
                ? '1790856000000'
                : '1790769600000',
        }
        if (url.searchParams.get('format') === 'metadata') return json(metadata)
        return json({
          ...metadata,
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'sender@example.test' },
              { name: 'Subject', value: id === 'latest' ? 'Newest Inbox message' : 'Old message' },
            ],
            body: { data: Buffer.from('PRIVATE-LATEST-BODY').toString('base64url') },
          },
        })
      },
    })
    try {
      await server.app.ready()
      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      const submissionId = randomUUID()
      socket.receive({
        type: 'chat.send',
        text,
        ...chatScope,
        submissionId,
      })
      await vi.waitFor(() => expect(server.serviceConnections.snapshot().attempts).toHaveLength(1))
      expect(requests).toEqual([])
      const attempt = server.serviceConnections.snapshot().attempts[0]!
      const begin = await server.app.inject({
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
      const state = new URL(begin.json().authorizationUrl).searchParams.get('state')!
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/service-connections/gmail/callback',
            payload: { state, code: 'fixture' },
          })
        ).statusCode,
      ).toBe(200)
      expect(requests.filter(({ url }) => url.pathname.includes('/messages'))).toHaveLength(0)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${attempt.id}/grant`,
            payload: { account: 'personal@example.test', scopes: [GMAIL_READ_SCOPE] },
          })
        ).statusCode,
      ).toBe(200)
      await vi.waitFor(() => expect(JSON.stringify(socket.sent)).toContain('Newest Inbox message'))
      expect(
        requests
          .filter(({ url }) => url.pathname.endsWith('/messages'))
          .map(({ url }) => url.searchParams.get('q')),
      ).toEqual(
        scenario === 'paginated'
          ? ['in:inbox', expect.stringMatching(/^\(in:inbox\) after:\d+$/)]
          : scenario === 'filtered'
            ? [
                '(from:shop@example.test OR from:other@example.test after:1790000000) label:"Receipts"',
              ]
            : ['in:inbox'],
      )
      expect(
        requests
          .filter(({ url }) => url.searchParams.get('format') === 'full')
          .map(({ url }) => url.pathname.split('/').at(-1)),
      ).toEqual(scenario === 'filtered' ? ['latest', 'old'] : ['latest'])
      expect(
        requests
          .filter(({ url }) => url.pathname.includes('/messages'))
          .every(({ method }) => method === 'GET'),
      ).toBe(true)
      expect(labels).toEqual(['INBOX', 'UNREAD'])
      expect(JSON.stringify(server.store.listSurfaces('spc-health'))).toContain(
        'Newest Inbox message',
      )
      expect(persisted(dataDir)).not.toContain('PRIVATE-LATEST-BODY')
      const before = requests.length
      const reconnected = new Socket()
      server.gateway.connect(reconnected)
      reconnected.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      reconnected.receive({
        type: 'chat.send',
        text,
        ...chatScope,
        submissionId,
      })
      await vi.waitFor(() =>
        expect(reconnected.sent.some((frame) => frame.type === 'chat.accepted')).toBe(true),
      )
      expect(requests).toHaveLength(before)
    } finally {
      await server.app.close()
      delete process.env['VEDUTA_VAULT_KEY']
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
)

it('keeps the latest-message operation through account clarification without requiring it to be repeated', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'veduta-latest-account-'))
  process.env['VEDUTA_VAULT_KEY'] = 'latest-account-fixture-key'
  const calls: { url: URL; account: string }[] = []
  const prompts: string[] = []
  const server = buildServer({
    dataDir,
    serviceRequestComplete: async (prompt) => {
      prompts.push(prompt)
      const followup = prompt.includes('CURRENT user message: "personal@example.test"')
      if (followup && !prompt.includes('"status":"clarify"')) return '{"status":"none"}'
      return JSON.stringify({
        status: 'resolved',
        spaceId: 'spc-health',
        operation: {
          service: 'gmail',
          action: 'search_mailbox',
          folder: 'ALL',
          query: 'from:shop@example.test',
          limit: 2,
          newest: true,
          unreadOnly: false,
          ...(followup ? { account: 'personal@example.test' } : {}),
        },
      })
    },
    gmailFetch: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body))
        const account = body.get('code') ?? body.get('refresh_token')
        return json({
          access_token: account,
          refresh_token: account,
          scope: GMAIL_READ_SCOPE,
          expires_in: 3600,
        })
      }
      const account = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: account })
      calls.push({ url, account })
      return json({ messages: [] })
    },
  })
  try {
    await server.app.ready()
    await connectAccount(server, 'personal@example.test')
    await connectAccount(server, 'work@example.test')
    const first = new Socket()
    server.gateway.connect(first)
    first.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    first.receive({
      type: 'chat.send',
      text: 'Riassumi le ultime due mail da shop@example.test, anche archiviate',
      spaceId: 'spc-health',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(JSON.stringify(first.sent)).toContain('Which Mailbox account'))
    expect(calls).toEqual([])
    const second = new Socket()
    server.gateway.connect(second)
    second.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
    second.receive({
      type: 'chat.send',
      text: 'personal@example.test',
      spaceId: 'spc-health',
      submissionId: randomUUID(),
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.account).toBe('personal@example.test')
    expect(calls[0]!.url.searchParams.get('q')).toBe('(from:shop@example.test)')
    expect(prompts.at(-1)).toContain('Riassumi le ultime due mail')
    await vi.waitFor(() =>
      expect(JSON.stringify(server.store.listSurfaces('spc-health'))).toContain(
        'No messages matched',
      ),
    )
  } finally {
    await server.app.close()
    delete process.env['VEDUTA_VAULT_KEY']
    rmSync(dataDir, { recursive: true, force: true })
  }
})
