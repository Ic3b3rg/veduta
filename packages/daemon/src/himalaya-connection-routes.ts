import {
  CompleteLegacyHimalayaRequestSchema,
  CreateHimalayaConnectionRequestSchema,
  HimalayaConnectionsSnapshotSchema,
} from '@veduta/protocol'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { rejectUnexpectedBody } from './fastify-validation.ts'
import { HimalayaConnectionError, type HimalayaConnections } from './himalaya-connections.ts'

async function guarded<T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof HimalayaConnectionError) {
      reply.status(error.status).send({ error: error.message })
    } else {
      reply.status(500).send({ error: 'Mailbox setup failed' })
    }
    return undefined
  }
}

export function registerHimalayaConnectionRoutes(
  app: FastifyInstance,
  connections: HimalayaConnections,
): void {
  app.get('/api/himalaya-connections', () => connections.snapshot())

  app.post('/api/himalaya-connections', (request, reply) => {
    const parsed = CreateHimalayaConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, () =>
      HimalayaConnectionsSnapshotSchema.parse(connections.create(parsed.data)),
    )
  })

  app.patch('/api/himalaya-connections/:id', (request, reply) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict()
      .safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, () =>
      HimalayaConnectionsSnapshotSchema.parse(connections.rename(id, parsed.data.name)),
    )
  })

  app.post('/api/himalaya-connections/:id/complete-legacy', (request, reply) => {
    const parsed = CompleteLegacyHimalayaRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { id } = request.params as { id: string }
    return guarded(reply, () =>
      HimalayaConnectionsSnapshotSchema.parse(connections.completeLegacy(id, parsed.data)),
    )
  })

  app.post('/api/himalaya-connections/:id/verify', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, async () =>
      HimalayaConnectionsSnapshotSchema.parse(await connections.verify(id)),
    )
  })

  app.post('/api/himalaya-connections/install', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    return guarded(reply, () => connections.install())
  })

  app.delete('/api/himalaya-connections/:id', (request, reply) => {
    const { id } = request.params as { id: string }
    return guarded(reply, () => HimalayaConnectionsSnapshotSchema.parse(connections.remove(id)))
  })
}
