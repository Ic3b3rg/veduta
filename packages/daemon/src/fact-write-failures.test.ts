import { describe, expect, it } from 'vitest'
import { FactWriteFailures } from './fact-write-failures.ts'
import { curateFact } from './facts.ts'

function tracker(focusedSpaceId?: string) {
  return new FactWriteFailures((target) =>
    target === 'health' ? 'spc-health' : (target ?? focusedSpaceId),
  )
}

describe('FACTS write failure feedback', () => {
  it.each([
    { first: 'I like celery now', retry: 'I like celery now' },
    { first: 'I like  celery now', retry: 'I like celery now' },
    { first: 'I like celery now', retry: ' I like  celery now ' },
  ])(
    'recovers the same canonical fact after correcting its supersedes target ($first → $retry)',
    ({ first, retry }) => {
      const failures = tracker('spc-health')
      failures.observe({
        type: 'tool-start',
        toolCallId: 'first',
        toolName: 'write_fact',
        input: { fact: first, supersedes: 'Unknown old fact' },
      })
      failures.observe({
        type: 'tool-result',
        toolCallId: 'first',
        toolName: 'write_fact',
        content: 'Unknown supersedes target',
        details: undefined,
        isError: true,
      })
      expect(failures.failure()).toContain('Unknown supersedes target')
      failures.observe({
        type: 'tool-start',
        toolCallId: 'second',
        toolName: 'write_fact',
        input: { fact: retry, supersedes: 'I dislike celery' },
      })
      failures.observe({
        type: 'tool-result',
        toolCallId: 'second',
        toolName: 'write_fact',
        content: 'FACTS update: I like celery now',
        details: {
          operation: 'update',
          fact: { text: 'I like celery now' },
          previous: { text: 'I dislike celery' },
        },
        isError: false,
      })
      expect(failures.failure()).toBeUndefined()
    },
  )

  it.each([undefined, 'spc-health'])(
    'does not clear a failed write when Chat saves the same fact in another Space (focus: %s)',
    (spaceId) => {
      const failures = tracker(spaceId)
      failures.observe({
        type: 'tool-start',
        toolCallId: 'first',
        toolName: 'write_fact',
        input: { spaceId: 'spc-health', fact: 'I like tea' },
      })
      failures.observe({
        type: 'tool-result',
        toolCallId: 'first',
        toolName: 'write_fact',
        content: 'Write rejected',
        details: undefined,
        isError: true,
      })
      failures.observe({
        type: 'tool-start',
        toolCallId: 'second',
        toolName: 'write_fact',
        input: { spaceId: 'spc-work', fact: 'I like tea' },
      })
      failures.observe({
        type: 'tool-result',
        toolCallId: 'second',
        toolName: 'write_fact',
        content: 'FACTS add: I like tea',
        details: undefined,
        isError: false,
      })
      expect(failures.failure()).toBe('A FACTS change was not saved: Write rejected')
      failures.reset()
      expect(failures.failure()).toBeUndefined()
    },
  )

  it('retains a rejected replacement when the same candidate is only added', () => {
    const failures = tracker('spc-health')
    const input = { fact: 'Breakfast at 8', supersedes: 'Breakfast at 07:00' }
    failures.observe({ type: 'tool-start', toolCallId: 'replace', toolName: 'write_fact', input })
    failures.observe({
      type: 'tool-result',
      toolCallId: 'replace',
      toolName: 'write_fact',
      content: 'Unknown supersedes target',
      details: undefined,
      isError: true,
    })
    const added = curateFact(
      { active: [{ text: 'Breakfast at 7' }], dormant: [], superseded: [] },
      input.fact,
      '2026-10-09',
    )
    expect(added.operation).toBe('add')
    expect(added.document.active.map((fact) => fact.text)).toEqual([
      'Breakfast at 7',
      'Breakfast at 8',
    ])
    failures.observe({
      type: 'tool-start',
      toolCallId: 'add',
      toolName: 'write_fact',
      input: { fact: input.fact },
    })
    failures.observe({
      type: 'tool-result',
      toolCallId: 'add',
      toolName: 'write_fact',
      content: 'FACTS add: Breakfast at 8',
      details: added,
      isError: false,
    })
    expect(failures.failure()).toContain('Unknown supersedes target')
  })

  it('recognizes the same Space by slug and id when a canonical replacement recovers the failure', () => {
    const failures = tracker()
    const fact = 'Breakfast at 8'
    failures.observe({
      type: 'tool-start',
      toolCallId: 'first',
      toolName: 'write_fact',
      input: { spaceId: 'health', fact, supersedes: 'Breakfast at 07:00' },
    })
    failures.observe({
      type: 'tool-result',
      toolCallId: 'first',
      toolName: 'write_fact',
      content: 'Unknown supersedes target',
      details: undefined,
      isError: true,
    })
    failures.observe({
      type: 'tool-start',
      toolCallId: 'second',
      toolName: 'write_fact',
      input: { spaceId: 'spc-health', fact, supersedes: 'Breakfast at 7' },
    })
    const corrected = curateFact(
      { active: [{ text: 'Breakfast at 7' }], dormant: [], superseded: [] },
      fact,
      '2026-10-09',
      undefined,
      { supersedes: 'Breakfast at 7' },
    )
    failures.observe({
      type: 'tool-result',
      toolCallId: 'second',
      toolName: 'write_fact',
      content: 'FACTS update: Breakfast at 8',
      details: corrected,
      isError: false,
    })
    expect(corrected.document.active.map((item) => item.text)).toEqual(['Breakfast at 8'])
    expect(corrected.document.superseded.map((item) => item.text)).toEqual(['Breakfast at 7'])
    expect(failures.failure()).toBeUndefined()
  })
})
