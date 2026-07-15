import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentEventBus,
  defineTool,
  type AgentEventHandler,
  type AgentPromptOptions,
  type AgentRunner,
  type ModelRef,
  type ToolDef,
} from './agent-runner.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { Store } from './store.ts'
import { WORKER_REPORT_VERSION, type WorkerBriefing, type WorkerReport } from './worker-briefing.ts'
import type { WorkerReviewVerdict } from './worker-review.ts'
import {
  activeWorkerSurface,
  workerSurfaceId,
  WORKER_CONTENT_INDEX,
  WORKER_FOOTER_INDEX,
  WORKER_SETTLED_STATE_KEY,
  WORKER_STATUS_INDEX,
} from './worker-surface.ts'
import { WORKER_ORIGIN, WorkerPool, type WorkerPoolOptions } from './worker.ts'

const HEALTH = 'spc-health'
const MODEL: ModelRef = { provider: 'mock', modelId: 'triage-mock', tier: 'triage' }

const routingConfig: RoutingConfig = {
  tiers: {
    triage: [{ provider: 'mock', modelId: 'triage-mock' }],
    reasoning: [{ provider: 'mock', modelId: 'reasoning-mock' }],
  },
  // Keyless "mock" provider (no entry here): the router resolves it without a secret.
  providerKeys: {},
  dailyCapUsd: { triage: 5, reasoning: 20 },
}

interface TurnScript {
  text: string
  costUsd?: number
  tokensUsed?: number
}

/**
 * A scripted, deterministic `AgentRunner`: each `prompt()` call pops the
 * next queued batch of turn-end events and emits them in order (a real
 * `AgentRunner` can emit several `turn-end` events across one `prompt()`
 * call as it loops internally — this mirrors that). `abort()` stops the
 * emission mid-batch, same as a real runner honoring cancellation.
 */
class ScriptedAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly script: TurnScript[][]
  private aborted = false
  promptCalls: { input: string; options?: AgentPromptOptions }[] = []
  abortCalls = 0

  constructor(script: TurnScript[][]) {
    this.script = script
  }

  async start(): Promise<void> {}

  async prompt(input: string, options?: AgentPromptOptions): Promise<void> {
    this.promptCalls.push({ input, ...(options === undefined ? {} : { options }) })
    const model = options?.model ?? MODEL
    const turns = this.script.shift() ?? []
    for (const turn of turns) {
      if (this.aborted) break
      await this.events.emit({
        type: 'turn-end',
        sessionId: 'worker-session',
        model,
        text: turn.text,
        ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
        ...(turn.tokensUsed === undefined ? {} : { tokensUsed: turn.tokensUsed }),
      })
    }
  }

  abort(): void {
    this.aborted = true
    this.abortCalls += 1
  }

  on(handler: AgentEventHandler): () => void {
    return this.events.on(handler)
  }
}

function validReportText(overrides: Partial<WorkerReport> = {}): string {
  const report: WorkerReport = {
    version: WORKER_REPORT_VERSION,
    title: 'Ketogenic diet',
    summary: 'A summary of the ketogenic diet.',
    sections: [{ heading: 'Overview', body: 'Low-carb, high-fat diet.' }],
    ...overrides,
  }
  return JSON.stringify(report)
}

function briefing(overrides: Partial<WorkerBriefing> = {}): WorkerBriefing {
  return {
    goal: 'Research the ketogenic diet',
    allowedTools: [],
    boundaries: [],
    tokenBudget: 100_000,
    maxIterations: 5,
    tier: 'triage',
    highRisk: false,
    ...overrides,
  }
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())

let store: Store
let router: ModelRouter

