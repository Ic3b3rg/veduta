// @vitest-environment jsdom
import type { ChatMessage, PendingDecision } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchPendingDecisions: vi.fn(),
}))

import { fetchPendingDecisions, type SpaceWithSurfaces } from './api.ts'
import { usePendingDecisionController } from './use-pending-decision-controller.ts'

const firstDecision = decision('approval:first')
const secondDecision = decision('approval:second')

function useHarness(
  options: {
    spaces?: SpaceWithSurfaces[]
    focusedSpaceId?: string
    onRevealSurface?: (spaceSlug: string, surfaceId: string) => void
  } = {},
) {
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>([])
  const controller = usePendingDecisionController({
    authToken: 'token',
    spaces: [],
    focusedSpaceId: undefined,
    setChatEntries,
    onUnauthorized: vi.fn(),
    onReplaceSpaces: vi.fn(),
    onRevealSurface: vi.fn(),
    wasRevealShown: () => false,
    onError: vi.fn(),
    ...options,
  })
  return { ...controller, chatEntries }
}

beforeEach(() => {
  vi.mocked(fetchPendingDecisions).mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('usePendingDecisionController', () => {
  it.each(['surface-first', 'decision-first'])(
    'reveals a decision in the current Space without changing the route (%s)',
    (order) => {
      const onRevealSurface = vi.fn()
      const spaces = [decisionSpace()]
      const { result, rerender } = renderHook(
        ({ spaces }) => useHarness({ spaces, focusedSpaceId: 'spc-health', onRevealSurface }),
        { initialProps: { spaces: order === 'surface-first' ? spaces : [] } },
      )

      act(() => {
        result.current.observeProjectedDecisions([spaceDecision])
        result.current.registerLiveTurn(decisionTurn(), 'pwa-1', new Set(['turn-1']))
      })
      if (order === 'decision-first') rerender({ spaces })

      expect(result.current.revealKeys).toEqual({
        'srf-decision-meals': JSON.stringify(['pwa-1', 'turn-1', 'srf-decision-meals']),
      })
      expect(onRevealSurface).not.toHaveBeenCalled()
    },
  )

  it('opens the owning Space once when its Decision Surface is outside the current route', () => {
    const onRevealSurface = vi.fn()
    const { result } = renderHook(() => useHarness({ spaces: [decisionSpace()], onRevealSurface }))
    act(() => {
      result.current.observeProjectedDecisions([spaceDecision])
      result.current.registerLiveTurn(decisionTurn(), 'pwa-1', new Set(['turn-1']))
    })
    act(() => result.current.registerLiveTurn(decisionTurn(), 'pwa-1', new Set(['turn-1'])))
    expect(onRevealSurface).toHaveBeenCalledExactlyOnceWith('health', 'srf-decision-meals')
  })

  it('keeps a dismissed decision hidden when a later snapshot still reports it as pending', async () => {
    vi.mocked(fetchPendingDecisions)
      .mockResolvedValueOnce({ revision: 1, decisions: [firstDecision] })
      .mockResolvedValueOnce({ revision: 2, decisions: [firstDecision, secondDecision] })
    const { result } = renderHook(useHarness)

    act(() => result.current.refreshPendingDecisionSnapshot())
    await waitFor(() => expect(result.current.decisions).toEqual([firstDecision]))

    act(() => result.current.dismiss(firstDecision.id))
    expect(result.current.decisions).toEqual([])
    expect(result.current.dismissedDecisionIds).toEqual(new Set([firstDecision.id]))

    act(() => result.current.refreshPendingDecisionSnapshot())
    await waitFor(() => expect(result.current.decisions).toEqual([secondDecision]))
    expect(fetchPendingDecisions).toHaveBeenCalledTimes(2)
  })
})

const spaceDecision: PendingDecision = {
  ...decision('tree-proposal:meals'),
  kind: 'tree-proposal',
  scope: { type: 'space', spaceId: 'spc-health' },
  decisionSurfaceId: 'srf-decision-meals',
  allowedResolutions: ['accept', 'reject'],
}

function decisionSpace(): SpaceWithSurfaces {
  return fromPartial<SpaceWithSurfaces>({
    id: 'spc-health',
    slug: 'health',
    archived: false,
    surfaces: [{ id: 'srf-decision-meals', spaceId: 'spc-health' }],
  })
}

function decisionTurn() {
  return {
    type: 'chat.turn-replace' as const,
    turnId: 'turn-1',
    spaceId: 'spc-health',
    message: {
      role: 'assistant' as const,
      text: 'Review Meals.',
      pendingDecisions: [spaceDecision],
    },
  }
}

function decision(id: string): PendingDecision {
  return {
    id,
    kind: 'approval',
    summary: id,
    scope: { type: 'global' },
    allowedResolutions: ['approve', 'reject'],
    state: 'pending',
    createdAt: '2026-08-28T10:00:00.000Z',
  }
}
