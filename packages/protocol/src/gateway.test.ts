import { describe, expect, it } from 'vitest'
import {
  ApprovalCardSchema,
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfacePatchEventSchema,
} from './index.ts'

describe('Gateway protocol', () => {
  it('defaults hello replay cursors safely', () => {
    expect(GatewayClientMessageSchema.parse({ type: 'hello' })).toEqual({
      type: 'hello',
      surfaceCursor: 0,
    })
  })

  it('accepts pre-routed chat messages for a Space', () => {
    expect(
      GatewayClientMessageSchema.parse({
        type: 'chat.send',
        text: 'I ate a pizza',
        spaceId: 'spc-health',
      }),
    ).toEqual({
      type: 'chat.send',
      text: 'I ate a pizza',
      spaceId: 'spc-health',
    })
  })

  it('accepts typed Surface patch, presence and approval frames', () => {
    const event = SurfacePatchEventSchema.parse({
      cursor: 1,
      at: '2026-07-03T10:00:00.000Z',
      spaceId: 'spc-health',
      patch: {
        surfaceId: 'srf-groceries',
        operations: [{ target: 'state', op: 'replace', path: '/milk', value: true }],
      },
      freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'user' },
    })

    expect(GatewayServerMessageSchema.parse({ type: 'surface.patch', event })).toEqual({
      type: 'surface.patch',
      event,
    })
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'presence.update',
        presence: [
          {
            clientId: 'pwa-1',
            status: 'online',
            connectedAt: '2026-07-03T10:00:00.000Z',
            lastSeenAt: '2026-07-03T10:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'approval.card',
        card: {
          id: 'apv-1',
          level: 'L1',
          title: 'Send email',
          body: 'Prepared outbound action',
          actionLabel: 'Approve',
          createdAt: '2026-07-03T10:00:00.000Z',
          surfaceId: 'srf-apv-1',
          expiresAt: '2026-07-03T10:30:00.000Z',
        },
      }).success,
    ).toBe(true)
  })

  it('rejects an ApprovalCard missing surfaceId or expiresAt', () => {
    expect(
      ApprovalCardSchema.safeParse({
        id: 'apv-1',
        level: 'L1',
        title: 'Send email',
        body: 'Prepared outbound action',
        actionLabel: 'Approve',
        createdAt: '2026-07-03T10:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('accepts a surface.created message for a live Surface', () => {
    const surface = {
      id: 'srf-groceries',
      spaceId: 'spc-health',
      title: 'Groceries',
      tree: { id: 'root', type: 'Box' as const },
      state: {},
      freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'agent' as const },
    }
    const event = SurfaceCreatedEventSchema.parse({
      cursor: 2,
      at: '2026-07-03T10:00:00.000Z',
      spaceId: 'spc-health',
      surface,
    })

    expect(GatewayServerMessageSchema.parse({ type: 'surface.created', event })).toEqual({
      type: 'surface.created',
      event,
    })
  })

  it('accepts a surface.archived message for a retired Surface', () => {
    const event = SurfaceArchivedEventSchema.parse({
      cursor: 3,
      at: '2026-07-03T10:00:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-groceries',
    })

    expect(GatewayServerMessageSchema.parse({ type: 'surface.archived', event })).toEqual({
      type: 'surface.archived',
      event,
    })
  })
})