function makePool(overrides: Partial<WorkerPoolOptions> & { runner?: ScriptedAgentRunner } = {}): {
  pool: WorkerPool
  runners: ScriptedAgentRunner[]
} {
  const runners: ScriptedAgentRunner[] = []
  const runner = overrides.runner
  const pool = new WorkerPool({
    store,
    router,
    now,
    workerTools: overrides.workerTools ?? [],
    runnerFactory:
      overrides.runnerFactory ??
      ((_sessionId) => {
        const created = runner ?? new ScriptedAgentRunner([])
        runners.push(created)
        return created
      }),
    reviewComplete:
      overrides.reviewComplete ?? (async () => ({ text: JSON.stringify({ verdict: 'pass' }) })),
    ...(overrides.etaMinutes === undefined ? {} : { etaMinutes: overrides.etaMinutes }),
    ...(overrides.makeWorkerId === undefined ? {} : { makeWorkerId: overrides.makeWorkerId }),
  })
  return { pool, runners }
}

function verdictText(verdict: WorkerReviewVerdict): string {
  return JSON.stringify(verdict)
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-worker-'))
  clock = new Date('2026-07-08T06:00:00.000Z')
  store = new Store({ rootDir, now })
  router = new ModelRouter({ config: routingConfig, now, sleep: async () => {} })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('constructor', () => {
  it('throws when a worker tool is not L0', () => {
    const l1Tool: ToolDef = defineTool({
      name: 'send_email',
      description: 'outbound',
      schema: z.object({}),
      level: 'L1',
      egressDomains: [],
      handler: () => ({ content: 'sent' }),
    })
    expect(
      () =>
        new WorkerPool({
          store,
          router,
          workerTools: [l1Tool],
          runnerFactory: () => new ScriptedAgentRunner([]),
          reviewComplete: async () => ({ text: '{}' }),
        }),
    ).toThrow('worker tools must be L0 with empty egress')
  })

  it('throws when an L0 worker tool declares non-empty egress', () => {
    const badTool: ToolDef = defineTool({
      name: 'fetch_page',
      description: 'reads a page',
      schema: z.object({}),
      level: 'L0',
      egressDomains: ['example.com'],
      handler: () => ({ content: 'ok' }),
    })
    expect(
      () =>
        new WorkerPool({
          store,
          router,
          workerTools: [badTool],
          runnerFactory: () => new ScriptedAgentRunner([]),
          reviewComplete: async () => ({ text: '{}' }),
        }),
    ).toThrow('worker tools must be L0 with empty egress')
  })
})

describe('acceptance A: happy path, high-risk, review passes', () => {
  it('spawns synchronously, then delivers a passed-review report', async () => {
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 500 }]])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => ({
        text: verdictText({ verdict: 'pass', unsupportedClaims: [] }),
      }),
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true }),
      spaceId: HEALTH,
      goalLabel: 'the ketogenic diet',
    })

    // Spawn returns immediately: the active Surface exists synchronously, no await needed.
    const surfaceId = workerSurfaceId(workerId)
    const active = store.getSurface(surfaceId)
    expect(active).toBeDefined()
    expect(active?.title).toBe('Worker: the ketogenic diet')

    await pool.whenSettled(workerId)

    const terminal = store.getSurface(surfaceId)
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Delivered')
    const contentChildren = terminal?.tree.children?.[WORKER_CONTENT_INDEX]?.children ?? []
    expect(contentChildren.some((node) => node.props?.['text'] === 'Ketogenic diet')).toBe(true)
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(true)
    expect(footerChildren.some((node) => node.id === 'badge-partial')).toBe(false)
    expect(footerChildren.some((node) => node.id === 'badge-cancelled')).toBe(false)

    const events = store.eventLog(HEALTH)
    const delivered = events.find((event) => event.type === 'worker.delivered')
    expect(delivered).toBeDefined()
    expect(delivered?.origin).toBe(WORKER_ORIGIN)
    expect(delivered?.payload?.['partial']).toBe(false)
    expect(delivered?.payload?.['cancelled']).toBe(false)
    expect(delivered?.payload?.['reviewStatus']).toBe('passed')
    expect((delivered?.payload?.['report'] as { title?: string })?.title).toBe('Ketogenic diet')

    expect(store.eventLog(HEALTH).some((event) => event.type === 'worker.spawned')).toBe(true)
  })
})

