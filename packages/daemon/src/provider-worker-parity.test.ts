import { SurfaceSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { runSubscriptionWorkerAbortScenario } from './provider-worker-abort-fixture.ts'
import { runSubscriptionWorkerIterationBudgetScenario } from './provider-worker-budget-fixture.ts'
import { runSubscriptionWorkerFailureNoReplayScenario } from './provider-worker-failure-fixture.ts'
import { runWorkerParityPair } from './provider-worker-parity-fixture.ts'

describe('AgentRunner Worker parity across Model connection methods (issue #78)', () => {
  it('spawns once, returns before delivery, and preserves the isolated reviewed report outcome', async () => {
    const { byok, subscription } = await runWorkerParityPair()

    expect(subscription.outcome).toEqual(byok.outcome)

    const outcome = subscription.outcome
    expect(outcome.definitions.chat.map((definition) => definition.name)).toEqual(['spawn_worker'])
    expect(outcome.definitions.worker.map((definition) => definition.name)).toEqual(['read_recent'])
    expect(outcome.definitions.review).toEqual([])
    expect(subscription.transport.threadStarts.map((start) => start.dynamicTools)).toEqual([
      outcome.definitions.chat,
      outcome.definitions.worker,
      outcome.definitions.review,
    ])

    expect(outcome.execution).toEqual({
      spawnCalls: 1,
      distinctSpawnCallIds: 1,
      maxSpawnCallsPerId: 1,
      workerToolCalls: 1,
      distinctWorkerToolCallIds: 1,
      maxWorkerToolCallsPerId: 1,
    })
    expect(outcome.returnedBeforeDelivery).toBe(true)
    expect(outcome.chatToolResult).toMatchObject({
      toolName: 'spawn_worker',
      content: expect.stringContaining('spawned worker wrk-parity'),
      details: { workerId: 'wrk-parity' },
      isError: false,
    })

    expect(SurfaceSchema.parse(outcome.activeSurface)).toEqual(outcome.activeSurface)
    expect(outcome.activeSurface.state['settled']).toBe(false)
    expect(SurfaceSchema.parse(outcome.terminalSurface)).toEqual(outcome.terminalSurface)
    expect(outcome.terminalSurface.state['settled']).toBe(true)
    expect(outcome.terminalSurface.tree.children?.[1]?.props?.['text']).toBe('Delivered')

    const spawned = outcome.eventLog.filter((event) => event.type === 'worker.spawned')
    const delivered = outcome.eventLog.filter((event) => event.type === 'worker.delivered')
    expect(spawned).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      origin: 'untrusted:worker',
      payload: {
        workerId: 'wrk-parity',
        partial: false,
        cancelled: false,
        reviewStatus: 'passed',
      },
    })

    expect(outcome.workerToolResults).toEqual([
      expect.objectContaining({
        toolName: 'read_recent',
        content: expect.stringContaining('Worker parity source note'),
        isError: false,
      }),
    ])
    expect(JSON.stringify(outcome.workerSessionEntries)).toContain('Worker parity source note')
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain('forty-eight hours')
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain('Reviewed Worker report')

    expect(outcome.reviewContext).toEqual({ messageCount: 1, messageRoles: ['user'], tools: [] })
    expect(outcome.routedCalls).toEqual([
      { purpose: 'chat-turn', origin: 'user', outcome: 'ok' },
      { purpose: 'worker', origin: 'proactive', workerId: 'wrk-parity', outcome: 'ok' },
      { purpose: 'worker', origin: 'proactive', workerId: 'wrk-parity', outcome: 'ok' },
    ])
    expect(outcome.usage.workers).toEqual([{ workerId: 'wrk-parity', spentUsd: 0 }])

    expect(subscription.connectionIds).toEqual([
      'c0ffee00-0000-4000-8000-000000000078',
      'c0ffee00-0000-4000-8000-000000000078',
      'c0ffee00-0000-4000-8000-000000000078',
    ])
    expect(
      subscription.transport.threadStarts.map(({ dynamicTools, ...start }) => ({
        ...start,
        dynamicTools: dynamicTools.map((definition) => definition.name),
      })),
    ).toEqual([
      {
        purpose: 'chat',
        dynamicTools: ['spawn_worker'],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        webSearch: 'disabled',
        nativeToolsDisabled: true,
      },
      {
        purpose: 'worker',
        dynamicTools: ['read_recent'],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        webSearch: 'disabled',
        nativeToolsDisabled: true,
      },
      {
        purpose: 'review',
        dynamicTools: [],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        webSearch: 'disabled',
        nativeToolsDisabled: true,
      },
    ])
  })

  it('does not replay a successful spawn after a provider failure or exhausted tier spend', async () => {
    const outcome = await runSubscriptionWorkerFailureNoReplayScenario()

    expect(outcome.attemptedConnectionIds).toEqual(['c0ffee00-0000-4000-8000-000000000078'])
    expect(outcome.fallbackCalls).toBe(0)
    expect(outcome.spawnCalls).toBe(1)
    expect(outcome.chatError).toContain('capacity')
    expect(outcome.dynamicToolSuccess).toEqual([true])
    expect(outcome.chatToolResults).toEqual([
      expect.objectContaining({
        toolName: 'spawn_worker',
        details: { workerId: 'wrk-failure' },
        isError: false,
      }),
    ])
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain('forty-eight hours')
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain(
      'No valid report was produced.',
    )
    expect(outcome.workerSessionEntries).toEqual([])

    expect(outcome.workerEvents.filter((event) => event.type === 'worker.spawned')).toHaveLength(1)
    const delivered = outcome.workerEvents.filter((event) => event.type === 'worker.delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      origin: 'untrusted:worker',
      payload: {
        workerId: 'wrk-failure',
        partial: true,
        cancelled: false,
      },
    })
  })

  it('stops the isolated subscription Worker at its iteration budget without replaying spawn', async () => {
    const outcome = await runSubscriptionWorkerIterationBudgetScenario()

    expect(outcome.spawnCalls).toBe(1)
    expect(outcome.workerToolCalls).toBe(5)
    expect(outcome.interruptCalls).toBe(1)
    expect(outcome.dynamicToolSuccess).toEqual([true, true, true, true, true])
    expect(outcome.connectionIds).toEqual([
      'c0ffee00-0000-4000-8000-000000000078',
      'c0ffee00-0000-4000-8000-000000000078',
    ])
    expect(SurfaceSchema.parse(outcome.terminalSurface)).toEqual(outcome.terminalSurface)
    expect(outcome.terminalSurface.tree.children?.[1]?.props?.['text']).toBe('Partial')

    expect(outcome.workerEvents.filter((event) => event.type === 'worker.spawned')).toHaveLength(1)
    const delivered = outcome.workerEvents.filter((event) => event.type === 'worker.delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      origin: 'untrusted:worker',
      payload: {
        workerId: 'wrk-budget',
        partial: true,
        cancelled: false,
      },
    })

    expect(JSON.stringify(outcome.workerSessionEntries)).toContain('Worker parity source note')
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain('forty-eight hours')
    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain(
      'No valid report was produced.',
    )
  })

  it('cancels the isolated subscription Worker without replaying spawn or leaking into chat', async () => {
    const outcome = await runSubscriptionWorkerAbortScenario()

    expect(outcome.spawnCalls).toBe(1)
    expect(outcome.chatCompletedBeforeCancel).toBe(true)
    expect(outcome.interruptCalls).toBe(1)
    expect(outcome.dynamicToolSuccess).toEqual([true])
    expect(SurfaceSchema.parse(outcome.terminalSurface)).toEqual(outcome.terminalSurface)
    expect(outcome.terminalSurface.tree.children?.[1]?.props?.['text']).toBe('Cancelled')

    expect(outcome.workerEvents.filter((event) => event.type === 'worker.spawned')).toHaveLength(1)
    expect(outcome.workerEvents.filter((event) => event.type === 'worker.cancelled')).toHaveLength(
      1,
    )
    const delivered = outcome.workerEvents.filter((event) => event.type === 'worker.delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      origin: 'untrusted:worker',
      payload: {
        workerId: 'wrk-abort',
        partial: true,
        cancelled: true,
      },
    })

    expect(JSON.stringify(outcome.chatSessionEntries)).not.toContain(
      'cancelled before producing a valid report',
    )
    expect(JSON.stringify(outcome.workerSessionEntries)).toContain(
      'Investigate the Worker parity source note',
    )
  })
})
