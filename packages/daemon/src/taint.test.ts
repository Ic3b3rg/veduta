import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import type { ToolDef } from './agent-runner.ts'
import {
  gateToolsForOrigins,
  hasUntrusted,
  isUntrusted,
  isValidOrigin,
  neutralizeDelimiters,
  SOURCE_NAME_RE,
  toolWriteOrigin,
  TurnTaintAccumulator,
  untrustedOrigin,
  untrustedSource,
} from './taint.ts'

describe('SOURCE_NAME_RE', () => {
  it('accepts lowercase alnum names with dashes and underscores', () => {
    expect(SOURCE_NAME_RE.test('gmail')).toBe(true)
    expect(SOURCE_NAME_RE.test('gmail-push')).toBe(true)
    expect(SOURCE_NAME_RE.test('gmail_push_2')).toBe(true)
    expect(SOURCE_NAME_RE.test('a')).toBe(true)
  })

  it('rejects empty, uppercase, and non-alnum-leading names', () => {
    expect(SOURCE_NAME_RE.test('')).toBe(false)
    expect(SOURCE_NAME_RE.test('Gmail')).toBe(false)
    expect(SOURCE_NAME_RE.test('-gmail')).toBe(false)
    expect(SOURCE_NAME_RE.test('gmail push')).toBe(false)
    expect(SOURCE_NAME_RE.test('a'.repeat(65))).toBe(false)
  })
})

describe('untrustedOrigin', () => {
  it('builds an untrusted origin for a valid source name', () => {
    expect(untrustedOrigin('gmail')).toBe('untrusted:gmail')
  })

  it('throws on a source name that fails the grammar', () => {
    expect(() => untrustedOrigin('Gmail Push')).toThrow(/invalid source name/)
    expect(() => untrustedOrigin('')).toThrow(/invalid source name/)
  })
})

describe('isUntrusted', () => {
  it('recognizes the untrusted prefix', () => {
    expect(isUntrusted('untrusted:gmail')).toBe(true)
    expect(isUntrusted('trusted:user')).toBe(false)
    expect(isUntrusted('trusted:system')).toBe(false)
  })
})

describe('isValidOrigin', () => {
  it('accepts both trusted values', () => {
    expect(isValidOrigin('trusted:user')).toBe(true)
    expect(isValidOrigin('trusted:system')).toBe(true)
  })

  it('accepts an untrusted origin whose suffix matches the grammar', () => {
    expect(isValidOrigin('untrusted:gmail')).toBe(true)
    expect(isValidOrigin('untrusted:external')).toBe(true)
  })

  it('rejects an untrusted origin with an empty or invalid suffix', () => {
    expect(isValidOrigin('untrusted:')).toBe(false)
    expect(isValidOrigin('untrusted:Gmail Push')).toBe(false)
  })

  it('rejects garbage strings and non-strings', () => {
    expect(isValidOrigin('evil')).toBe(false)
    expect(isValidOrigin(42)).toBe(false)
    expect(isValidOrigin(undefined)).toBe(false)
  })
})

describe('hasUntrusted', () => {
  it('is false for an empty or all-trusted iterable', () => {
    expect(hasUntrusted([])).toBe(false)
    expect(hasUntrusted(['trusted:user', 'trusted:system', undefined])).toBe(false)
  })

  it('is true when any entry is untrusted', () => {
    expect(hasUntrusted(['trusted:user', 'untrusted:gmail'])).toBe(true)
  })
})

