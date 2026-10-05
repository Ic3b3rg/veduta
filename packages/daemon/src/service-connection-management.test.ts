import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GMAIL_READ_SCOPE,
  GmailConnectionsSnapshotSchema,
  ServiceConnectionsSnapshotSchema,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.ts'

const roots: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('connections page shared service lifecycle', () => {
  it.each([false, true])(
    'retries Gmail in place and cancels only a newly created account (existing: %s)',
    async (existing) => {
      const root = mkdtempSync(join(tmpdir(), 'veduta-cancel-account-'))
      roots.push(root)
      process.env['VEDUTA_VAULT_KEY'] = 'cancel-account-test-key'
      let providerCalls = 0
      let now = new Date('2026-10-05T12:00:00.000Z')
      const server = buildServer({
        dataDir: root,
        now: () => now,
        gmailFetch: async () => {
          providerCalls++
          throw new Error('Cancellation must not contact Google')
        },
      })
      try {
        await server.app.ready()
        const post = (url: string, payload: Record<string, unknown>) =>
          server.app.inject({ method: 'POST', url, payload })
        await post('/api/gmail-connections/oauth-client', {
          clientId: 'client',
          clientSecret: 'secret',
        })
        const mailbox = async () =>
          GmailConnectionsSnapshotSchema.parse(
            (await server.app.inject({ method: 'GET', url: '/api/gmail-connections' })).json(),
          )
        const previousId = existing
          ? GmailConnectionsSnapshotSchema.parse(
              (await post('/api/gmail-connections', { name: 'Existing account' })).json(),
            ).connections[0]!.id
          : undefined
        const created = await post('/api/service-connections/attempts', {
          submissionId: 'a44c94d5-bd42-4a1f-86ea-e88587ab818b',
          service: 'gmail',
          ...(previousId ? { connectionId: previousId, renewAuthorization: true } : {}),
        })
        const attempt = ServiceConnectionsSnapshotSchema.parse(created.json()).attempts[0]!
        const started = await post(
          `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
          {
            redirectOrigin: 'http://localhost:5173',
            ...(previousId ? { gmailConnectionId: previousId } : { name: 'New account' }),
          },
        )
        expect(started.statusCode).toBe(200)
        const state = new URL(started.json().authorizationUrl).searchParams.get('state')!
        const id = state.split('.')[0]!
        expect(
          (await post('/api/service-connections/gmail/callback', { state, error: 'access_denied' }))
            .statusCode,
        ).toBe(200)
        expect(
          (await post(`/api/service-connections/attempts/${attempt.id}/retry`, {})).statusCode,
        ).toBe(200)
        expect(server.serviceConnections.attempt(attempt.id)?.connectionId).toBe(id)
        expect(
          (
            await post(`/api/service-connections/attempts/${attempt.id}/gmail/authorize`, {
              redirectOrigin: 'http://localhost:5173',
              name: 'Accidental replacement',
            })
          ).statusCode,
        ).toBe(409)
        expect((await mailbox()).connections.map((item) => item.id)).toEqual([id])
        expect(server.serviceConnections.attempt(attempt.id)?.state).toBe('reviewing')
        if (!existing) {
          const other = await post('/api/service-connections/attempts', {
            submissionId: 'b26cd277-a4b4-4a91-9e20-3b90b493f1bb',
            service: 'gmail',
          })
          const otherId = ServiceConnectionsSnapshotSchema.parse(other.json()).attempts.at(-1)!.id
          expect(
            (
              await post(`/api/service-connections/attempts/${otherId}/gmail/authorize`, {
                redirectOrigin: 'http://localhost:5173',
                gmailConnectionId: id,
              })
            ).statusCode,
          ).toBe(409)
          expect(server.serviceConnections.attempt(otherId)?.state).toBe('reviewing')
        }
        const retried = await post(
          `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
          {
            redirectOrigin: 'http://localhost:5173',
            gmailConnectionId: id,
          },
        )
        expect(retried.statusCode).toBe(200)
        const retryState = new URL(retried.json().authorizationUrl).searchParams.get('state')!
        expect(
          (await post('/api/service-connections/gmail/callback', { state, code: 'stale-code' }))
            .statusCode,
        ).toBe(409)
        expect(server.serviceConnections.attempt(attempt.id)?.state).toBe('authorizing')
        expect(
          (
            await post('/api/service-connections/gmail/callback', {
              state: retryState,
              error: 'access_denied',
            })
          ).statusCode,
        ).toBe(200)
        expect(
          (await post(`/api/service-connections/attempts/${attempt.id}/retry`, {})).statusCode,
        ).toBe(200)
        const expiring = await post(
          `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
          {
            redirectOrigin: 'http://localhost:5173',
            gmailConnectionId: id,
          },
        )
        const expiringState = new URL(expiring.json().authorizationUrl).searchParams.get('state')!
        now = new Date('2026-10-05T12:11:00.000Z')
        expect(
          (
            await post('/api/service-connections/gmail/callback', {
              state: expiringState,
              code: 'expired-code',
            })
          ).statusCode,
        ).toBe(409)
        expect(server.serviceConnections.attempt(attempt.id)?.state).toBe('failed')
        expect((await mailbox()).connections).toHaveLength(1)
        expect(
          (await post(`/api/service-connections/attempts/${attempt.id}/cancel`, {})).statusCode,
        ).toBe(200)
        expect((await mailbox()).connections.map((item) => item.id)).toEqual(
          previousId ? [previousId] : [],
        )
        expect(
          (
            await post('/api/service-connections/gmail/callback', {
              state: retryState,
              error: 'access_denied',
            })
          ).statusCode,
        ).toBe(409)
        expect(server.serviceConnections.attempt(attempt.id)?.state).toBe('cancelled')
        expect(server.serviceConnections.snapshot().grants).toEqual([])
        expect((await mailbox()).oauthClient?.configured).toBe(true)
        expect(providerCalls).toBe(0)
      } finally {
        await server.app.close()
      }
    },
  )

  it('uses installation Google configuration in the existing durable authorization and grant flow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-management-gmail-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'management-gmail-test-key'
    const calls: string[] = []
    const server = buildServer({
      dataDir: root,
      gmailFetch: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/token'))
          return new Response(
            JSON.stringify({
              access_token: 'access',
              refresh_token: 'refresh',
              scope: GMAIL_READ_SCOPE,
            }),
          )
        if (url.endsWith('/profile'))
          return new Response(JSON.stringify({ emailAddress: 'one@gmail.test' }))
        throw new Error('Setup accessed messages')
      },
    })
    try {
      await server.app.ready()
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/service-connections/attempts',
        payload: { service: 'gmail', submissionId: 'e98b1b58-e3d4-49fe-817c-6a97d602df4e' },
      })
      const attempt = ServiceConnectionsSnapshotSchema.parse(response.json()).attempts[0]!
      const start = () =>
        server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/gmail/authorize`,
          payload: { redirectOrigin: 'http://localhost:5173', name: 'Personal' },
        })
      expect((await start()).statusCode).toBe(409)
      expect(server.serviceConnections.attempt(attempt.id)?.state).toBe('reviewing')
      expect(
        GmailConnectionsSnapshotSchema.parse(
          (await server.app.inject({ method: 'GET', url: '/api/gmail-connections' })).json(),
        ).connections,
      ).toEqual([])
      const configured = await server.app.inject({
        method: 'POST',
        url: '/api/gmail-connections/oauth-client',
        payload: { clientId: 'google-client', clientSecret: 'google-secret' },
      })
      expect(configured.statusCode).toBe(200)
      expect(GmailConnectionsSnapshotSchema.parse(configured.json()).oauthClient).toEqual({
        configured: true,
      })
      expect(configured.body).not.toContain('google-secret')
      expect(calls).toEqual([])
      const begun = await start()
      expect(begun.statusCode).toBe(200)
      const url = new URL(begun.json().authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('google-client')
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/app/connections')
      const callback = await server.app.inject({
        method: 'POST',
        url: '/api/service-connections/gmail/callback',
        payload: { code: 'code', state: url.searchParams.get('state') },
      })
      expect(callback.statusCode).toBe(200)
      const verified = ServiceConnectionsSnapshotSchema.parse(callback.json())
      expect(verified.attempts[0]?.verifiedAccount).toBe('one@gmail.test')
      expect(verified.grants).toEqual([])
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${attempt.id}/grant`,
            payload: { account: 'one@gmail.test', scopes: [GMAIL_READ_SCOPE], spaceIds: [] },
          })
        ).statusCode,
      ).toBe(200)
      expect(server.serviceConnections.snapshot().connections).toHaveLength(1)
      expect(server.serviceConnections.snapshot().grants).toEqual([])
      expect(calls).toEqual([
        'https://oauth2.googleapis.com/token',
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      ])
    } finally {
      await server.app.close()
    }
  })

  it('verifies a passive account and grants selected Spaces without manufacturing a Chat job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-management-connection-'))
    roots.push(root)
    process.env['VEDUTA_VAULT_KEY'] = 'management-connection-test-key'
    const calls: string[] = []
    const server = buildServer({
      dataDir: root,
      githubMcp: {
        fetchFn: async (input) => {
          expect(String(input)).toBe('https://api.github.com/user')
          calls.push('identity')
          return new Response(JSON.stringify({ login: 'test-account' }), { status: 200 })
        },
        install: async () => '/reviewed/github-mcp-server',
        createClient: () => ({
          start: async () => {},
          discoverTools: async () => ({
            name: 'list_issues',
            schemaSha256: '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119',
          }),
          listOpenIssues: async () => {
            throw new Error('Setup must not read issues')
          },
          createIssue: async () => {
            throw new Error('Setup must not write issues')
          },
          stop: async () => {},
        }),
      },
    })
    try {
      await server.app.ready()
      const work = server.store.spacesEngine.createSpace({ name: 'Work' })
      const health = server.store.spacesEngine.createSpace({ name: 'Health' })
      const healthEvents = server.store.eventLog(health.id)
      const workSurfaces = server.store.listSurfaces(work.id)
      const input = {
        submissionId: '121a854c-946a-4b6a-97c9-fb7276cd1e29',
        service: 'github',
        repository: { owner: 'example', name: 'disposable' },
      }
      const create = () =>
        server.app.inject({
          method: 'POST',
          url: '/api/service-connections/attempts',
          payload: input,
        })
      const response = await create()
      expect(response.statusCode).toBe(200)
      const attempt = ServiceConnectionsSnapshotSchema.parse(response.json()).attempts[0]!
      expect(attempt).toMatchObject({ origin: 'management', state: 'reviewing' })
      expect(attempt.turnId).toBeUndefined()
      expect(attempt.spaceId).toBeUndefined()
      expect(ServiceConnectionsSnapshotSchema.parse((await create()).json()).attempts).toHaveLength(
        1,
      )
      expect(calls).toEqual([])
      const authorization = await server.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/github/authorize`,
        payload: { token: 'github_pat_' + 'x'.repeat(30) },
      })
      expect(authorization.statusCode).toBe(200)
      const verified = ServiceConnectionsSnapshotSchema.parse(authorization.json())
      expect(verified.connections[0]?.state).toBe('ready')
      expect(verified.grants).toEqual([])
      expect(calls).toEqual(['identity'])
      const confirmation = {
        account: 'test-account',
        scopes: attempt.review.scopes,
        spaceIds: [work.id],
      }
      const grant = () =>
        server.app.inject({
          method: 'POST',
          url: `/api/service-connections/attempts/${attempt.id}/grant`,
          payload: confirmation,
        })
      expect((await grant()).statusCode).toBe(200)
      expect((await grant()).statusCode).toBe(200)
      const snapshot = server.serviceConnections.snapshot()
      expect(snapshot.grants).toHaveLength(1)
      expect(snapshot.grants[0]?.spaceId).toBe(work.id)
      expect(server.serviceConnections.claimContinuation(attempt.id)).toBe(false)
      expect(
        server.store.eventLog(work.id).filter((event) => event.type === 'service.capability'),
      ).toHaveLength(1)
      expect(server.store.eventLog(health.id)).toEqual(healthEvents)
      expect(server.store.listSurfaces(work.id)).toEqual(workSurfaces)
      expect(calls).toEqual(['identity'])
      const invalid = await server.app.inject({
        method: 'POST',
        url: `/api/service-connections/attempts/${attempt.id}/grant`,
        payload: { ...confirmation, spaceIds: ['missing-space'] },
      })
      expect(invalid.statusCode).toBe(404)
      const second = await server.app.inject({
        method: 'POST',
        url: '/api/service-connections/attempts',
        payload: {
          ...input,
          submissionId: '1f3536b8-a2ad-4549-bd1e-f164fd1a3b4e',
          connectionId: snapshot.connections[0]!.id,
        },
      })
      const secondAttempt = ServiceConnectionsSnapshotSchema.parse(second.json()).attempts.at(-1)!
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${secondAttempt.id}/use-connection`,
            payload: {},
          })
        ).statusCode,
      ).toBe(200)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/service-connections/attempts/${secondAttempt.id}/grant`,
            payload: { ...confirmation, spaceIds: [health.id] },
          })
        ).statusCode,
      ).toBe(200)
      expect(server.serviceConnections.snapshot().connections).toHaveLength(1)
      expect(
        server.serviceConnections.snapshot().grants.filter((grant) => grant.enabled),
      ).toHaveLength(2)
      expect(calls).toEqual(['identity'])
    } finally {
      await server.app.close()
    }
  })
})
