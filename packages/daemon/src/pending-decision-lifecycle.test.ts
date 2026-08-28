import type { PendingDecision, PendingDecisionLifecycleMessage } from '@veduta/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { PendingDecisionLifecycleEvent } from './pending-decision-service.ts'
import { startPendingDecisionLifecycle } from './pending-decision-lifecycle.ts'

const resolving: PendingDecision = {
  id: 'approval:effect-1',
  kind: 'approval',
  summary: 'Send message to alice@example.com',
  scope: { type: 'space', spaceId: 'spc-work' },
  allowedResolutions: ['approve', 'reject'],
  state: 'resolving',
  createdAt: '2026-08-25T10:00:00.000Z',
  decisionAt: '2026-08-25T10:01:00.000Z',
  resolvedBy: 'trusted:user',
}

describe('startPendingDecisionLifecycle', () => {
  it('refreshes workflow changes, broadcasts safe feedback, and disposes every subscription', () => {
    let lifecycleListener: ((event: PendingDecisionLifecycleEvent) => void) | undefined
    let trustListener: (() => void) | undefined
    let surfaceListener: (() => void) | undefined
    const refresh = vi.fn(async () => undefined)
    const broadcast = vi.fn<(lifecycle: Omit<PendingDecisionLifecycleMessage, 'type'>) => void>()
    const disposers = [vi.fn(), vi.fn(), vi.fn()]

    const dispose = startPendingDecisionLifecycle({
      decisions: {
        refresh,
        onLifecycle(listener) {
          lifecycleListener = listener
          return disposers[0]!
        },
      },
      gateway: { broadcastPendingDecision: broadcast },
      trust: {
        onChange(listener) {
          trustListener = listener
          return disposers[1]!
        },
      },
      store: {
        onSurfaceEvent(listener) {
          surfaceListener = listener
          return disposers[2]!
        },
      },
    })

    expect(refresh).toHaveBeenCalledOnce()
    lifecycleListener?.({ revision: 3, decision: resolving })
    expect(broadcast).toHaveBeenCalledWith({
      revision: 3,
      decision: resolving,
      message: 'In progress: Send message to alice@example.com.',
    })

    trustListener?.()
    surfaceListener?.()
    expect(refresh).toHaveBeenCalledTimes(3)

    dispose()
    for (const unsubscribe of disposers) expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