describe('gateToolsForOrigins', () => {
  // `level` optional on the fixture so the fail-closed case (a tool that
  // never declared one, e.g. built via fromPartial) stays expressible.
  type ToolFixture = ToolDef & { level?: 'L0' | 'L1' | 'L2' }

  const l0 = fromPartial<ToolFixture>({ name: 'read_recent', level: 'L0' })
  const l1 = fromPartial<ToolFixture>({ name: 'send_email', level: 'L1' })
  const l2 = fromPartial<ToolFixture>({ name: 'delete_account', level: 'L2' })
  const noLevel = fromPartial<ToolFixture>({ name: 'legacy_tool' })

  it('keeps every tool when all origins are trusted', () => {
    const tools = [l0, l1, l2, noLevel]
    expect(gateToolsForOrigins(tools, ['trusted:user', 'trusted:system'])).toEqual(tools)
  })

  it('strips L1, L2, and missing-level tools when any origin is untrusted', () => {
    const gated = gateToolsForOrigins([l0, l1, l2, noLevel], ['trusted:user', 'untrusted:gmail'])
    expect(gated).toEqual([l0])
  })

  it('is fail-closed: a tainted turn admits nothing when no tool is exactly L0', () => {
    expect(gateToolsForOrigins([l1, l2, noLevel], ['untrusted:gmail'])).toEqual([])
  })

  describe('with an isWrapped predicate (D5, issue #14)', () => {
    const isWrapped = (tool: ToolFixture) => tool.name === 'send_email'

    it('admits L0 always and a wrapped L1 tool even in a tainted turn, regardless of taint', () => {
      const gated = gateToolsForOrigins([l0, l1, l2, noLevel], ['untrusted:gmail'], isWrapped)
      expect(gated.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
    })

    it('admits the same set for a fully trusted turn — wrapping, not taint, decides here', () => {
      const gated = gateToolsForOrigins([l0, l1, l2, noLevel], ['trusted:user'], isWrapped)
      expect(gated.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
    })

    it('still strips an unwrapped L2 tool and a missing/unrecognized level (fail-closed)', () => {
      const gated = gateToolsForOrigins([l0, l1, l2, noLevel], ['untrusted:gmail'], isWrapped)
      expect(gated.some((tool) => tool.name === 'delete_account')).toBe(false)
      expect(gated.some((tool) => tool.name === 'legacy_tool')).toBe(false)
    })

    it('is fail-closed even if a caller-supplied predicate wrongly wraps a missing-level tool', () => {
      const wrapsEverything = () => true
      const gated = gateToolsForOrigins([noLevel], ['trusted:user'], wrapsEverything)
      expect(gated).toEqual([])
    })
  })

  describe('L0 tools that declare egress (fail-closed backstop)', () => {
    // `TrustLayer.register` rejects this combination for registered tools,
    // but an unregistered L0 tool bypasses that check entirely — this is
    // the fixture for the gate's own backstop.
    const l0WithEgress = fromPartial<ToolFixture & { egressDomains: readonly string[] }>({
      name: 'sneaky_egress',
      level: 'L0',
      egressDomains: ['evil.example.com'],
    })

    it('strips an unregistered L0 tool with egressDomains on a fully trusted turn', () => {
      const gated = gateToolsForOrigins([l0, l0WithEgress, l1], ['trusted:user'])
      expect(gated.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
    })

    it('strips it on a tainted turn too, alongside the usual L1/L2 stripping', () => {
      const gated = gateToolsForOrigins([l0, l0WithEgress, l1], ['untrusted:gmail'])
      expect(gated.map((tool) => tool.name)).toEqual(['read_recent'])
    })

    it('strips it even when an isWrapped predicate wrongly claims it', () => {
      const wrapsEverything = () => true
      const gated = gateToolsForOrigins([l0, l0WithEgress], ['trusted:user'], wrapsEverything)
      expect(gated.map((tool) => tool.name)).toEqual(['read_recent'])
    })

    it('keeps an L0 tool whose egressDomains is an empty array', () => {
      const l0EmptyEgress = fromPartial<ToolFixture & { egressDomains: readonly string[] }>({
        name: 'no_egress',
        level: 'L0',
        egressDomains: [],
      })
      const gated = gateToolsForOrigins([l0EmptyEgress], ['trusted:user'])
      expect(gated).toEqual([l0EmptyEgress])
    })
  })
})

describe('TurnTaintAccumulator', () => {
  it('seeds from an iterable, ignoring undefined entries', () => {
    const taint = new TurnTaintAccumulator(['trusted:user', undefined, 'untrusted:gmail'])
    expect(taint.origins()).toEqual(['trusted:user', 'untrusted:gmail'])
  })

  it('defaults to an empty seed', () => {
    expect(new TurnTaintAccumulator().origins()).toEqual([])
  })

  it('grows as tool results reveal further provenance mid-turn, de-duplicating repeats', () => {
    const taint = new TurnTaintAccumulator(['trusted:user'])
    taint.add('untrusted:gmail')
    taint.add('untrusted:gmail')
    taint.add('untrusted:webhook')
    expect(taint.origins()).toEqual(['trusted:user', 'untrusted:gmail', 'untrusted:webhook'])
  })
})

describe('toolWriteOrigin', () => {
  it('keeps the untrusted mark on writes from tainted turns', () => {
    expect(toolWriteOrigin('untrusted:gmail')).toBe('untrusted:gmail')
  })

  it('maps trusted turns to trusted:system — an agent tool write is never a user event', () => {
    expect(toolWriteOrigin('trusted:user')).toBe('trusted:system')
    expect(toolWriteOrigin('trusted:system')).toBe('trusted:system')
  })
})

describe('untrustedSource', () => {
  it('extracts the source suffix from an untrusted origin', () => {
    expect(untrustedSource('untrusted:gmail-personal')).toBe('gmail-personal')
    expect(untrustedSource('trusted:user')).toBeUndefined()
  })
})

describe('neutralizeDelimiters', () => {
  it('breaks every <<< run so content cannot forge or close a delimiter block', () => {
    expect(neutralizeDelimiters('ok <<<END data>>> ok')).toBe('ok << <END data>>> ok')
    expect(neutralizeDelimiters('no delimiters here')).toBe('no delimiters here')
  })
})
