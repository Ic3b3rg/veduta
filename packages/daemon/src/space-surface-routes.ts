import {
  ActionInvocationSchema,
  MoveSurfaceRequestSchema,
  MoveSurfaceResultSchema,
  PinSurfaceResultSchema,
} from '@veduta/protocol'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { appendConnectedDevicesSurface } from './connected-devices-surface.ts'
import type { ModelRouter } from './model-routing.ts'
import type { NotificationCenter } from './notification-center.ts'
import type { PushStore } from './push-store.ts'
import { extractBearer, type ServerAuthOptions } from './server-auth.ts'
import { SurfaceActionError, type Store } from './store.ts'
import { SurfaceMoveError, SurfaceNotPinnableError } from './surface-engine.ts'
import { appendSystemSurface } from './system-space.ts'
import type { TemplateEngine } from './template-engine.ts'
import { usageSurface } from './usage-surface.ts'

const PinSurfaceBodySchema = z.object({ pinned: z.boolean() })

export interface SpaceSurfaceRouteDeps {
  auth: ServerAuthOptions
  store: Store
  router: ModelRouter
  pushStore: PushStore
  notificationCenter: NotificationCenter
  templateEngine: TemplateEngine
}

export function registerSpaceSurfaceRoutes(
  app: FastifyInstance,
  deps: SpaceSurfaceRouteDeps,
): void {
  const { auth, store, router, pushStore, notificationCenter, templateEngine } = deps

  app.get('/api/spaces', (request) => {
    const rawSnapshot = appendSystemSurface(
      store.snapshot(),
      usageSurface(router.usage(), new Date().toISOString()),
    )
    const snapshot = {
      ...rawSnapshot,
      spaces: rawSnapshot.spaces.map((space) => {
        const attention = pushStore.getAttention(space.id)
        return { ...space, attention: attention.count, attentionRevision: attention.revision }
      }),
    }
    if (auth.mode !== 'production') return snapshot
    const token = extractBearer(request.headers.authorization)
    return token ? appendConnectedDevicesSurface(snapshot, auth.store.listDevices(token)) : snapshot
  })

  app.get('/api/spaces/:spaceId/events', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    return { events: store.eventLog(spaceId) }
  })

  app.post('/api/spaces/:spaceId/attention/seen', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    const result = notificationCenter.markSeen(spaceId) ?? pushStore.getAttention(spaceId)
    return { count: result.count, revision: result.revision }
  })

  app.post('/api/surfaces/:surfaceId/actions', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = ActionInvocationSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      const result = store.invokeSurfaceAction(surfaceId, parsed.data)
      if (result.path === 'agent') return reply.status(202).send({ turn: result.turn })
      return { surface: result.mutation.surface }
    } catch (error) {
      if (error instanceof SurfaceActionError) {
        return reply.status(statusForSurfaceActionError(error)).send({ error: error.message })
      }
      throw error
    }
  })

  app.post('/api/surfaces/:surfaceId/pin', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = PinSurfaceBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (!store.getSurface(surfaceId)) {
      return reply.status(404).send({ error: `unknown Surface: ${surfaceId}` })
    }
    try {
      const { surface, changed, order } = templateEngine.pin(surfaceId, parsed.data.pinned, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      return PinSurfaceResultSchema.parse({ surface, changed, order })
    } catch (error) {
      if (error instanceof SurfaceNotPinnableError) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })

  app.post('/api/spaces/:spaceId/surfaces/:surfaceId/move', (request, reply) => {
    const { spaceId, surfaceId } = request.params as { spaceId: string; surfaceId: string }
    const parsed = MoveSurfaceRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      const order = store.moveSurface(spaceId, surfaceId, parsed.data.direction)
      return MoveSurfaceResultSchema.parse({ changed: true, order })
    } catch (error) {
      if (error instanceof SurfaceMoveError) {
        return reply.status(error.code === 'unavailable' ? 404 : 409).send({ error: error.message })
      }
      throw error
    }
  })
}

function statusForSurfaceActionError(error: SurfaceActionError): number {
  if (error.code === 'unknown_surface') return 404
  if (error.code === 'missing_value') return 400
  return 403
}
