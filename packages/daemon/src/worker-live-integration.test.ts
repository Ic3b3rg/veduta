import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, fakeText, fakeToolCall, fakeUsage } from './fake-provider.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import { completeToolless, type PiChatContext } from './pi-provider-bridge.ts'
import { Store } from './store.ts'
import { piToolParameters } from './tool-parameters.ts'
import { WORKER_REPORT_VERSION, type WorkerBriefing, type WorkerReport } from './worker-briefing.ts'
import { WorkerPool } from './worker.ts'
import { workerToolRegistry } from './worker-tool-registry.ts'

const HEALTH = 'spc-health'
const NOW = () => new Date('2026-08-24T10:00:00.000Z')
const CONFIG: RoutingConfig = {
  tiers: {
    reasoning: [{ provider: 'fake', modelId: 'fake-model' }],
    triage: [{ provider: 'fake', modelId: 'fake-model' }],
  },
  providerKeys: {},
  connectionKeys: {},
  dailyCapUsd: { triage: 5, reasoning: 20 },
}

describe('live Worker execution through the fake provider', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  })

  it('isolates the session, refuses an above-L0 call, reads L0 data, and converges after fresh adversarial review', async () => {
    const testHarness = harness(['wrk-live'])
    testHarness.store.spacesEngine.appendEvent(HEALTH, {
      text: 'The source note the Worker may read.',
      origin: 'trusted:user',
    })
    testHarness.index.reconcile()

    const rejectedClaim = 'Every participant recovered immediately.'
    const firstReport = report({
      claims: [{ text: rejectedClaim, support: 'No source supplied.' }],
    })
    const correctedReport = report({ summary: 'Corrected after independent review.' })
    const reviewContexts: PiChatContext[] = []
    let correctionContext: PiChatContext | undefined
    testHarness.fake.setResponses([
      {
        message: fakeToolCall('send_message', { to: 'outside@example.com', body: 'blocked' }),
        usage: fakeUsage(0.01),
      },
      { message: fakeToolCall('read_recent', { limit: 20 }), usage: fakeUsage(0.02) },
      { message: fakeText(JSON.stringify(firstReport)), usage: fakeUsage(0.03) },
      {
        factory: (context) => {
          reviewContexts.push(context)
          return fakeText(
            JSON.stringify({
              verdict: 'reject',
              unsupportedClaims: [rejectedClaim],
              suggestedCaveat: 'The unsupported claim was removed.',
            }),
          )
        },
        usage: fakeUsage(0.04),
      },
      {
        factory: (context) => {
          correctionContext = context
          return fakeText(JSON.stringify(correctedReport))
        },
        usage: fakeUsage(0.05),
      },
      {
        factory: (context) => {
          reviewContexts.push(context)
          return fakeText(JSON.stringify({ verdict: 'pass', unsupportedClaims: [] }))
        },
        usage: fakeUsage(0.06),
      },
    ])

    const { workerId } = testHarness.pool.spawn({
      briefing: briefing({
        allowedTools: ['send_message', 'read_recent'],
        highRisk: true,
      }),
      spaceId: HEALTH,
      goalLabel: 'Live fake-provider review',
    })
    await testHarness.pool.whenSettled(workerId)

    const workerSession = await testHarness.sessions.load(`worker-${workerId}`)
    expect((await testHarness.sessions.load(`space:${HEALTH}`)).messages).toEqual([])
    expect(workerSession.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          toolName: 'send_message',
          isError: true,
          content: expect.stringContaining('not found'),
        }),
        expect.objectContaining({
          role: 'tool',
          toolName: 'read_recent',
          isError: false,
          content: expect.stringContaining('source note'),
        }),
      ]),
    )
    expect(correctionContext?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('independent review flagged'),
        }),
      ]),
    )
    expect(reviewContexts).toHaveLength(2)
    for (const context of reviewContexts) {
      expect(context.tools).toBeUndefined()
      expect(context.messages).toHaveLength(1)
    }

    const delivered = testHarness.store
      .eventLog(HEALTH)
      .find((event) => event.type === 'worker.delivered')
    expect(delivered).toMatchObject({
      origin: 'untrusted:worker',
      payload: {
        workerId,
        reviewStatus: 'passed',
        report: { summary: correctedReport.summary },
      },
    })
    expect(testHarness.router.usage().workers).toHaveLength(1)
    expect(testHarness.router.usage().workers[0]?.workerId).toBe(workerId)
    expect(testHarness.router.usage().workers[0]?.spentUsd).toBeCloseTo(0.21)
    expect(testHarness.router.usage().tiers.reasoning.spentUsd).toBeCloseTo(0.21)
    expect(testHarness.fake.pendingCount()).toBe(0)
  })

  it("stops one Worker at its token budget without stopping the tier until the tier's cap is crossed", async () => {
    const testHarness = harness(['wrk-budget', 'wrk-next', 'wrk-capped'], {
      ...CONFIG,
      dailyCapUsd: { ...CONFIG.dailyCapUsd, reasoning: 0.15 },
    })
    testHarness.fake.setResponses([
      {
        message: fakeText(JSON.stringify(report({ summary: 'Over the Worker token budget.' }))),
        usage: { ...fakeUsage(0.1), totalTokens: 101 },
      },
      {
        message: fakeText(JSON.stringify(report({ summary: 'The next Worker still ran.' }))),
        usage: { ...fakeUsage(0.1), totalTokens: 10 },
      },
    ])

    const first = testHarness.pool.spawn({
      briefing: briefing({ tokenBudget: 100, highRisk: false }),
      spaceId: HEALTH,
      goalLabel: 'Budgeted Worker',
    })
    await testHarness.pool.whenSettled(first.workerId)
    expect(deliveryFor(testHarness.store, first.workerId)?.payload).toMatchObject({ partial: true })
    expect(testHarness.router.proactivityAllowed('reasoning')).toBe(true)

    const second = testHarness.pool.spawn({
      briefing: briefing({ tokenBudget: 100, highRisk: false }),
      spaceId: HEALTH,
      goalLabel: 'Next Worker',
    })
    await testHarness.pool.whenSettled(second.workerId)
    expect(deliveryFor(testHarness.store, second.workerId)?.payload).toMatchObject({
      partial: false,
      report: { summary: 'The next Worker still ran.' },
    })
    expect(testHarness.router.proactivityAllowed('reasoning')).toBe(false)

    const third = testHarness.pool.spawn({
      briefing: briefing({ tokenBudget: 100, highRisk: false }),
      spaceId: HEALTH,
      goalLabel: 'Tier-capped Worker',
    })
    await testHarness.pool.whenSettled(third.workerId)
    expect(deliveryFor(testHarness.store, third.workerId)?.payload).toMatchObject({ partial: true })
    expect(testHarness.fake.pendingCount()).toBe(0)
    expect(testHarness.router.usage().workers).toEqual([
      { workerId: first.workerId, spentUsd: 0.1 },
      { workerId: second.workerId, spentUsd: 0.1 },
    ])
  })

  function harness(workerIds: string[], config: RoutingConfig = CONFIG) {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-worker-live-'))
    const store = new Store({ rootDir, now: NOW })
    const index = new MemoryIndex({ rootDir, spacesEngine: store.spacesEngine, now: NOW })
    const retrieval = new MemoryRetrieval({
      index,
      spacesEngine: store.spacesEngine,
      config: MemoryConfigSchema.parse({}),
      now: NOW,
    })
    const tools = workerToolRegistry({
      spacesEngine: store.spacesEngine,
      memoryRetrieval: retrieval,
    })
    const parameters = piToolParameters(tools)
    const sessions = new PiJsonlSessionStore({
      cwd: rootDir,
      sessionsRoot: join(rootDir, 'sessions'),
    })
    const fake = createFakeProvider()
    const router = new ModelRouter({ config, rootDir, now: NOW, sleep: async () => {} })
    const ids = [...workerIds]
    const pool = new WorkerPool({
      store,
      router,
      workerTools: tools,
      runnerFactory: () =>
        new PiAgentRunner({
          sessionStore: sessions,
          resolveModel: fake.resolveModel,
          getApiKey: fake.getApiKey,
          streamFn: fake.streamFn,
          toolParameters: parameters,
        }),
      reviewComplete: (model, prompt) => completeToolless(fake, model, prompt),
      makeWorkerId: () => {
        const id = ids.shift()
        if (!id) throw new Error('worker id fixture exhausted')
        return id
      },
      now: NOW,
    })
    cleanups.push(() => {
      pool.dispose()
      index.close()
      rmSync(rootDir, { recursive: true, force: true })
    })
    return { fake, index, pool, router, sessions, store }
  }
})

function briefing(overrides: Partial<WorkerBriefing> = {}): WorkerBriefing {
  return {
    goal: 'Investigate the source note',
    allowedTools: [],
    boundaries: [],
    tokenBudget: 10_000,
    maxIterations: 6,
    tier: 'reasoning',
    highRisk: false,
    ...overrides,
  }
}

function report(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    version: WORKER_REPORT_VERSION,
    title: 'Investigation report',
    summary: 'Initial report.',
    sections: [{ heading: 'Findings', body: 'One bounded finding.' }],
    ...overrides,
  }
}

function deliveryFor(store: Store, workerId: string) {
  return store
    .eventLog(HEALTH)
    .find((event) => event.type === 'worker.delivered' && event.payload?.['workerId'] === workerId)
}
