import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { WorkerBriefingSchema, type WorkerBriefing } from './worker-briefing.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import type { WorkerPool } from './worker.ts'

const BRIEFING: WorkerBriefing = {
  goal: 'Research the ketogenic diet',
  allowedTools: [],
  boundaries: [],
  tokenBudget: 10_000,
  maxIterations: 5,
  tier: 'triage',
  highRisk: false,
}

function toolContext(params: { spaceId?: string; trigger?: ToolContext['trigger'] }): ToolContext {
  return fromPartial<ToolContext>({
    toolCallId: 'call-1',
    origin: 'trusted:user',
    ...(params.spaceId !== undefined ? { spaceId: params.spaceId } : {}),
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
  })
}

function fakePool(workerId = 'w-1'): WorkerPool {
  return fromPartial<WorkerPool>({
    spawn: vi.fn().mockReturnValue({ workerId }),
  })
}

describe('createSpawnWorkerTool', () => {
  it('exposes the expected tool metadata', () => {
    const tool = createSpawnWorkerTool(fakePool())
    expect(tool.name).toBe('spawn_worker')
    expect(tool.level).toBe('L0')
    expect(tool.egressDomains).toEqual([])
    expect(tool.schema).toBe(WorkerBriefingSchema)
  })

  it('spawns a worker in the active Space and returns immediately', () => {
    const pool = fakePool('w-1')
    const tool = createSpawnWorkerTool(pool)
    const context = toolContext({ spaceId: 'spc-health' })

    const result = tool.handler(BRIEFING, context)

    expect(pool.spawn).toHaveBeenCalledTimes(1)
    expect(pool.spawn).toHaveBeenCalledWith({
      briefing: BRIEFING,
      spaceId: 'spc-health',
      goalLabel: BRIEFING.goal,
    })
    expect(result).not.toBeInstanceOf(Promise)
    expect((result as { content: string }).content).toContain('w-1')
    expect((result as { details: { workerId: string } }).details.workerId).toBe('w-1')
  })

  it('throws when no active Space is present', () => {
    const tool = createSpawnWorkerTool(fakePool())
    const context = toolContext({})

    expect(() => tool.handler(BRIEFING, context)).toThrow('spawn_worker requires an active Space')
  })

  it('truncates a long goal into a short goalLabel', () => {
    const pool = fakePool('w-2')
    const tool = createSpawnWorkerTool(pool)
    const longGoal = 'a'.repeat(120)
    const briefing = { ...BRIEFING, goal: longGoal }
    const context = toolContext({ spaceId: 'spc-health' })

    tool.handler(briefing, context)

    const call = vi.mocked(pool.spawn).mock.calls[0]?.[0]
    expect(call?.goalLabel.length).toBe(81)
    expect(call?.goalLabel.endsWith('…')).toBe(true)
    expect(call?.goalLabel.startsWith('a'.repeat(80))).toBe(true)
  })

  it('forwards the trigger when present', () => {
    const pool = fakePool('w-3')
    const tool = createSpawnWorkerTool(pool)
    const trigger: ToolContext['trigger'] = { kind: 'chat', id: 'msg-1' }
    const context = toolContext({ spaceId: 'spc-health', trigger })

    tool.handler(BRIEFING, context)

    expect(pool.spawn).toHaveBeenCalledWith({
      briefing: BRIEFING,
      spaceId: 'spc-health',
      goalLabel: BRIEFING.goal,
      trigger,
    })
  })

  it('omits the trigger key entirely when absent', () => {
    const pool = fakePool('w-4')
    const tool = createSpawnWorkerTool(pool)
    const context = toolContext({ spaceId: 'spc-health' })

    tool.handler(BRIEFING, context)

    const call = vi.mocked(pool.spawn).mock.calls[0]?.[0]
    expect(call && 'trigger' in call).toBe(false)
  })
})
