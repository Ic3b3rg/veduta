import { describe, expect, it } from 'vitest'
import { FactWriteConfirmation } from './fact-write-confirmation.ts'
import { curateFact, emptyFactsDocument, type FactsDocument } from './facts.ts'

function tracker(focusedSpaceId?: string, readFacts: () => FactsDocument = emptyFactsDocument) {
  return new FactWriteConfirmation({
    resolveSpaceId: (target) => (target === 'health' ? 'spc-health' : (target ?? focusedSpaceId)),
    readSpace: () => ({ name: 'Health', facts: readFacts() }),
  })
}

describe('FACTS write failure feedback', () => {
  it.each([
    { operation: ['add'], persisted: true },
    { operation: 'bogus', persisted: false },
    { operation: 'add', persisted: false },
  ])(
    'keeps a rejected write failed until its recovery is valid and persisted ($operation / $persisted)',
    ({ operation, persisted }) => {
      const fact = 'I prefer tea'
      const facts = curateFact(emptyFactsDocument(), fact, '2026-10-09').document
      const confirmation = tracker('spc-health', () => (persisted ? facts : emptyFactsDocument()))
      confirmation.observe({
        type: 'tool-start',
        toolCallId: 'failed',
        toolName: 'write_fact',
        input: { fact },
      })
      confirmation.observe({
        type: 'tool-result',
        toolCallId: 'failed',
        toolName: 'write_fact',
        content: 'Disk write rejected',
        details: undefined,
        isError: true,
      })
      confirmation.observe({
        type: 'tool-start',
        toolCallId: 'retry',
        toolName: 'write_fact',
        input: { fact },
      })
      confirmation.observe({
        type: 'tool-result',
        toolCallId: 'retry',
        toolName: 'write_fact',
        content: 'Saved',
        details: { operation, fact: { text: fact } },
        isError: false,
      })
      expect(confirmation.failure()).toContain('Disk write rejected')
      expect(confirmation.feedback()).not.toContain('Remembered in')
    },
  )
  it('confirms current canonical facts with their Space, never a missing or superseded value', () => {
    let document: FactsDocument = emptyFactsDocument()
    const confirmation = new FactWriteConfirmation({
      resolveSpaceId: () => 'spc-health',
      readSpace: () => ({ name: 'Health', facts: document }),
    })
    const write = (id: string, fact: string, supersedes?: string) => {
      const result = curateFact(
        document,
        fact,
        '2026-10-09',
        undefined,
        supersedes ? { supersedes } : undefined,
      )
      confirmation.observe({
        type: 'tool-start',
        toolCallId: id,
        toolName: 'write_fact',
        input: { fact },
      })
      confirmation.observe({
        type: 'tool-result',
        toolCallId: id,
        toolName: 'write_fact',
        content: 'Unverified model-facing content',
        details: result,
        isError: false,
      })
      return result.document
    }
    const added = write('add', 'Breakfast at 7')
    expect(confirmation.feedback()).toBe('A FACTS write is not confirmed.')
    document = added
    expect(confirmation.feedback()).toBe('Remembered in “Health”: Breakfast at 7')
    document = write('replace', 'Breakfast at 8', 'Breakfast at 7')
    expect(confirmation.feedback()).toContain('Remembered in “Health”: Breakfast at 8')
    expect(confirmation.feedback()).not.toContain('Breakfast at 7')
    expect(confirmation.feedback()).not.toContain('Unverified model-facing content')
  })

  it('keeps malformed successes unconfirmed and distinguishes already remembered facts', () => {
    const facts = curateFact(emptyFactsDocument(), 'I prefer tea', '2026-10-09').document
    const confirmation = new FactWriteConfirmation({
      resolveSpaceId: () => 'spc-health',
      readSpace: () => ({ name: 'Health', facts }),
    })
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'bad',
      toolName: 'write_fact',
      input: { fact: 'I prefer tea' },
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'bad',
      toolName: 'write_fact',
      content: 'Saved',
      details: undefined,
      isError: false,
    })
    expect(confirmation.feedback()).toBe('A FACTS write is not confirmed.')
    confirmation.reset()
    const result = curateFact(facts, 'I prefer tea', '2026-10-09')
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'noop',
      toolName: 'write_fact',
      input: { fact: 'I prefer tea' },
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'noop',
      toolName: 'write_fact',
      content: 'Saved',
      details: result,
      isError: false,
    })
    expect(confirmation.feedback()).toBe('Already remembered in “Health”: I prefer tea')
  })

  it.each([
    { first: 'I like celery now', retry: 'I like celery now' },
    { first: 'I like  celery now', retry: 'I like celery now' },
    { first: 'I like celery now', retry: ' I like  celery now ' },
  ])(
    'recovers the same canonical fact after correcting its supersedes target ($first → $retry)',
    ({ first, retry }) => {
      const failures = tracker(
        'spc-health',
        () => curateFact(emptyFactsDocument(), retry, '2026-10-09').document,
      )
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
    let persisted = emptyFactsDocument()
    const failures = tracker(undefined, () => persisted)
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
    persisted = corrected.document
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
