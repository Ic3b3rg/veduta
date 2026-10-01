import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AgentActionInvocationSchema,
  AgentActionResultSchema,
  AgentActionTurnSchema,
  GatewayServerMessageSchema,
  RenderableGatewayServerMessageSchema,
  type AgentActionTurn,
} from './index.ts'

const identity = {
  id: 'agent-turn-1',
  spaceId: 'spc-work',
  surfaceId: 'srf-review',
  atomId: 'review',
  actionName: 'click',
  idempotencyKey: '1665f51c-2b8d-486c-93f7-9b6d6f3d8a4b',
}
const message = {
  role: 'assistant',
  text: 'Updated the current review.',
  targets: [
    {
      spaceId: identity.spaceId,
      spaceSlug: 'work',
      spaceName: 'Work',
      surfaceId: identity.surfaceId,
      surfaceTitle: 'Review',
    },
  ],
}

describe('Agent Action turn outcome protocol', () => {
  it.each([
    { status: 'queued' },
    { status: 'running' },
    { status: 'completed', message, surfaceCursor: 12 },
    { status: 'failed', error: 'The model connection is unavailable.' },
  ])(
    'round-trips an honest $status outcome through HTTP and both Gateway projections',
    (outcome) => {
      const turn = { ...identity, ...outcome }
      expect(AgentActionTurnSchema.parse(JSON.parse(JSON.stringify(turn)))).toEqual(turn)
      expect(AgentActionResultSchema.parse({ turn })).toEqual({ turn })
      const frame = { type: 'surface.action-turn', turn }
      expect(GatewayServerMessageSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame)
      expect(RenderableGatewayServerMessageSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(
        frame,
      )
    },
  )

  it.each([
    { status: 'queued', message },
    { status: 'running', error: 'Not terminal yet' },
    { status: 'completed', surfaceCursor: 12 },
    { status: 'completed', message, surfaceCursor: 12, error: 'A conflicting failure' },
    { status: 'completed', message: { ...message, role: 'user' }, surfaceCursor: 12 },
    {
      status: 'completed',
      surfaceCursor: 12,
      message: {
        ...message,
        targets: [
          { spaceId: 'spc-work', spaceSlug: 'work', spaceName: 'Work', surfaceId: 'srf-review' },
        ],
      },
    },
    { status: 'failed' },
    { status: 'failed', error: '' },
    { status: 'failed', error: 503 },
    { status: 'failed', error: 'Failed', message },
    { status: 'finished', message },
  ])('rejects an ambiguous or malformed completion %#', (outcome) => {
    expect(AgentActionTurnSchema.safeParse({ ...identity, ...outcome }).success).toBe(false)
  })

  it.each([undefined, -1, 0.5, '12', null])(
    'rejects a completed turn without a valid Surface cursor: %s',
    (surfaceCursor) => {
      const parsed = AgentActionTurnSchema.safeParse({
        ...identity,
        status: 'completed',
        message,
        ...(surfaceCursor === undefined ? {} : { surfaceCursor }),
      })
      expect(parsed.success).toBe(false)
      if (parsed.success) return
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['surfaceCursor'] }),
      )
    },
  )

  it('preserves zero as the completion cursor when the Agent has not emitted Surface writes', () => {
    const turn = { ...identity, status: 'completed', message, surfaceCursor: 0 }
    expect(AgentActionResultSchema.parse({ turn })).toEqual({ turn })
    expect(
      RenderableGatewayServerMessageSchema.parse({ type: 'surface.action-turn', turn }),
    ).toEqual({ type: 'surface.action-turn', turn })
  })

  it.each(['queued', 'running', 'failed'])('rejects completion metadata on a %s turn', (status) => {
    expect(
      AgentActionTurnSchema.safeParse({
        ...identity,
        status,
        ...(status === 'failed' ? { error: 'Failed' } : {}),
        surfaceCursor: 12,
      }).success,
    ).toBe(false)
  })

  it.each(['surface', 'atom', 'payload', 'contentOrigin', 'unrecognized'])(
    'rejects private queue field %s from the public summary',
    (field) => {
      expect(
        AgentActionTurnSchema.safeParse({ ...identity, status: 'queued', [field]: {} }).success,
      ).toBe(false)
    },
  )

  it.each(['id', 'spaceId', 'surfaceId', 'atomId', 'actionName'])(
    'requires the correlation field %s',
    (field) => {
      expect(
        AgentActionTurnSchema.safeParse({ ...identity, status: 'queued', [field]: '' }).success,
      ).toBe(false)
    },
  )

  it('preserves the invocation identity and optional legacy compatibility without normalization', () => {
    const invocation = {
      nodeId: identity.atomId,
      name: identity.actionName,
      payload: { review: true },
      idempotencyKey: identity.idempotencyKey,
    }
    expect(AgentActionInvocationSchema.parse(JSON.parse(JSON.stringify(invocation)))).toEqual(
      invocation,
    )
    const turn = AgentActionTurnSchema.parse({ ...identity, status: 'queued' })
    expect(turn.idempotencyKey).toBe(invocation.idempotencyKey)
    const { idempotencyKey: _key, ...legacy } = identity
    expect(AgentActionTurnSchema.parse({ ...legacy, status: 'queued' })).toEqual({
      ...legacy,
      status: 'queued',
    })
    expect(
      AgentActionInvocationSchema.parse({ nodeId: identity.atomId, name: identity.actionName }),
    ).toEqual({ nodeId: identity.atomId, name: identity.actionName })
    expect(
      AgentActionInvocationSchema.safeParse({ ...invocation, idempotencyKey: '' }).success,
    ).toBe(false)
    expect(
      AgentActionInvocationSchema.safeParse({ ...invocation, idempotencyKey: 'a'.repeat(129) })
        .success,
    ).toBe(false)
    expect(
      AgentActionTurnSchema.safeParse({
        ...identity,
        status: 'queued',
        idempotencyKey: 'a'.repeat(129),
      }).success,
    ).toBe(false)
  })

  it('rejects a response that mixes its typed turn with an unrelated outcome', () => {
    expect(
      AgentActionResultSchema.safeParse({
        turn: { ...identity, status: 'queued' },
        completed: true,
      }).success,
    ).toBe(false)
  })

  it('narrows terminal completion data in the public inferred type', () => {
    type Completed = Extract<AgentActionTurn, { status: 'completed' }>
    type Failed = Extract<AgentActionTurn, { status: 'failed' }>
    expectTypeOf<Completed['message']['role']>().toEqualTypeOf<'assistant'>()
    expectTypeOf<Completed['surfaceCursor']>().toEqualTypeOf<number>()
    expectTypeOf<Failed['error']>().toEqualTypeOf<string>()
  })
})