describe('acceptance B: budget exceeded', () => {
  it('terminates on the token budget and delivers a fallback partial report', async () => {
    const runner = new ScriptedAgentRunner([
      [
        { text: 'not json', tokensUsed: 40 },
        { text: 'still not json', tokensUsed: 40 },
      ],
    ])
    const { pool } = makePool({ runner })

    const { workerId } = pool.spawn({
      briefing: briefing({ tokenBudget: 50, maxIterations: 5 }),
      spaceId: HEALTH,
      goalLabel: 'budget test',
    })
    await pool.whenSettled(workerId)

    const surfaceId = workerSurfaceId(workerId)
    const terminal = store.getSurface(surfaceId)
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Partial')
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-partial')).toBe(true)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['partial']).toBe(true)
    const report = delivered?.payload?.['report'] as { summary?: string }
    expect(report?.summary).toBe('No valid report was produced.')

    // Only one turn-end should ever have been emitted after the cap trips.
    expect(runner.abortCalls).toBeGreaterThan(0)
  })

  it('is fail-closed on the iteration cap even when tokensUsed is never reported', async () => {
    const runner = new ScriptedAgentRunner([
      [{ text: 'x' }, { text: 'x' }, { text: 'x' }, { text: 'x' }, { text: 'x' }, { text: 'x' }],
    ])
    const { pool } = makePool({ runner })

    const { workerId } = pool.spawn({
      briefing: briefing({ tokenBudget: 1_000_000, maxIterations: 5 }),
      spaceId: HEALTH,
      goalLabel: 'iteration cap test',
    })
    await pool.whenSettled(workerId)

    expect(runner.promptCalls).toHaveLength(1)
    // Exactly 5 turn-ends processed (the 6th must never have been emitted:
    // abort() was called synchronously once turnCount hit maxIterations).
    const terminal = store.getSurface(workerSurfaceId(workerId))
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Partial')
    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['partial']).toBe(true)
  })
})

