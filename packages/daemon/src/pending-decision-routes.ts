import { PendingDecisionResolveRequestSchema } from '@veduta/protocol'
import type { FastifyInstance } from 'fastify'
import {
  PendingDecisionActorError,
  PendingDecisionNotFoundError,
  PendingDecisionResolutionError,
  type PendingDecisionService,
} from './pending-decision-service.ts'

export interface PendingDecisionRoutesDeps {
  service: Pick<PendingDecisionService, 'list' | 'resolve'>
}

/**
 * Authenticated channel-neutral access to daemon-owned Pending decisions.
 * The Gateway auth hook establishes the user session; this boundary supplies
 * the only actor the owning workflows accept instead of trusting request data.
 */
export function registerPendingDecisionRoutes(
  app: FastifyInstance,
  deps: PendingDecisionRoutesDeps,
): void {
  app.get('/api/pending-decisions', () => deps.service.list())

  app.post('/api/pending-decisions/:decisionId/resolve', async (request, reply) => {
    const parsed = PendingDecisionResolveRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })

    const { decisionId } = request.params as { decisionId: string }
    try {
      return await deps.service.resolve(decisionId, parsed.data.resolution, 'trusted:user')
    } catch (error) {
      if (error instanceof PendingDecisionNotFoundError) {
        return reply.status(404).send({ error: error.message })
      }
      if (error instanceof PendingDecisionResolutionError) {
        return reply.status(409).send({ error: error.message })
      }
      if (error instanceof PendingDecisionActorError) {
        return reply.status(403).send({ error: error.message })
      }
      throw error
    }
  })
}
