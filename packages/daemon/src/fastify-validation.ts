import type { FastifyReply } from 'fastify'
import { z } from 'zod'

const EmptyBodySchema = z.object({}).strict()

/** Sends 400 when a route that accepts no fields receives a non-empty body. */
export function rejectUnexpectedBody(reply: FastifyReply, body: unknown): FastifyReply | undefined {
  if (body === undefined) return undefined
  const parsed = EmptyBodySchema.safeParse(body)
  if (parsed.success) return undefined
  return reply.status(400).send({ error: parsed.error.issues })
}