describe('acceptance C: review rejects', () => {
  it('corrects and re-review passes', async () => {
    let reviewCalls = 0
    const runner = new ScriptedAgentRunner([
      [{ text: validReportText({ title: 'Draft' }), tokensUsed: 10 }],
      [{ text: validReportText({ title: 'Corrected' }), tokensUsed: 10 }],
    ])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        reviewCalls += 1
        if (reviewCalls === 1) {
          return {
            text: verdictText({
              verdict: 'reject',
              unsupportedClaims: ['unverified claim'],
              suggestedCaveat: 'Some claims are unverified.',
            }),
          }
        }
        return { text: verdictText({ verdict: 'pass', unsupportedClaims: [] }) }
      },
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 1000 }),
      spaceId: HEALTH,
      goalLabel: 'corrective test',
    })
    await pool.whenSettled(workerId)

    expect(reviewCalls).toBe(2)
    const terminal = store.getSurface(workerSurfaceId(workerId))
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(true)
    const contentChildren = terminal?.tree.children?.[WORKER_CONTENT_INDEX]?.children ?? []
    expect(contentChildren.some((node) => node.props?.['text'] === 'Corrected')).toBe(true)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).toBe('passed')
    expect(delivered?.payload?.['partial']).toBe(false)

    // The rejected verdict's `unsupportedClaims` actually reached the
    // corrective prompt (not the schema "failed validation" wording, which
    // is wrong for a review rejection — the JSON was valid, the CONTENT was
    // refuted).
    const correctivePrompt = runner.promptCalls[1]?.input
    expect(correctivePrompt).toContain('unverified claim')
    expect(correctivePrompt).toContain('independent review')
    expect(correctivePrompt).not.toContain('failed validation')
  })

  it('delivers with a caveat when the corrective retry also rejects', async () => {
    let reviewCalls = 0
    const runner = new ScriptedAgentRunner([
      [{ text: validReportText({ title: 'Draft' }), tokensUsed: 10 }],
      [{ text: validReportText({ title: 'Still wrong' }), tokensUsed: 10 }],
    ])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        reviewCalls += 1
        return {
          text: verdictText({
            verdict: 'reject',
            unsupportedClaims: ['unverified claim'],
            suggestedCaveat: `caveat-${reviewCalls}`,
          }),
        }
      },
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 1000 }),
      spaceId: HEALTH,
      goalLabel: 'caveat test',
    })
    await pool.whenSettled(workerId)

    expect(reviewCalls).toBe(2)
    const terminal = store.getSurface(workerSurfaceId(workerId))
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-caveat')).toBe(true)
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(false)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).toBe('skipped')
    const report = delivered?.payload?.['report'] as { caveat?: string; title?: string }
    expect(report?.caveat).toBe('caveat-2')
    expect(report?.title).toBe('Still wrong')
  })

  it('never re-reviews when the corrective retry produces NO new valid draft — settles on the FIRST verdict, never passed', async () => {
    let reviewCalls = 0
    const runner = new ScriptedAgentRunner([
      [{ text: validReportText({ title: 'Draft' }), tokensUsed: 10 }],
      // The corrective turn fails to parse at all: `lastValidReport` (and
      // `reportRevision`) are left exactly as they were before this call.
      [{ text: 'not valid json', tokensUsed: 10 }],
    ])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        reviewCalls += 1
        return {
          text: verdictText({
            verdict: 'reject',
            unsupportedClaims: ['unverified claim'],
            suggestedCaveat: 'first-verdict-caveat',
          }),
        }
      },
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 1000 }),
      spaceId: HEALTH,
      goalLabel: 'no new draft test',
    })
    await pool.whenSettled(workerId)

    // Only ONE review call: the second was skipped entirely because no new
    // draft ever parsed after the corrective prompt — re-reviewing the
    // exact same rejected report would just be re-rolling a verdict on
    // unchanged content.
    expect(reviewCalls).toBe(1)
    const terminal = store.getSurface(workerSurfaceId(workerId))
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(false)
    expect(footerChildren.some((node) => node.id === 'badge-caveat')).toBe(true)
    const contentChildren = terminal?.tree.children?.[WORKER_CONTENT_INDEX]?.children ?? []
    // Still the ORIGINAL (rejected) draft — never delivers the unparseable
    // corrective attempt's (nonexistent) content as if it were reviewed.
    expect(contentChildren.some((node) => node.props?.['text'] === 'Draft')).toBe(true)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).toBe('skipped')
    const report = delivered?.payload?.['report'] as { caveat?: string; title?: string }
    expect(report?.caveat).toBe('first-verdict-caveat')
    expect(report?.title).toBe('Draft')
  })

  it('re-reviews and can pass when the corrective retry produces a genuinely NEW valid draft (contrast with the no-new-draft case above)', async () => {
    let reviewCalls = 0
    const runner = new ScriptedAgentRunner([
      [{ text: validReportText({ title: 'Draft' }), tokensUsed: 10 }],
      [{ text: validReportText({ title: 'Corrected' }), tokensUsed: 10 }],
    ])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        reviewCalls += 1
        return reviewCalls === 1
          ? {
              text: verdictText({
                verdict: 'reject',
                unsupportedClaims: ['unverified claim'],
                suggestedCaveat: 'first-verdict-caveat',
              }),
            }
          : { text: verdictText({ verdict: 'pass', unsupportedClaims: [] }) }
      },
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 1000 }),
      spaceId: HEALTH,
      goalLabel: 'new draft test',
    })
    await pool.whenSettled(workerId)

    expect(reviewCalls).toBe(2)
    const terminal = store.getSurface(workerSurfaceId(workerId))
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(true)
    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).toBe('passed')
  })
})

describe('cancel', () => {
  it('aborts the runner and delivers a cancelled report', async () => {
    // An empty script: the runner never gets a chance to emit anything —
    // the cancel arrives before the first prompt() call's internal loop runs.
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    const { pool } = makePool({ runner })

    const { workerId } = pool.spawn({
      briefing: briefing(),
      spaceId: HEALTH,
      goalLabel: 'cancel test',
    })

    const surfaceId = workerSurfaceId(workerId)
    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'worker-cancel',
      name: 'cancel',
      payload: { value: true },
    })

    await pool.whenSettled(workerId)

    const terminal = store.getSurface(surfaceId)
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Cancelled')
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-cancelled')).toBe(true)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['cancelled']).toBe(true)
    expect(store.eventLog(HEALTH).some((event) => event.type === 'worker.cancelled')).toBe(true)
    expect(runner.abortCalls).toBeGreaterThan(0)
  })
})

