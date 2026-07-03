import { describe, expect, it } from 'vitest'
import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
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
        },
      }).success,
    ).toBe(true)
  })
})
