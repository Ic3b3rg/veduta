import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, fakeText, fakeUsage } from './fake-provider.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createProactiveCompletions } from './proactive-completions.ts'

describe('live proactive completion runtime', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function runtime() {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-proactive-'))
    roots.push(rootDir)
    const config: RoutingConfig = {
      tiers: {
        triage: [{ provider: 'fake', modelId: 'fake-model' }],
        reasoning: [{ provider: 'fake', modelId: 'fake-model' }],
      },
      providerKeys: {},
      connectionKeys: {},
      dailyCapUsd: { triage: 0.01, reasoning: 1 },
    }
    const router = new ModelRouter({ config, rootDir })
    const bridge = createFakeProvider()
    return { router, bridge, completions: createProactiveCompletions({ router, bridge }) }
  }

  it('routes scheduler judgments through classification and validates the verdict', async () => {
    const { router, bridge, completions } = runtime()
    bridge.setResponses([{ message: fakeText('{"verdict":"yes"}'), usage: fakeUsage(0.02) }])

    expect(await completions.judge('Was the task completed?', 'spc-health')).toBe('yes')
    expect(router.callLog()).toMatchObject([
      { purpose: 'classification', origin: 'proactive', spaceId: 'spc-health' },
    ])
    expect(router.usage().tiers.triage.spentUsd).toBe(0.02)
    expect(await completions.judge('Was the task completed?', 'spc-health')).toBe('unknown')
    expect(bridge.pendingCount()).toBe(0)
  })

  it('rejects a schema-invalid judgment instead of accepting arbitrary model text', async () => {
    const { bridge, completions } = runtime()
    bridge.setResponses([{ message: fakeText('{"verdict":"perhaps"}') }])

    expect(await completions.judge('Is the task complete?', 'spc-health')).toBe('unknown')
  })

  it('routes Reflection on the reasoning tier with a validated report and spend', async () => {
    const { router, bridge, completions } = runtime()
    bridge.setResponses([
      {
        message: fakeText(
          JSON.stringify({
            summaries: ['One task was completed.'],
            insights: ['The work finished on time.'],
            facts: [
              { text: 'The task was completed.', sourceRefs: ['event:spc-health:2026-09-30:1'] },
            ],
          }),
        ),
        usage: fakeUsage(0.03),
      },
    ])

    const report = await completions.reflection({
      spaceId: 'spc-health',
      timezone: 'UTC',
      renderedEvents: 'Task completed.',
      events: [],
    })

    expect(report.facts[0]?.sourceRefs).toEqual(['event:spc-health:2026-09-30:1'])
    expect(router.callLog()).toMatchObject([
      { purpose: 'reflection', origin: 'proactive', spaceId: 'spc-health' },
    ])
    expect(router.usage().tiers.reasoning.spentUsd).toBe(0.03)
  })
})