describe('recoverAtBoot', () => {
  it('patches an orphaned active worker Surface to an interrupted, partial terminal state', () => {
    // Simulate a Surface left behind by a previous daemon process: created
    // directly (no live worker in this process at all — no run in flight).
    const workerId = 'orphan1'
    const surfaceId = workerSurfaceId(workerId)
    store.createSurface(
      activeWorkerSurface({
        workerId,
        spaceId: HEALTH,
        goalLabel: 'orphaned run',
        etaMinutes: 5,
        updatedAt: clock.toISOString(),
      }),
      'job',
      { daemonOwned: true },
    )

    const { pool } = makePool()
    pool.recoverAtBoot()

    const terminal = store.getSurface(surfaceId)
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Partial')
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-partial')).toBe(true)
    // A genuine orphan was never independently reviewed: caveated
    // unconditionally, regardless of whether the original briefing was
    // high-risk (that briefing isn't even persisted here to check).
    expect(footerChildren.some((node) => node.id === 'badge-caveat')).toBe(true)
    expect(terminal?.state[WORKER_SETTLED_STATE_KEY]).toBe(true)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['interrupted']).toBe(true)
    expect(delivered?.payload?.['partial']).toBe(true)
    const report = delivered?.payload?.['report'] as { summary?: string; caveat?: string }
    expect(report?.summary).toBe('Interrupted by a restart before delivery.')
    expect(report?.caveat).toBe('Interrupted before delivery; not independently reviewed.')
  })

  it('reconciles a Surface left unfinished by a crash between the commit event and the Surface patch — never clobbers the real report, appends no duplicate event', () => {
    // Simulates `settle()` having appended the `worker.delivered` commit-point
    // event (issue #17 re-review, Fix 1) and then the process crashing
    // before the Surface patch/`markSettled` that follows it ran: the
    // Surface itself is still in its ACTIVE shape (`state.settled` false).
    const workerId = 'crash1'
    const surfaceId = workerSurfaceId(workerId)
    store.createSurface(
      activeWorkerSurface({
        workerId,
        spaceId: HEALTH,
        goalLabel: 'crash test',
        etaMinutes: 5,
        updatedAt: clock.toISOString(),
      }),
      'job',
      { daemonOwned: true },
    )

    store.spacesEngine.appendEvent(HEALTH, {
      type: 'worker.delivered',
      text: 'Worker delivered a report',
      origin: WORKER_ORIGIN,
      payload: {
        workerId,
        partial: false,
        cancelled: false,
        reviewStatus: 'passed',
        report: {
          version: WORKER_REPORT_VERSION,
          title: 'Real report',
          summary: 'A real, already-delivered report.',
          sections: [{ heading: 'Findings', body: 'Actual findings.' }],
        },
      },
    })
    const beforeEventCount = store.eventLog(HEALTH).length

    const { pool } = makePool()
    pool.recoverAtBoot()

    const terminal = store.getSurface(surfaceId)
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Delivered')
    const contentChildren = terminal?.tree.children?.[WORKER_CONTENT_INDEX]?.children ?? []
    expect(contentChildren.some((node) => node.props?.['text'] === 'Real report')).toBe(true)
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-review-passed')).toBe(true)
    expect(footerChildren.some((node) => node.id === 'badge-partial')).toBe(false)
    expect(terminal?.state[WORKER_SETTLED_STATE_KEY]).toBe(true)

    // No duplicate `worker.delivered` event: exactly the one this test
    // appended to simulate the crash — reconciliation never appends a
    // second one, the event already in the log IS the delivery. (The
    // Surface patch/markSettled below it still append their own routine
    // `surface.patch_tree`/`surface.patch_state` bookkeeping events, same
    // as any other patch — only `worker.delivered` duplication matters here.)
    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'worker.delivered'),
    ).toHaveLength(1)
    expect(store.eventLog(HEALTH).length).toBeGreaterThan(beforeEventCount)
  })

  it('leaves an already-delivered Surface (state.settled === true) completely untouched', () => {
    // A Surface a PRIOR boot pass already recovered (or a live worker
    // already delivered before this restart): re-patching it would clobber
    // the real report and append a duplicate `worker.delivered` on every
    // subsequent restart.
    const workerId = 'delivered1'
    const surfaceId = workerSurfaceId(workerId)
    store.createSurface(
      activeWorkerSurface({
        workerId,
        spaceId: HEALTH,
        goalLabel: 'already delivered',
        etaMinutes: 5,
        updatedAt: clock.toISOString(),
      }),
      'job',
      { daemonOwned: true },
    )
    store.patchState(
      surfaceId,
      [{ target: 'state', op: 'replace', path: '/settled', value: true }],
      {
        updatedBy: 'job',
      },
    )
    const beforeVersion = store.getSurfaceVersion(surfaceId)
    const beforeEventCount = store.eventLog(HEALTH).length

    const { pool } = makePool()
    pool.recoverAtBoot()

    const afterVersion = store.getSurfaceVersion(surfaceId)
    expect(afterVersion?.treeVersion).toBe(beforeVersion?.treeVersion)
    expect(
      store.eventLog(HEALTH).filter((event) => event.type === 'worker.delivered'),
    ).toHaveLength(0)
    expect(store.eventLog(HEALTH)).toHaveLength(beforeEventCount)
  })
})

