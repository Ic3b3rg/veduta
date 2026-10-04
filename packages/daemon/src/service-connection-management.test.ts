import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceConnectionsSnapshotSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.ts'

const roots: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('connections page shared service lifecycle', () => {
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
