import type { PendingDecision, PendingDecisionResolution } from '@veduta/protocol'
import { PendingDecisionListSchema, PendingDecisionResolveResultSchema } from '@veduta/protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPendingDecisionRoutes } from './pending-decision-routes.ts'
import { PendingDecisionService, type PendingDecisionAdapter } from './pending-decision-service.ts'

class RecordingAdapter implements PendingDecisionAdapter {
  readonly kind = 'approval' as const
  decision: PendingDecision = {
    id: 'approval:effect-1',
    kind: 'approval',
    summary: 'Send a message',
    scope: { type: 'space', spaceId: 'spc-work' },
    allowedResolutions: ['approve', 'reject'],
    state: 'pending',
    decisionSurfaceId: 'srf-approval-effect-1',
    createdAt: '2026-08-16T08:00:00.000Z',
  }
  resolutions: {
    id: string
    resolution: PendingDecisionResolution
    actor: 'trusted:user'
  }[] = []

  list(): PendingDecision[] {
    return [this.decision]
  }

  get(id: string): PendingDecision | undefined {
    return id === this.decision.id ? this.decision : undefined
  }

  resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): PendingDecision {
    this.resolutions.push({ id, resolution, actor })
    this.decision = {
      ...this.decision,
      state: 'terminal',
      outcome: resolution === 'approve' ? 'executed' : 'rejected',
      resolvedAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: actor,
    }
    return this.decision
  }
}

let apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()))
  apps = []
})

function buildApp(adapter = new RecordingAdapter()): {
  app: FastifyInstance
  adapter: RecordingAdapter
} {
  const app = Fastify()
  apps.push(app)
  registerPendingDecisionRoutes(app, {
    service: new PendingDecisionService({ adapters: [adapter] }),
  })
  return { app, adapter }
}

describe('Pending decision routes', () => {
  it('lists the validated channel-neutral contract', async () => {
    const { app } = buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/pending-decisions' })

    expect(response.statusCode).toBe(200)
    expect(PendingDecisionListSchema.parse(response.json())).toMatchObject({
      decisions: [{ id: 'approval:effect-1', state: 'pending' }],
    })
  })

  it('resolves the exact id through the service as trusted:user', async () => {
    const { app, adapter } = buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/pending-decisions/approval%3Aeffect-1/resolve',
      payload: { resolution: 'approve' },
    })

    expect(response.statusCode).toBe(200)
    expect(PendingDecisionResolveResultSchema.parse(response.json())).toMatchObject({
      decision: { id: 'approval:effect-1', state: 'terminal', outcome: 'executed' },
      replayed: false,
    })
    expect(adapter.resolutions).toEqual([
      { id: 'approval:effect-1', resolution: 'approve', actor: 'trusted:user' },
    ])
  })

  it('rejects malformed, disallowed, and unknown resolution requests', async () => {
    const { app, adapter } = buildApp()

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/pending-decisions/approval%3Aeffect-1/resolve',
      payload: { resolution: 'invented' },
    })
    expect(malformed.statusCode).toBe(400)

    const disallowed = await app.inject({
      method: 'POST',
      url: '/api/pending-decisions/approval%3Aeffect-1/resolve',
      payload: { resolution: 'apply' },
    })
    expect(disallowed.statusCode).toBe(409)

    const missing = await app.inject({
      method: 'POST',
      url: '/api/pending-decisions/approval%3Amissing/resolve',
      payload: { resolution: 'approve' },
    })
    expect(missing.statusCode).toBe(404)
    expect(adapter.resolutions).toEqual([])
  })
})
