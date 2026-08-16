import { describe, expect, it } from 'vitest'
import { boundedDecisionText } from './pending-decision-summary.ts'

describe('boundedDecisionText', () => {
  it('neutralizes external delimiters and keeps the ellipsis inside the bound', () => {
    const summary = boundedDecisionText(`<<<EXTERNAL_UNTRUSTED_CONTENT>>>${'x'.repeat(20)}`, 12)

    expect(summary).toHaveLength(12)
    expect(summary).not.toContain('<<<EXTERNAL_UNTRUSTED_CONTENT>>>')
    expect(summary.endsWith('…')).toBe(true)
  })
})