describe('high-risk safety invariant (review never fails open)', () => {
  it('caveats a high-risk report even when no valid draft was ever produced (the no-valid-draft fallback path)', async () => {
    // No review is even attempted here: `investigate()` only calls
    // `reviewAndDeliver` when `live.lastValidReport` is set, so a
    // high-risk briefing whose one turn never parses goes straight to the
    // fallback `settle()` call with `reviewStatus: 'skipped'` and no
    // caveat of its own — exactly the path `settle()`'s single enforcement
    // point (issue #17 re-review, Fix 2) must still catch.
    const runner = new ScriptedAgentRunner([[{ text: 'not json', tokensUsed: 10 }]])
    const { pool } = makePool({ runner })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 100_000 }),
      spaceId: HEALTH,
      goalLabel: 'high risk no draft test',
    })
    await pool.whenSettled(workerId)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).not.toBe('passed')
    const report = delivered?.payload?.['report'] as { caveat?: string }
    expect(report?.caveat).toBeTruthy()

    const terminal = store.getSurface(workerSurfaceId(workerId))
    const footerChildren = terminal?.tree.children?.[WORKER_FOOTER_INDEX]?.children ?? []
    expect(footerChildren.some((node) => node.id === 'badge-caveat')).toBe(true)
  })

  it('delivers with a caveat, never reviewStatus passed, when reviewReport throws', async () => {
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        throw new Error('reviewer transport failed')
      },
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true }),
      spaceId: HEALTH,
      goalLabel: 'review throws test',
    })
    await pool.whenSettled(workerId)

    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).not.toBe('passed')
    const report = delivered?.payload?.['report'] as { caveat?: string }
    expect(report?.caveat).toBeTruthy()
  })

  it('never delivers a clean high-risk report when the token budget is crossed on the very turn that produced it', async () => {
    // tokenBudget:10 with tokensUsed:10 on the one and only turn: the cap
    // trips on exactly the turn that also produced the first valid report.
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    const { pool } = makePool({
      runner,
      reviewComplete: async () => ({
        text: verdictText({
          verdict: 'reject',
          unsupportedClaims: ['x'],
          suggestedCaveat: 'cap-caveat',
        }),
      }),
    })

    const { workerId } = pool.spawn({
      briefing: briefing({ highRisk: true, maxIterations: 5, tokenBudget: 10 }),
      spaceId: HEALTH,
      goalLabel: 'cap during review test',
    })
    await pool.whenSettled(workerId)

    // Review was still attempted despite the cap having tripped — only the
    // corrective retry (which needs more budget) was skipped.
    expect(runner.promptCalls).toHaveLength(1)
    const terminal = store.getSurface(workerSurfaceId(workerId))
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Partial')
    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['reviewStatus']).not.toBe('passed')
    const report = delivered?.payload?.['report'] as { caveat?: string }
    expect(report?.caveat).toBe('cap-caveat')
  })

  it('reflects cancelled:true in the delivered surface/event when a cancel arrives during review, even though the verdict passes', async () => {
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    let workerId = ''
    const { pool } = makePool({
      runner,
      reviewComplete: async () => {
        store.invokeSurfaceAction(workerSurfaceId(workerId), {
          nodeId: 'worker-cancel',
          name: 'cancel',
          payload: { value: true },
        })
        return { text: verdictText({ verdict: 'pass', unsupportedClaims: [] }) }
      },
    })

    workerId = pool.spawn({
      briefing: briefing({ highRisk: true }),
      spaceId: HEALTH,
      goalLabel: 'cancel during review test',
    }).workerId
    await pool.whenSettled(workerId)

    const terminal = store.getSurface(workerSurfaceId(workerId))
    expect(terminal?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toBe('Cancelled')
    const delivered = store.eventLog(HEALTH).find((event) => event.type === 'worker.delivered')
    expect(delivered?.payload?.['cancelled']).toBe(true)
    expect(delivered?.payload?.['reviewStatus']).toBe('passed')
  })
})

