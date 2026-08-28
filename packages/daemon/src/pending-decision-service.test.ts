import type {
  PendingDecision,
  PendingDecisionKind,
  PendingDecisionResolution,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  PendingDecisionActorError,
  PendingDecisionNotFoundError,
  PendingDecisionResolutionError,
  PendingDecisionService,
  type PendingDecisionAdapter,
} from './pending-decision-service.ts'

function pendingApproval(): PendingDecision {
  return {
    id: 'approval:effect-1',
    kind: 'approval',
    summary: 'Send message to alice@example.com',
    scope: { type: 'space', spaceId: 'spc-work' },
    allowedResolutions: ['approve', 'reject'],
    state: 'pending',
    decisionSurfaceId: 'srf-approval-effect-1',
    createdAt: '2026-08-16T08:00:00.000Z',
  }
}

class RecordingAdapter implements PendingDecisionAdapter {
  readonly kind: PendingDecisionKind = 'approval'
  decision: PendingDecision = pendingApproval()
  resolveCalls = 0
  actors: string[] = []

  list(): PendingDecision[] {
    return [this.decision]
  }

  get(id: string): PendingDecision | undefined {
    return id === this.decision.id ? this.decision : undefined
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> {
    this.resolveCalls += 1
    this.actors.push(actor)
    await Promise.resolve()
    this.decision = {
      ...this.decision,
      id,
      state: 'terminal',
      outcome: resolution === 'approve' ? 'executed' : 'rejected',
      resolvedAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: actor,
    }
    return this.decision
  }
}

describe('PendingDecisionService', () => {
  it('reads one exact authoritative decision from its owning workflow', async () => {
    const service = new PendingDecisionService({ adapters: [new RecordingAdapter()] })

    await expect(service.get('approval:effect-1')).resolves.toEqual(pendingApproval())
    await expect(service.get('approval:missing')).resolves.toBeUndefined()
    await expect(service.get('not-a-pending-decision')).resolves.toBeUndefined()
  })

  it('lists validated decisions from every registered workflow adapter', async () => {
    const approval = new RecordingAdapter()
    const tree: PendingDecisionAdapter = {
      kind: 'tree-proposal',
      list: () => [
        {
          id: 'tree-proposal:7',
          kind: 'tree-proposal',
          summary: 'Change the Weekly plan layout',
          scope: { type: 'space', spaceId: 'spc-work' },
          allowedResolutions: ['accept', 'reject'],
          state: 'pending',
          decisionSurfaceId: 'srf-tree-proposal-7',
          createdAt: '2026-08-16T08:02:00.000Z',
        },
      ],
      get: () => undefined,
      resolve: () => {
        throw new Error('not reached')
      },
    }
    const service = new PendingDecisionService({ adapters: [approval, tree] })

    await expect(service.list()).resolves.toMatchObject({
      decisions: [{ id: 'tree-proposal:7' }, { id: 'approval:effect-1' }],
    })
  })

  it('resolves an allowed exact id as trusted:user and returns the authoritative decision', async () => {
    const adapter = new RecordingAdapter()
    const service = new PendingDecisionService({ adapters: [adapter] })
    const lifecycle: { revision: number; decision: PendingDecision }[] = []
    service.onLifecycle((event) => lifecycle.push(event))
    await service.list()

    await expect(service.resolve('approval:effect-1', 'approve', 'trusted:user')).resolves.toEqual({
      decision: expect.objectContaining({
        id: 'approval:effect-1',
        state: 'terminal',
        outcome: 'executed',
        resolvedBy: 'trusted:user',
      }),
      replayed: false,
    })
    expect(adapter.actors).toEqual(['trusted:user'])
    expect(lifecycle).toMatchObject([
      { revision: 1, decision: { id: 'approval:effect-1', outcome: 'executed' } },
    ])
  })

  it('publishes externally-owned lifecycle changes once and exposes the matching revision', async () => {
    const adapter = new RecordingAdapter()
    const service = new PendingDecisionService({ adapters: [adapter] })
    const lifecycle: { revision: number; decision: PendingDecision }[] = []
    service.onLifecycle((event) => lifecycle.push(event))

    await expect(service.list()).resolves.toMatchObject({ revision: 0 })
    adapter.decision = {
      ...adapter.decision,
      state: 'resolving',
      decisionAt: '2026-08-16T08:00:30.000Z',
      resolvedBy: 'trusted:user',
    }
    await service.refresh()
    adapter.decision = {
      ...adapter.decision,
      state: 'terminal',
      outcome: 'failed',
      resolvedAt: '2026-08-16T08:01:00.000Z',
    }
    await service.refresh()
    await service.refresh()

    expect(lifecycle).toMatchObject([
      { revision: 1, decision: { state: 'resolving' } },
      { revision: 2, decision: { state: 'terminal', outcome: 'failed' } },
    ])
    await expect(service.list()).resolves.toMatchObject({
      revision: 2,
      decisions: [{ state: 'terminal', outcome: 'failed' }],
    })
  })

  it('rejects unknown ids, disallowed verbs, and every non-user actor before delegation', async () => {
    const adapter = new RecordingAdapter()
    const service = new PendingDecisionService({ adapters: [adapter] })

    await expect(
      service.resolve('approval:missing', 'approve', 'trusted:user'),
    ).rejects.toBeInstanceOf(PendingDecisionNotFoundError)
    await expect(
      service.resolve('approval:effect-1', 'apply', 'trusted:user'),
    ).rejects.toBeInstanceOf(PendingDecisionResolutionError)
    await expect(
      service.resolve('approval:effect-1', 'approve', 'untrusted:web'),
    ).rejects.toBeInstanceOf(PendingDecisionActorError)
    expect(adapter.resolveCalls).toBe(0)
  })

  it('coalesces competing resolutions and replays the winner without a second workflow effect', async () => {
    const adapter = new RecordingAdapter()
    const service = new PendingDecisionService({ adapters: [adapter] })

    const [approve, reject] = await Promise.all([
      service.resolve('approval:effect-1', 'approve', 'trusted:user'),
      service.resolve('approval:effect-1', 'reject', 'trusted:user'),
    ])

    expect(adapter.resolveCalls).toBe(1)
    expect(approve.decision).toEqual(reject.decision)
    expect([approve.replayed, reject.replayed].sort()).toEqual([false, true])

    await expect(service.resolve('approval:effect-1', 'reject', 'trusted:user')).resolves.toEqual({
      decision: approve.decision,
      replayed: true,
    })
    expect(adapter.resolveCalls).toBe(1)
  })
})
