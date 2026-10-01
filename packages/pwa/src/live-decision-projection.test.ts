import type {
  ChatMessage,
  PendingDecision,
  PendingDecisionLifecycleMessage,
  PendingDecisionList,
} from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchPendingDecisions: vi.fn(),
}))

import { ApiResponseError, fetchPendingDecisions, resolvePendingDecision } from './api.ts'
import { LiveDecisionProjection } from './live-decision-projection.ts'

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

function createHarness(onUnauthorized: () => void) {
  let chatEntries: ChatMessage[] = []
  const sync = new LiveDecisionProjection({
    api: { fetchPendingDecisions, resolvePendingDecision },
    token: () => 'token',
    publish: () => {},
    feedback: (update) => {
      chatEntries = update(chatEntries)
    },
    refreshSpaces: async () => {},
    failed: (error) => {
      if (error instanceof ApiResponseError && error.status === 401) {
        sync.cancel()
        onUnauthorized()
      } else console.warn('failed to refresh Pending decisions:', error)
    },
  })
  return {
    result: {
      get current() {
        return {
          chatEntries,
          decisions: sync.decisions,
          refreshPendingDecisionSnapshot: () => sync.refresh(),
          cancelPendingDecisionSnapshot: () => sync.cancel(),
          handlePendingDecisionLifecycle: (frame: PendingDecisionLifecycleMessage) =>
            sync.accept(frame),
          observeProjectedDecisions: (decisions: PendingDecision[]) => sync.observe(decisions),
        }
      },
    },
  }
}

function act<T>(fn: () => T): T {
  return fn()
}
const waitFor = vi.waitFor

beforeEach(() => {
  vi.mocked(fetchPendingDecisions).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime Pending-decision projection', () => {
  it('buffers live frames during a snapshot and applies only revisions newer than it', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const { result } = createHarness(vi.fn())

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
    expect(result.current.decisions).toEqual([terminal])

    const settled = result.current.chatEntries
    act(() => result.current.handlePendingDecisionLifecycle(lifecycle(2, resolving)))
    expect(result.current.chatEntries).toBe(settled)
  })

  it('keeps a live chat projection that arrives while an older snapshot is in flight', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const { result } = createHarness(vi.fn())

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.observeProjectedDecisions([pending])
    })
    expect(result.current.decisions).toEqual([pending])

    await act(async () => snapshot.resolve({ revision: 0, decisions: [] }))

    expect(result.current.decisions).toEqual([pending])
  })

  it('drops a cancelled snapshot and every frame buffered for that generation', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const { result } = createHarness(vi.fn())

    act(() => {
      result.current.refreshPendingDecisionSnapshot()
      result.current.handlePendingDecisionLifecycle(lifecycle(1, terminal))
      result.current.cancelPendingDecisionSnapshot()
    })
    await act(async () => snapshot.resolve({ revision: 1, decisions: [terminal] }))

    expect(result.current.chatEntries).toEqual([])
    expect(result.current.decisions).toEqual([])
  })

  it('drops buffered state and resets the session when the snapshot is unauthorized', async () => {
    const snapshot = deferred<PendingDecisionList>()
    vi.mocked(fetchPendingDecisions).mockReturnValueOnce(snapshot.promise)
    const onUnauthorized = vi.fn()
    const { result } = createHarness(onUnauthorized)

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
    const { result } = createHarness(vi.fn())

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
