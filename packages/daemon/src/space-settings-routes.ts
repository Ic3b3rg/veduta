import type { FastifyInstance } from 'fastify'
import { ReflectionSettingsChangeSchema, SpaceSettingsCommandSchema } from '@veduta/protocol'
import type { SpaceSettingsService } from './space-settings.ts'
import { SettingsRecoveryPendingError } from './settings-mutation.ts'

export function registerSpaceSettingsRoutes(
  app: FastifyInstance,
  service: SpaceSettingsService,
): void {
  app.get('/api/settings/spaces', (_request, reply) => {
    try {
      return service.list()
    } catch (error) {
      if (error instanceof SettingsRecoveryPendingError)
        return reply.status(503).send({ error: message(error) })
      throw error
    }
  })
  app.get<{ Params: { spaceId: string } }>('/api/settings/spaces/:spaceId', (request, reply) => {
    try {
      return service.read(request.params.spaceId)
    } catch (error) {
      return reply
        .status(error instanceof SettingsRecoveryPendingError ? 503 : 404)
        .send({ error: message(error) })
    }
  })
  app.post<{ Params: { spaceId: string } }>('/api/settings/spaces/:spaceId', (request, reply) => {
    const parsed = SpaceSettingsCommandSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid Space settings change' })
    try {
      return service.change(request.params.spaceId, parsed.data)
    } catch (error) {
      return reply
        .status(error instanceof SettingsRecoveryPendingError ? 503 : 409)
        .send({ error: message(error) })
    }
  })
  app.post('/api/settings/reflection', (request, reply) => {
    const parsed = ReflectionSettingsChangeSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Choose a valid Reflection time' })
    try {
      return service.changeReflection(parsed.data)
    } catch (error) {
      return reply
        .status(error instanceof SettingsRecoveryPendingError ? 503 : 409)
        .send({ error: message(error) })
    }
  })
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Settings could not be saved'
}
