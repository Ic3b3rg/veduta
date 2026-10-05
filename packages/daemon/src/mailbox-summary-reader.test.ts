import { expect, it } from 'vitest'
import { MailboxSummaryReader } from './mailbox-summary-reader.ts'
import { ModelRouter } from './model-routing.ts'
import { buildReaderPrompt, parseAndSanitize } from './quarantined-reader.ts'

it('supplies the same bounded extraction contract to both quarantined reader paths', async () => {
  const prompts = [
    buildReaderPrompt({ source: 'mail', kind: 'email', externalId: 'one', type: 'received' }),
  ]
  const router = new ModelRouter({
    config: {
      tiers: {
        triage: [{ provider: 'mock', modelId: 'reader' }],
        reasoning: [{ provider: 'mock', modelId: 'reader' }],
      },
      providerKeys: {},
      connectionKeys: {},
      dailyCapUsd: { triage: 5, reasoning: 5 },
    },
  })
  const output = {
    intent: 'newsletter',
    entities: [],
    deadlines: [],
    urgency: 'low',
    summary: 'A market update.',
  }
  const reader = new MailboxSummaryReader(router, async (_model, prompt) => {
    prompts.push(prompt)
    return { text: JSON.stringify(output) }
  })
  expect(
    await reader.extract('spc-health', {
      providerId: 'one',
      sender: 'newsletter@example.test',
      subject: 'Market update',
      body: 'A market update.',
    }),
  ).toEqual({ ...output, providerId: 'one' })
  for (const prompt of prompts) {
    const contract = JSON.parse(prompt.split('Schema: ')[1]!.split('\n')[0]!)
    expect(contract.properties.intent.enum).toContain('newsletter')
    expect(contract.properties.urgency.enum).toEqual(['low', 'normal', 'high'])
    expect(contract.properties.summary.maxLength).toBe(500)
    expect(contract.properties.entities.maxItems).toBe(12)
    expect(contract.properties.deadlines.items.format).toBe('date-time')
    expect(contract.additionalProperties).toBe(false)
  }
  // Supplying the contract must not make the real malformed completion acceptable.
  expect(
    parseAndSanitize(JSON.stringify({ ...output, intent: 'Market update', urgency: 'Low' })).ok,
  ).toBe(false)
})
