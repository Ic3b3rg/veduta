import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ChatTimelinePageSchema, type ChatScope } from '@veduta/protocol'
import { ChatTimelineError, type ChatTimeline } from './chat-timeline.ts'

const QuerySchema = z.object({
  spaceId: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
})

export function registerChatTimelineRoutes(
  app: FastifyInstance,
  deps: { timeline: ChatTimeline; hasSpace: (spaceId: string) => boolean },
): void {
  app.get('/api/chat/timeline', (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Chat timeline query' })
    const { spaceId, before, limit } = parsed.data
    if (spaceId !== undefined && !deps.hasSpace(spaceId))
      return reply.code(404).send({ error: 'Chat Space unavailable' })
    const scope: ChatScope = spaceId === undefined ? { type: 'global' } : { type: 'space', spaceId }
    try {
      return ChatTimelinePageSchema.parse(deps.timeline.page(scope, before, limit))
    } catch (error) {
      if (error instanceof ChatTimelineError && error.code === 'invalid_cursor')
        return reply.code(400).send({ error: error.message })
      throw error
    }
  })
}
