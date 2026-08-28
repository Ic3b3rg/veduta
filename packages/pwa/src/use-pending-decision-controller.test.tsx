// @vitest-environment jsdom
import type { ChatMessage, PendingDecision } from '@veduta/protocol'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchPendingDecisions: vi.fn(),
}))

import { fetchPendingDecisions } from './api.ts'
import { usePendingDecisionController } from './use-pending-decision-controller.ts'

const firstDecision = decision('approval:first')
const secondDecision = decision('approval:second')

function useHarness() {
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>([])
  const controller = usePendingDecisionController({
    authToken: 'token',
    spaces: [],
    focusedSpaceId: undefined,
    focusedSurfaceId: undefined,
    setChatEntries,
    onUnauthorized: vi.fn(),
    onReplaceSpaces: vi.fn(),
    onRevealSurface: vi.fn(),
    wasRevealShown: () => false,
    onError: vi.fn(),
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
