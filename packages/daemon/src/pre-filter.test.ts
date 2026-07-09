import { describe, expect, it } from 'vitest'
import type { ExternalEvent } from './external-event.ts'
import { PreFilterRulesSchema, evaluatePreFilter, parseAddrSpec } from './pre-filter.ts'

const email = (overrides: Partial<ExternalEvent> = {}): ExternalEvent => ({
  source: 'mail',
  kind: 'email',
  externalId: 'msg-1',
  type: 'message.received',
  sender: 'Anna Rossi <anna@example.com>',
  subject: 'hello',
  ...overrides,
})

const rules = (input: unknown = {}) => PreFilterRulesSchema.parse(input)

describe('parseAddrSpec', () => {
  it('extracts and lowercases the addr-spec from a display-name form', () => {
    expect(parseAddrSpec('Anna Rossi <Anna@Example.COM>')).toBe('anna@example.com')
  })

  it('accepts bare addresses and rejects non-addresses', () => {
    expect(parseAddrSpec('anna@example.com')).toBe('anna@example.com')
    expect(parseAddrSpec('not an address')).toBeUndefined()
  })
})

describe('evaluatePreFilter', () => {
  it('accepts by default when no rule matches', () => {
    expect(evaluatePreFilter(email(), rules())).toEqual({ verdict: 'accept' })
  })

  it('discards blocklisted senders, including domain suffix rules', () => {
    expect(evaluatePreFilter(email(), rules({ blockSenders: ['anna@example.com'] }))).toEqual({
      verdict: 'discard',
      reason: 'sender-blocklisted',
    })
    expect(evaluatePreFilter(email(), rules({ blockSenders: ['@example.com'] }))).toEqual({
      verdict: 'discard',
      reason: 'sender-blocklisted',
    })
  })

  it('discards newsletters via List-Unsubscribe and Precedence headers', () => {
    const newsletter = email({ headers: { 'list-unsubscribe': '<mailto:u@x>' } })
    expect(evaluatePreFilter(newsletter, rules())).toEqual({
      verdict: 'discard',
      reason: 'newsletter',
    })
    const bulk = email({ headers: { precedence: 'Bulk' } })
    expect(evaluatePreFilter(bulk, rules())).toEqual({ verdict: 'discard', reason: 'newsletter' })
  })

  it('lets an allowlisted sender beat the newsletter heuristic', () => {
    const newsletter = email({ headers: { 'list-unsubscribe': '<mailto:u@x>' } })
    expect(evaluatePreFilter(newsletter, rules({ allowSenders: ['anna@example.com'] }))).toEqual({
      verdict: 'accept',
    })
  })

  it('never lets the allowlist beat the blocklist', () => {
    const both = rules({
      allowSenders: ['anna@example.com'],
      blockSenders: ['anna@example.com'],
    })
    expect(evaluatePreFilter(email(), both)).toEqual({
      verdict: 'discard',
      reason: 'sender-blocklisted',
    })
  })

  it('enforces type allow and block lists', () => {
    expect(evaluatePreFilter(email(), rules({ blockTypes: ['message.received'] }))).toEqual({
      verdict: 'discard',
      reason: 'type-blocked',
    })
    expect(evaluatePreFilter(email(), rules({ allowTypes: ['calendar.updated'] }))).toEqual({
      verdict: 'discard',
      reason: 'type-not-allowed',
    })
  })

  it('keeps the newsletter heuristic off non-email kinds', () => {
    const webhook = email({ kind: 'webhook', headers: { 'list-unsubscribe': '<x>' } })
    expect(evaluatePreFilter(webhook, rules())).toEqual({ verdict: 'accept' })
  })

  it('consults the similarity hook only when a threshold is configured', () => {
    const scored = rules({ similarityThreshold: 0.5 })
    expect(evaluatePreFilter(email(), scored, () => 0.2)).toEqual({
      verdict: 'discard',
      reason: 'below-similarity-threshold',
    })
    expect(evaluatePreFilter(email(), scored, () => 0.9)).toEqual({ verdict: 'accept' })
    expect(evaluatePreFilter(email(), scored, () => undefined)).toEqual({ verdict: 'accept' })
    expect(evaluatePreFilter(email(), rules(), () => 0)).toEqual({ verdict: 'accept' })
  })
})