describe('toolsForBriefing (briefing.allowedTools)', () => {
  function tool(name: string): ToolDef {
    return defineTool({
      name,
      description: name,
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
  }

  it('offers zero tools when allowedTools is empty, even though the registry is non-empty', async () => {
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    const { pool } = makePool({ runner, workerTools: [tool('x')] })

    const { workerId } = pool.spawn({
      briefing: briefing({ allowedTools: [] }),
      spaceId: HEALTH,
      goalLabel: 'tools test',
    })
    await pool.whenSettled(workerId)

    expect(runner.promptCalls[0]?.options?.tools).toEqual([])
  })

  it('offers only the tool named in allowedTools', async () => {
    const runner = new ScriptedAgentRunner([[{ text: validReportText(), tokensUsed: 10 }]])
    const { pool } = makePool({ runner, workerTools: [tool('x'), tool('y')] })

    const { workerId } = pool.spawn({
      briefing: briefing({ allowedTools: ['x'] }),
      spaceId: HEALTH,
      goalLabel: 'tools test',
    })
    await pool.whenSettled(workerId)

    const tools = runner.promptCalls[0]?.options?.tools ?? []
    expect(tools.map((toolDef) => toolDef.name)).toEqual(['x'])
  })

  it('does not mutate the caller-supplied workerTools array (defensive copy)', () => {
    const registry = [tool('x')]
    makePool({ workerTools: registry })
    registry.push(tool('y'))
    // The pool's own copy must be unaffected by a later mutation of the
    // array the caller passed in.
    expect(registry).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('suppresses delivery: a prompt that resolves after dispose() never writes to the store', async () => {
    let releasePrompt: () => void = () => {}
    const events = new AgentEventBus()
    const fakeRunner: AgentRunner = {
      async start() {},
      async prompt(_input, options) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve
        })
        await events.emit({
          type: 'turn-end',
          sessionId: 'worker-session',
          model: options?.model ?? MODEL,
          text: validReportText(),
          tokensUsed: 10,
        })
      },
      abort() {},
      on(handler) {
        return events.on(handler)
      },
    }

    const { pool } = makePool({ runnerFactory: () => fakeRunner })

    const { workerId } = pool.spawn({
      briefing: briefing(),
      spaceId: HEALTH,
      goalLabel: 'dispose test',
    })
    const surfaceId = workerSurfaceId(workerId)
    const beforeEventCount = store.eventLog(HEALTH).length

    pool.dispose()
    releasePrompt()
    // Let the released prompt()'s pending microtasks/promises settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.eventLog(HEALTH)).toHaveLength(beforeEventCount)
    const surface = store.getSurface(surfaceId)
    // The active Surface is untouched: still showing the researching state.
    expect(surface?.tree.children?.[WORKER_STATUS_INDEX]?.props?.['text']).toContain('researching')
  })
})
