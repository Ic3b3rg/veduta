import { describe, expect, it } from 'vitest'
import type { AgentEvent, ModelRef } from './agent-runner.ts'
import {
  createMockWorkerReviewComplete,
  createMockWorkerRunner,
  mockWorkerReviewComplete,
  MOCK_UNSUPPORTED_CLAIM_TEXT,
} from './mock-worker-runner.ts'
import {
  buildWorkerPrompt,
  WORKER_REPORT_VERSION,
  parseWorkerReport,
  type WorkerBriefing,
  type WorkerReport,
} from './worker-briefing.ts'
import { WorkerReviewVerdictSchema, buildReviewPrompt } from './worker-review.ts'

const REVIEW_MODEL: ModelRef = { provider: 'mock', modelId: 'worker-mock', tier: 'reasoning' }

function briefingWithGoal(goal: string): WorkerBriefing {
  return {
    goal,
    allowedTools: [],
    boundaries: [],
    tokenBudget: 1000,
    maxIterations: 5,
    tier: 'reasoning',
    highRisk: true,
  }
}

const report: WorkerReport = {
  version: WORKER_REPORT_VERSION,
  title: 'Report',
  summary: 'Summary',
  sections: [{ heading: 'Findings', body: 'Body' }],
}

const flaggedReport: WorkerReport = {
  ...report,
  claims: [{ text: MOCK_UNSUPPORTED_CLAIM_TEXT, support: 'Not independently verifiable.' }],
}

describe('createMockWorkerRunner', () => {
  it('emits a turn-end whose text parseWorkerReport accepts', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-test')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    await runner.prompt('investigate the ketogenic diet')

    const turnEnd = events.find((event) => event.type === 'turn-end')
    expect(turnEnd).toBeDefined()
    if (turnEnd?.type !== 'turn-end') throw new Error('expected a turn-end event')
    expect(turnEnd.tokensUsed).toBeGreaterThan(0)
    expect(turnEnd.model).toMatchObject({ provider: 'mock', tier: 'reasoning' })

    const parsed = parseWorkerReport(turnEnd.text)
    expect(parsed.ok).toBe(true)
  })

  it('abort() prevents further emission', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-test-abort')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    // Fire-and-forget, same call shape the WorkerPool uses; abort() lands
    // synchronously before the runner's first yield point resolves.
    const promptPromise = runner.prompt('investigate something')
    void runner.abort()
    await promptPromise

    expect(events.some((event) => event.type === 'turn-end')).toBe(false)
  })

  it('drafts a flagged, initially-rejectable claim for a goal containing "unsupported"', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-test-flagged')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    const briefing = briefingWithGoal('research this unsupported claim')
    await runner.prompt(buildWorkerPrompt(briefing))

    const turnEnd = events.find((event) => event.type === 'turn-end')
    if (turnEnd?.type !== 'turn-end') throw new Error('expected a turn-end event')
    const parsed = parseWorkerReport(turnEnd.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected a valid report')
    expect(parsed.report.claims?.some((claim) => claim.text === MOCK_UNSUPPORTED_CLAIM_TEXT)).toBe(
      true,
    )
  })

  it('never flags a goal that does not contain the sentinel', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-test-unflagged')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    const briefing = briefingWithGoal('research the ketogenic diet')
    await runner.prompt(buildWorkerPrompt(briefing))

    const turnEnd = events.find((event) => event.type === 'turn-end')
    if (turnEnd?.type !== 'turn-end') throw new Error('expected a turn-end event')
    const parsed = parseWorkerReport(turnEnd.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected a valid report')
    expect(parsed.report.claims ?? []).toHaveLength(0)
  })

  it('drops the flagged claim on a corrective retry, regardless of the goal (genuinely corrected draft)', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-test-corrected')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    const briefing = briefingWithGoal('research this unsupported claim')
    // The initial draft (flagged).
    await runner.prompt(buildWorkerPrompt(briefing))
    // The corrective retry, exactly the prompt `WorkerPool.reviewAndDeliver`
    // builds after a rejection.
    await runner.prompt(
      buildWorkerPrompt(briefing, {
        reviewFeedback: { unsupportedClaims: [MOCK_UNSUPPORTED_CLAIM_TEXT] },
      }),
    )

    const turnEnds = events.filter((event) => event.type === 'turn-end')
    expect(turnEnds).toHaveLength(2)
    const [first, second] = turnEnds
    if (first?.type !== 'turn-end' || second?.type !== 'turn-end') {
      throw new Error('expected two turn-end events')
    }

    const firstParsed = parseWorkerReport(first.text)
    const secondParsed = parseWorkerReport(second.text)
    expect(firstParsed.ok && secondParsed.ok).toBe(true)
    if (!firstParsed.ok || !secondParsed.ok) throw new Error('expected valid reports')

    // The two drafts are genuinely different: the corrected one dropped the
    // flagged claim, it did not just replay the exact same rejected text.
    expect(firstParsed.report).not.toEqual(secondParsed.report)
    expect(
      firstParsed.report.claims?.some((claim) => claim.text === MOCK_UNSUPPORTED_CLAIM_TEXT),
    ).toBe(true)
    expect(secondParsed.report.claims ?? []).toHaveLength(0)
  })
})

