import type { FastifyInstance } from 'fastify'
import {
  AutomationOutcomeUnavailableError,
  type AutomationOutcomeService,
} from './automation-outcome-service.ts'

export interface AutomationOutcomeRoutesDeps {
  service: Pick<AutomationOutcomeService, 'list' | 'open' | 'dismiss'>
}

export function registerAutomationOutcomeRoutes(
  app: FastifyInstance,
  deps: AutomationOutcomeRoutesDeps,
): void {
  app.get('/api/spaces/:spaceId/automation-outcome-notifications', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    try {
      return deps.service.list(spaceId)
    } catch (error) {
      return unavailable(reply, error)
    }
  })

  for (const action of ['open', 'dismiss'] as const) {
    app.post(
      `/api/spaces/:spaceId/automation-outcome-notifications/:notificationId/${action}`,
      (request, reply) => {
        const { spaceId, notificationId } = request.params as {
          spaceId: string
          notificationId: string
        }
        try {
          return deps.service[action](spaceId, notificationId, 'trusted:user')
        } catch (error) {
          return unavailable(reply, error)
        }
      },
    )
  }
}

function unavailable(
  reply: { status(code: number): { send(value: unknown): unknown } },
  error: unknown,
) {
  if (error instanceof AutomationOutcomeUnavailableError) {
    return reply.status(404).send({ error: error.message })
  }
  throw error
}
