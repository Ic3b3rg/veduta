import {
  ActionInvocationSchema,
  AgentActionResultSchema,
  type AgentActionTurn,
  FastSurfaceActionResultSchema,
  MoveSurfaceRequestSchema,
  MoveSurfaceResultSchema,
  PinSurfaceResultSchema,
  SurfaceCommitRecoveryPendingResponseSchema,
  SurfaceCommitRecoveryStateSchema,
} from '@veduta/protocol'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { NotificationCenter } from './notification-center.ts'
import type { PushStore } from './push-store.ts'
import { SurfaceActionError, type Store } from './store.ts'
import { SurfaceMoveError, SurfaceNotPinnableError } from './surface-engine.ts'
import { SurfaceCommitRecoveryPendingError } from './surface-commit.ts'
import type { QueuedAgentTurn } from './surface-engine.ts'
import type { TemplateEngine } from './template-engine.ts'

const PinSurfaceBodySchema = z.object({ pinned: z.boolean() })

export interface SpaceSurfaceRouteDeps {
  store: Store
  pushStore: PushStore
  notificationCenter: NotificationCenter
  templateEngine: TemplateEngine
  executeAgentAction: (turn: QueuedAgentTurn) => Promise<AgentActionTurn>
}

export function registerSpaceSurfaceRoutes(
  app: FastifyInstance,
  deps: SpaceSurfaceRouteDeps,
): void {
  const { store, pushStore, notificationCenter, templateEngine } = deps

  app.get('/api/spaces', () => {
    const rawSnapshot = store.snapshot()
    const snapshot = {
      ...rawSnapshot,
      spaces: rawSnapshot.spaces.map((space) => {
        const attention = pushStore.getAttention(space.id)
        return { ...space, attention: attention.count, attentionRevision: attention.revision }
      }),
    }
    return snapshot
  })

  app.get('/api/spaces/:spaceId/events', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    return { events: store.eventLog(spaceId) }
  })

  const recoveryState = () =>
    SurfaceCommitRecoveryStateSchema.parse({
      pending: store.recoveryPendingSurfaceCommits().map((record) => ({
        id: record.id,
        spaceId: record.spaceId,
        sequence: record.sequence,
        ...(record.surfaceEventCursor === undefined
          ? {}
          : { surfaceEventCursor: record.surfaceEventCursor }),
        state: 'recovery_pending',
      })),
    })

  app.get('/api/surface-commits/recovery', recoveryState)
  app.post('/api/surface-commits/recovery', () => {
    store.reconcilePendingSurfaceCommits()
    return recoveryState()
  })

  app.post('/api/spaces/:spaceId/attention/seen', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    const result = notificationCenter.markSeen(spaceId) ?? pushStore.getAttention(spaceId)
    return { count: result.count, revision: result.revision }
  })

  app.post('/api/surfaces/:surfaceId/actions', async (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = ActionInvocationSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      const result = store.invokeSurfaceAction(surfaceId, parsed.data)
      if (result.path === 'agent') {
        const turn = await deps.executeAgentAction(result.turn)
        return reply
          .status(turn.status === 'queued' || turn.status === 'running' ? 202 : 200)
          .send(AgentActionResultSchema.parse({ turn }))
      }
      return reply
        .status(result.outcome.outcome === 'recovery_pending' ? 202 : 200)
        .send(FastSurfaceActionResultSchema.parse(result.outcome))
    } catch (error) {
      if (error instanceof SurfaceCommitRecoveryPendingError) {
        return reply.status(503).send(recoveryPendingResponse(error))
      }
      if (error instanceof SurfaceActionError) {
        return reply
          .status(statusForSurfaceActionError(error))
          .send({ error: error.message, code: error.code })
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
      if (error instanceof SurfaceCommitRecoveryPendingError) {
        return reply.status(503).send(recoveryPendingResponse(error))
      }
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
      if (error instanceof SurfaceCommitRecoveryPendingError) {
        return reply.status(503).send(recoveryPendingResponse(error))
      }
      if (error instanceof SurfaceMoveError) {
        return reply.status(error.code === 'unavailable' ? 404 : 409).send({ error: error.message })
      }
      throw error
    }
  })
}

function recoveryPendingResponse(error: SurfaceCommitRecoveryPendingError) {
  return SurfaceCommitRecoveryPendingResponseSchema.parse({
    outcome: error.outcome,
    surfaceCommitId: error.commitId,
    spaceId: error.spaceId,
  })
}

function statusForSurfaceActionError(error: SurfaceActionError): number {
  if (error.code === 'unknown_surface') return 404
  if (
    error.code === 'stale_action' ||
    error.code === 'intent_conflict' ||
    error.code === 'idempotency_conflict'
  )
    return 409
  if (
    error.code === 'invalid_payload' ||
    error.code === 'missing_target' ||
    error.code === 'preflight_rejected'
  )
    return 400
  return 403
}