describe('mockWorkerReviewComplete', () => {
  it('returns a verdict WorkerReviewVerdictSchema accepts', async () => {
    const result = await mockWorkerReviewComplete(REVIEW_MODEL, 'review this report')
    const parsed: unknown = JSON.parse(result.text)
    expect(WorkerReviewVerdictSchema.safeParse(parsed).success).toBe(true)
  })
})

describe('createMockWorkerReviewComplete (dev fixture, acceptance C end-to-end, content-driven)', () => {
  it('passes immediately for a report without the flagged claim', async () => {
    const reviewComplete = createMockWorkerReviewComplete()
    const prompt = buildReviewPrompt(report, briefingWithGoal('research the ketogenic diet'))

    const result = await reviewComplete(REVIEW_MODEL, prompt)

    const verdict = WorkerReviewVerdictSchema.parse(JSON.parse(result.text))
    expect(verdict.verdict).toBe('pass')
  })

  it('rejects a report that still contains the flagged claim, naming it with a suggested caveat', async () => {
    const reviewComplete = createMockWorkerReviewComplete()
    const prompt = buildReviewPrompt(
      flaggedReport,
      briefingWithGoal('research this unsupported claim'),
    )

    const result = await reviewComplete(REVIEW_MODEL, prompt)

    const verdict = WorkerReviewVerdictSchema.parse(JSON.parse(result.text))
    expect(verdict.verdict).toBe('reject')
    expect(verdict.unsupportedClaims).toContain(MOCK_UNSUPPORTED_CLAIM_TEXT)
    expect(verdict.suggestedCaveat).toBeTruthy()
  })

  it('passes a corrected report that has dropped the flagged claim, even for the same goal', async () => {
    const reviewComplete = createMockWorkerReviewComplete()
    const prompt = buildReviewPrompt(report, briefingWithGoal('research this unsupported claim'))

    const result = await reviewComplete(REVIEW_MODEL, prompt)

    const verdict = WorkerReviewVerdictSchema.parse(JSON.parse(result.text))
    expect(verdict.verdict).toBe('pass')
  })

  it('end-to-end: the runner + review fixture together reject the flagged draft then pass the genuinely corrected one', async () => {
    const runner = createMockWorkerRunner()
    await runner.start('worker-e2e')
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })
    const reviewComplete = createMockWorkerReviewComplete()
    const briefing = briefingWithGoal('research this unsupported claim')

    await runner.prompt(buildWorkerPrompt(briefing))
    const firstTurn = events.find((event) => event.type === 'turn-end')
    if (firstTurn?.type !== 'turn-end') throw new Error('expected a turn-end event')
    const firstParsed = parseWorkerReport(firstTurn.text)
    expect(firstParsed.ok).toBe(true)
    if (!firstParsed.ok) throw new Error('expected a valid report')

    const firstVerdict = WorkerReviewVerdictSchema.parse(
      JSON.parse(
        (await reviewComplete(REVIEW_MODEL, buildReviewPrompt(firstParsed.report, briefing))).text,
      ),
    )
    expect(firstVerdict.verdict).toBe('reject')

    events.length = 0
    await runner.prompt(
      buildWorkerPrompt(briefing, {
        reviewFeedback: { unsupportedClaims: firstVerdict.unsupportedClaims },
      }),
    )
    const secondTurn = events.find((event) => event.type === 'turn-end')
    if (secondTurn?.type !== 'turn-end') throw new Error('expected a turn-end event')
    const secondParsed = parseWorkerReport(secondTurn.text)
    expect(secondParsed.ok).toBe(true)
    if (!secondParsed.ok) throw new Error('expected a valid report')

    const secondVerdict = WorkerReviewVerdictSchema.parse(
      JSON.parse(
        (await reviewComplete(REVIEW_MODEL, buildReviewPrompt(secondParsed.report, briefing))).text,
      ),
    )
    expect(secondVerdict.verdict).toBe('pass')
  })
})
