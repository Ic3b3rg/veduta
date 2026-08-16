import { describe, expect, it } from 'vitest'
import {
  ApprovalCardSchema,
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfacePatchEventSchema,
  SurfacePinnedEventSchema,
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

  it('preserves an exact initiating chat turn only on the live surface.created frame', () => {
    const event = SurfaceCreatedEventSchema.parse({
      cursor: 2,
      at: '2026-07-03T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        id: 'srf-groceries',
        spaceId: 'spc-health',
        title: 'Groceries',
        tree: { id: 'root', type: 'Box' },
        state: {},
        freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'agent' },
      },
    })
    const frame = {
      type: 'surface.created' as const,
      event,
      initiatingTurn: { clientId: 'pwa-1', turnId: 'trn-1' },
    }

    expect(GatewayServerMessageSchema.parse(frame)).toEqual(frame)
    expect(
      GatewayServerMessageSchema.safeParse({
        ...frame,
        initiatingTurn: { turnId: 'trn-1' },
      }).success,
    ).toBe(false)
    expect(
      GatewayServerMessageSchema.safeParse({
        ...frame,
        initiatingTurn: { clientId: 'pwa-1' },
      }).success,
    ).toBe(false)
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

  it('accepts a surface.pinned message for a pin toggle, carrying the bumped freshness', () => {
    const event = SurfacePinnedEventSchema.parse({
      cursor: 4,
      at: '2026-07-03T10:00:00.000Z',
      spaceId: 'spc-health',
      surfaceId: 'srf-groceries',
      pinned: true,
      freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'user' },
    })

    expect(GatewayServerMessageSchema.parse({ type: 'surface.pinned', event })).toEqual({
      type: 'surface.pinned',
      event,
    })
    expect(event.freshness).toEqual({ updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'user' })
  })

  it('rejects a surface.pinned message missing pinned', () => {
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'surface.pinned',
        event: {
          cursor: 4,
          at: '2026-07-03T10:00:00.000Z',
          spaceId: 'spc-health',
          surfaceId: 'srf-groceries',
          freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'user' },
        },
      }).success,
    ).toBe(false)
  })

  it('rejects a surface.pinned message missing freshness', () => {
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'surface.pinned',
        event: {
          cursor: 4,
          at: '2026-07-03T10:00:00.000Z',
          spaceId: 'spc-health',
          surfaceId: 'srf-groceries',
          pinned: true,
        },
      }).success,
    ).toBe(false)
  })

  it('accepts the streamed chat turn-lifecycle frames (issue 037)', () => {
    expect(
      GatewayServerMessageSchema.parse({
        type: 'chat.turn-start',
        turnId: 'trn-1',
        spaceId: 'spc-health',
      }),
    ).toEqual({
      type: 'chat.turn-start',
      turnId: 'trn-1',
      spaceId: 'spc-health',
    })

    expect(
      GatewayServerMessageSchema.parse({
        type: 'chat.turn-delta',
        turnId: 'trn-1',
        spaceId: 'spc-health',
        text: '',
      }),
    ).toEqual({
      type: 'chat.turn-delta',
      turnId: 'trn-1',
      spaceId: 'spc-health',
      text: '',
    })

    expect(
      GatewayServerMessageSchema.parse({
        type: 'chat.turn-end',
        turnId: 'trn-1',
        spaceId: 'spc-health',
        message: { role: 'assistant', text: 'Logged the pizza.' },
      }),
    ).toEqual({
      type: 'chat.turn-end',
      turnId: 'trn-1',
      spaceId: 'spc-health',
      message: { role: 'assistant', text: 'Logged the pizza.' },
    })

    expect(
      GatewayServerMessageSchema.parse({
        type: 'chat.turn-error',
        turnId: 'trn-1',
        spaceId: 'spc-health',
        error: 'provider unavailable',
      }),
    ).toEqual({
      type: 'chat.turn-error',
      turnId: 'trn-1',
      spaceId: 'spc-health',
      error: 'provider unavailable',
    })
  })

  it('accepts turn-lifecycle frames without spaceId (global chat has no Space)', () => {
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'chat.turn-start',
        turnId: 'trn-1',
      }).success,
    ).toBe(true)
  })

  it('rejects a chat.turn-delta missing turnId', () => {
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'chat.turn-delta',
        spaceId: 'spc-health',
        text: 'partial',
      }).success,
    ).toBe(false)
  })

  it('rejects a chat.turn-end with an invalid message', () => {
    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'chat.turn-end',
        turnId: 'trn-1',
        spaceId: 'spc-health',
        message: { role: 'narrator', text: 'not a valid role' },
      }).success,
    ).toBe(false)

    expect(
      GatewayServerMessageSchema.safeParse({
        type: 'chat.turn-end',
        turnId: 'trn-1',
        spaceId: 'spc-health',
        message: { role: 'assistant' },
      }).success,
    ).toBe(false)
  })
})
