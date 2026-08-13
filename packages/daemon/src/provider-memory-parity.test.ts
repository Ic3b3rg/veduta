import { describe, expect, it } from 'vitest'
import {
  MEMORY_PARITY_DERIVED_FACT,
  MEMORY_PARITY_PRIMARY_FACT,
  MEMORY_PARITY_UNTRUSTED_EVENT,
  MEMORY_PARITY_UNTRUSTED_ORIGIN,
  runMemoryParityPair,
  type MemoryParityOutcome,
  type MemoryParityToolResult,
} from './provider-memory-parity-fixture.ts'

const EXPECTED_TOOL_CHAIN = [
  'write_fact',
  'search_memory',
  'read_recent',
  'search_log',
  'search_memory',
  'write_fact',
]

describe('AgentRunner Space-memory parity across Model connection methods (issue #75)', () => {
  it('preserves definitions, provenance, live taint, and persistent outcomes', async () => {
    const { byok, subscription } = await runMemoryParityPair()

    expect(subscription.outcome).toEqual(byok.outcome)

    const outcome = subscription.outcome
    expect(outcome.offeredDefinitions.map((definition) => definition.name)).toEqual([
      'write_fact',
      'append_event',
      'read_recent',
      'search_log',
      'search_memory',
    ])
    expect(outcome.toolResults.map((result) => result.toolName)).toEqual(EXPECTED_TOOL_CHAIN)
    expect(outcome.handlerExecution).toEqual({
      total: 6,
      distinctCallIds: 6,
      maxCallsPerId: 1,
      allContextHashesValid: true,
      byTool: {
        write_fact: 2,
        search_memory: 2,
        read_recent: 1,
        search_log: 1,
      },
    })

    expect(outcome.facts).toEqual([
      {
        state: 'active',
        text: MEMORY_PARITY_PRIMARY_FACT,
        noted: '2026-08-13',
      },
      {
        state: 'active',
        text: MEMORY_PARITY_DERIVED_FACT,
        noted: '2026-08-13',
        origin: MEMORY_PARITY_UNTRUSTED_ORIGIN,
      },
    ])
    expect(outcome.eventLog).toEqual([
      {
        type: 'fact.write',
        text: `FACTS add: ${MEMORY_PARITY_PRIMARY_FACT}`,
        origin: 'trusted:system',
      },
      {
        type: 'fact.write',
        text: `FACTS add: ${MEMORY_PARITY_DERIVED_FACT}`,
        origin: MEMORY_PARITY_UNTRUSTED_ORIGIN,
      },
    ])

    const factRetrieval = requireToolResult(outcome, 1, 'search_memory')
    expect(factRetrieval.content).toContain(MEMORY_PARITY_PRIMARY_FACT)
    expect(factRetrieval.origins).toBeUndefined()

    const recentRead = requireToolResult(outcome, 2, 'read_recent')
    expect(recentRead.origins).toEqual(['trusted:system'])

    for (const index of [3, 4]) {
      const untrustedRead = requireToolResult(
        outcome,
        index,
        index === 3 ? 'search_log' : 'search_memory',
      )
      expect(untrustedRead.content).toContain(MEMORY_PARITY_UNTRUSTED_EVENT)
      expect(untrustedRead.content).toContain('<<<UNTRUSTED data from gmail>>>')
      expect(untrustedRead.origins).toEqual([MEMORY_PARITY_UNTRUSTED_ORIGIN])
    }

    expect(outcome.taintBeforeCalls.map((call) => call.toolName)).toEqual(EXPECTED_TOOL_CHAIN)
    for (const call of outcome.taintBeforeCalls.slice(0, 4)) {
      expect(call.origins).not.toContain(MEMORY_PARITY_UNTRUSTED_ORIGIN)
    }
    for (const call of outcome.taintBeforeCalls.slice(4)) {
      expect(call.origins).toContain(MEMORY_PARITY_UNTRUSTED_ORIGIN)
    }

    expect(subscription.transport.requestMethods).toEqual(['thread/start', 'turn/start'])
    expect(subscription.transport.responseIds).toEqual([0, 1, 2, 3, 4, 5])
    expect(subscription.transport.toolResultTexts).toEqual(byok.toolResultTexts)
    expect(subscription.transport.turnStartText).not.toContain(MEMORY_PARITY_UNTRUSTED_EVENT)
    expect(subscription.transport.turnStartText).not.toContain('<<<UNTRUSTED')
  })
})

function requireToolResult(
  outcome: MemoryParityOutcome,
  index: number,
  toolName: string,
): MemoryParityToolResult {
  const result = outcome.toolResults[index]
  if (!result || result.toolName !== toolName) {
    throw new Error(`expected tool result ${index} to belong to ${toolName}`)
  }
  return result
}
