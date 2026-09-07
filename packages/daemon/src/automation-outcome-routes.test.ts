import type {
  AutomationOutcomeNotification,
  AutomationOutcomeNotificationActionResult,
  AutomationOutcomeNotificationSnapshot,
} from '@veduta/protocol'
import {
  AutomationOutcomeNotificationActionResultSchema,
  AutomationOutcomeNotificationSnapshotSchema,
} from '@veduta/protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAutomationOutcomeRoutes } from './automation-outcome-routes.ts'
import { AutomationOutcomeUnavailableError } from './automation-outcome-service.ts'

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('Automation outcome routes', () => {
  it('lists one Space snapshot and confirms open and dismiss mutations', async () => {
    const service = new RecordingService()
    const app = Fastify()
    apps.push(app)
    registerAutomationOutcomeRoutes(app, { service })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/spaces/spc-health/automation-outcome-notifications',
    })
    expect(listed.statusCode).toBe(200)
    expect(AutomationOutcomeNotificationSnapshotSchema.parse(listed.json())).toMatchObject({
      revision: 1,
      notifications: [{ id: 'aon-1', state: 'unread' }],
    })

    for (const action of ['open', 'dismiss'] as const) {
      service.notification = { ...service.notification, state: 'unread' }
      const response = await app.inject({
        method: 'POST',
        url: `/api/spaces/spc-health/automation-outcome-notifications/aon-1/${action}`,
      })
      expect(response.statusCode).toBe(200)
      expect(AutomationOutcomeNotificationActionResultSchema.parse(response.json())).toMatchObject({
        notification: { state: action === 'open' ? 'opened' : 'dismissed' },
      })
    }
    expect(service.actions).toEqual([
      ['open', 'spc-health', 'aon-1', 'trusted:user'],
      ['dismiss', 'spc-health', 'aon-1', 'trusted:user'],
    ])
  })

  it('does not reveal whether an inaccessible notification exists', async () => {
    const app = Fastify()
    apps.push(app)
    registerAutomationOutcomeRoutes(app, { service: new RecordingService() })

    const response = await app.inject({
      method: 'POST',
      url: '/api/spaces/spc-other/automation-outcome-notifications/aon-1/open',
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Automation outcome is unavailable in this Space' })
  })
})

class RecordingService {
  notification: AutomationOutcomeNotification = {
    id: 'aon-1',
    revision: 1,
    spaceId: 'spc-health',
    spaceSlug: 'health',
    automationId: 2,
    surfaceId: 'srf-plan',
    kind: 'changed',
    title: 'Plan updated',
    summary: 'Two new entries',
    coalesceKey: 'entries',
    occurrenceCount: 1,
    state: 'unread',
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    href: '/app/space/health/surface/srf-plan',
  }
  actions: [string, string, string, string][] = []

  list(spaceId: string): AutomationOutcomeNotificationSnapshot {
    if (spaceId !== this.notification.spaceId) throw new AutomationOutcomeUnavailableError()
    return { revision: this.notification.revision, notifications: [this.notification] }
  }

  open(
    spaceId: string,
    id: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    this.actions.push(['open', spaceId, id, actor])
    return this.transition(spaceId, id, 'opened')
  }

  dismiss(
    spaceId: string,
    id: string,
    actor: 'trusted:user',
  ): AutomationOutcomeNotificationActionResult {
    this.actions.push(['dismiss', spaceId, id, actor])
    return this.transition(spaceId, id, 'dismissed')
  }

  private transition(
    spaceId: string,
    id: string,
    state: 'opened' | 'dismissed',
  ): AutomationOutcomeNotificationActionResult {
    if (spaceId !== this.notification.spaceId || id !== this.notification.id) {
      throw new AutomationOutcomeUnavailableError()
    }
    this.notification = { ...this.notification, revision: this.notification.revision + 1, state }
    return { revision: this.notification.revision, notification: this.notification }
  }
}
