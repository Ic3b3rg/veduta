// @vitest-environment jsdom
import { SurfaceCreatedEventSchema, type GatewayServerMessage } from '@veduta/protocol'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSurfaceCreationFeedback } from './surface-creation-feedback.ts'

type SurfaceCreatedMessage = Extract<GatewayServerMessage, { type: 'surface.created' }>

function createdMessage(
  id: string,
  initiatingTurn?: { clientId: string; turnId: string },
): SurfaceCreatedMessage {
  return {
    type: 'surface.created',
    event: SurfaceCreatedEventSchema.parse({
      cursor: 1,
      at: '2026-08-16T10:00:00.000Z',
      spaceId: 'spc-health',
      surface: {
        id,
        spaceId: 'spc-health',
        title: id,
        tree: { id: 'root', type: 'Box' },
        state: {},
        freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
      },
      order: {
        cursor: 1,
        spaceId: 'spc-health',
        pinnedSurfaceIds: [],
        regularSurfaceIds: [id],
      },
    }),
    ...(initiatingTurn === undefined ? {} : { initiatingTurn }),
  }
}

describe('useSurfaceCreationFeedback', () => {
  it('registers and acknowledges one exact local pending-turn creation', () => {
    const { result } = renderHook(useSurfaceCreationFeedback)
    const message = createdMessage('srf-created', { clientId: 'pwa-1', turnId: 'turn-1' })
    const pendingTurns = new Map([['turn-1', {}]])

    act(() => result.current.registerLiveCreation(message, 'pwa-1', pendingTurns))

    const feedbackKey = JSON.stringify(['pwa-1', 'turn-1', 'srf-created'])
    expect(result.current.feedbackKeys).toEqual({ 'srf-created': feedbackKey })

    const registered = result.current.feedbackKeys
    act(() => result.current.registerLiveCreation(message, 'pwa-1', pendingTurns))
    expect(result.current.feedbackKeys).toBe(registered)

    act(() => result.current.acknowledge('srf-created', feedbackKey))
    expect(result.current.feedbackKeys).toEqual({})
  })

  it('ignores background, other-client, and finished-turn creations', () => {
    const { result } = renderHook(useSurfaceCreationFeedback)
    const pendingTurns = new Map([['turn-live', {}]])

    act(() => {
      result.current.registerLiveCreation(createdMessage('srf-background'), 'pwa-1', pendingTurns)
      result.current.registerLiveCreation(
        createdMessage('srf-remote', { clientId: 'pwa-2', turnId: 'turn-live' }),
        'pwa-1',
        pendingTurns,
      )
      result.current.registerLiveCreation(
        createdMessage('srf-finished', { clientId: 'pwa-1', turnId: 'turn-finished' }),
        'pwa-1',
        pendingTurns,
      )
    })

    expect(result.current.feedbackKeys).toEqual({})
  })

  it('does not request a second reveal when another live source already showed the correlation', () => {
    const feedbackKey = JSON.stringify(['pwa-1', 'turn-1', 'srf-created'])
    const { result } = renderHook(() =>
      useSurfaceCreationFeedback((candidate) => candidate === feedbackKey),
    )

    act(() =>
      result.current.registerLiveCreation(
        createdMessage('srf-created', { clientId: 'pwa-1', turnId: 'turn-1' }),
        'pwa-1',
        new Map([['turn-1', {}]]),
      ),
    )

    expect(result.current.feedbackKeys).toEqual({})
  })
})
