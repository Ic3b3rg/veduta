// @vitest-environment jsdom
import type {
  ApprovalCard,
  ChatMessage,
  PendingDecision,
  PendingDecisionLifecycleMessage,
  PendingDecisionList,
} from '@veduta/protocol'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchPendingDecisions: vi.fn(),
}))

import { ApiResponseError, fetchPendingDecisions } from './api.ts'
import { usePendingDecisionSync } from './use-pending-decision-sync.ts'

const pending: PendingDecision = {
  id: 'approval:effect-1',
  kind: 'approval',
  summary: 'Send message to alice@example.com',
  scope: { type: 'space', spaceId: 'spc-health' },
  allowedResolutions: ['approve', 'reject'],
  state: 'pending',
  decisionSurfaceId: 'srf-approval-1',
  createdAt: '2026-08-25T10:00:00.000Z',
}

const resolving: PendingDecision = {
  ...pending,
  state: 'resolving',
  decisionAt: '2026-08-25T10:01:00.000Z',
  resolvedBy: 'trusted:user',
}

const terminal: PendingDecision = {
  ...resolving,
  state: 'terminal',
  outcome: 'executed',
  resolvedAt: '2026-08-25T10:01:01.000Z',
}

const approvalCard: ApprovalCard = {
  id: 'effect-1',
  level: 'L1',
  title: 'Send message',
  body: 'To: alice@example.com',
  actionLabel: 'Review',
  createdAt: pending.createdAt,
  surfaceId: 'srf-approval-1',
  expiresAt: '2026-08-25T10:30:00.000Z',
}

function lifecycle(revision: number, decision: PendingDecision): PendingDecisionLifecycleMessage {
  const lead = decision.state === 'pending' ? 'Awaiting your decision' : 'Outcome'
  return {
    type: 'pending-decision.lifecycle',
    revision,
    decision,
    message: `${lead}: ${decision.summary}.`,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function useHarness(onUnauthorized: () => void) {
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>([])
  const [approvalCards, setApprovalCards] = useState<ApprovalCard[]>([approvalCard])
  const sync = usePendingDecisionSync({
    authToken: 'token',
    setChatEntries,
    setApprovalCards,
    onUnauthorized,
  })
  return { ...sync, chatEntries, approvalCards }
}

beforeEach(() => {
  vi.mocked(fetchPendingDecisions).mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('usePendingDecisionSync', () => {
  it('buffers live frames during a snapshot and applies only revisions newer than it', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const { result } = renderHook(() => useHarness(vi.fn()))

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.handlePendingDecisionLifecycle(lifecycle(3, terminal))
      result.current.handlePendingDecisionLifecycle(lifecycle(2, resolving))
    })
    await act(async () => snapshot.resolve({ revision: 1, decisions: [pending] }))

    expect(result.current.chatEntries).toHaveLength(1)
    expect(result.current.chatEntries[0]).toMatchObject({
      decisionFeedbackId: terminal.id,
      pendingDecisions: [terminal],
    })
    expect(result.current.approvalCards).toEqual([])

    const settled = result.current.chatEntries
    act(() => result.current.handlePendingDecisionLifecycle(lifecycle(2, resolving)))
    expect(result.current.chatEntries).toBe(settled)
  })

  it('drops a cancelled snapshot and every frame buffered for that generation', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const { result } = renderHook(() => useHarness(vi.fn()))

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.handlePendingDecisionLifecycle(lifecycle(1, terminal))
      result.current.cancelPendingDecisionSnapshot()
    })
    await act(async () => snapshot.resolve({ revision: 1, decisions: [terminal] }))

    expect(result.current.chatEntries).toEqual([])
    expect(result.current.approvalCards).toEqual([approvalCard])
  })

  it('drops buffered state and resets the session when the snapshot is unauthorized', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const onUnauthorized = vi.fn()
    const { result } = renderHook(() => useHarness(onUnauthorized))

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.handlePendingDecisionLifecycle(lifecycle(1, terminal))
    })
    await act(async () => snapshot.reject(new ApiResponseError('unauthorized', 401)))

    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(result.current.chatEntries).toEqual([])
  })

  it('replays buffered lifecycle truth when a non-auth snapshot request fails', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useHarness(vi.fn()))

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.handlePendingDecisionLifecycle(lifecycle(1, terminal))
    })
    await act(async () => snapshot.reject(new Error('offline')))

    await waitFor(() => expect(result.current.chatEntries).toHaveLength(1))
    expect(result.current.chatEntries[0]?.pendingDecisions).toEqual([terminal])
    expect(warn).toHaveBeenCalledWith('failed to refresh Pending decisions:', expect.any(Error))
  })
})
