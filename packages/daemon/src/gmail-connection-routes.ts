import {
  BeginGmailAuthorizationRequestSchema,
  BeginGmailAuthorizationResponseSchema,
  CompleteGmailAuthorizationRequestSchema,
  CreateGmailConnectionRequestSchema,
  FailGmailAuthorizationRequestSchema,
  GmailConnectionsSnapshotSchema,
  RenameGmailConnectionRequestSchema,
} from '@veduta/protocol'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { GmailConnectionError, type GmailConnections } from './gmail-connections.ts'
import { rejectUnexpectedBody } from './fastify-validation.ts'

async function guarded<T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GmailConnectionError) {
      reply.status(error.status).send({ error: error.message })
    } else {
      reply.status(500).send({ error: 'Gmail connection request failed' })
    }
    return undefined
  }
}

export function registerGmailConnectionRoutes(
  app: FastifyInstance,
  connections: GmailConnections,
): void {
  app.get('/api/gmail-connections', () => connections.snapshot())

  app.post('/api/gmail-connections', (request, reply) => {
    const parsed = CreateGmailConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, () =>
      GmailConnectionsSnapshotSchema.parse(connections.create(parsed.data)),
    )
  })

  app.patch('/api/gmail-connections/:id', (request, reply) => {
    const parsed = RenameGmailConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, () =>
      GmailConnectionsSnapshotSchema.parse(connections.rename(id, parsed.data.name)),
    )
  })

  app.post('/api/gmail-connections/:id/authorize', (request, reply) => {
    const parsed = BeginGmailAuthorizationRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, () =>
      BeginGmailAuthorizationResponseSchema.parse(
        connections.beginAuthorization(id, parsed.data.redirectOrigin),
      ),
    )
  })

  app.post('/api/gmail-connections/:id/complete', (request, reply) => {
    const parsed = CompleteGmailAuthorizationRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, async () =>
      GmailConnectionsSnapshotSchema.parse(
        await connections.completeAuthorization(id, parsed.data.code, parsed.data.state),
      ),
    )
  })

  app.post('/api/gmail-connections/:id/verify-legacy', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, async () =>
      GmailConnectionsSnapshotSchema.parse(await connections.verifyLegacy(id)),
    )
  })

  app.post('/api/gmail-connections/:id/fail', (request, reply) => {
    const parsed = FailGmailAuthorizationRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, () =>
      GmailConnectionsSnapshotSchema.parse(
        connections.failAuthorization(id, parsed.data.state, parsed.data.reason),
      ),
    )
  })

  app.delete('/api/gmail-connections/:id', (request, reply) => {
    const { id } = request.params as { id: string }
    return guarded(reply, () => GmailConnectionsSnapshotSchema.parse(connections.remove(id)))
  })
}
