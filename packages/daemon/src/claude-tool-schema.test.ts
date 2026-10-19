import { describe, expect, it } from 'vitest'
import { compactClaudeToolSchema } from './claude-tool-schema.ts'
import { expandClaudeToolSchema } from './claude-tool-schema.test-helpers.ts'

describe('Claude tool schema context', () => {
  it('shares repeated schemas while preserving constraints and literal values', () => {
    const repeated = {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, description: 'The saved Surface title.' },
        value: { type: 'number', minimum: 0 },
      },
      required: ['title', 'value'],
      additionalProperties: false,
    }
    const literal = { type: 'object', properties: { nested: repeated } }
    const original = {
      type: 'object',
      properties: {
        first: repeated,
        second: { ...repeated },
        changed: { ...repeated, required: ['title'] },
        literal: { const: literal, default: literal, examples: [literal] },
      },
      required: ['first', 'second'],
    }
    const compact = compactClaudeToolSchema(original)
    expect(expandClaudeToolSchema(compact)).toEqual(original)
    expect(compact).toMatchObject({
      properties: {
        first: { $ref: expect.any(String) },
        second: { $ref: expect.any(String) },
        literal: { const: literal, default: literal, examples: [literal] },
      },
    })
    expect(original.properties.first).toEqual(repeated)
    expect(JSON.stringify(original)).not.toContain('$ref')
  })

  it('preserves schemas that already carry references or scoped identities', () => {
    for (const field of ['$ref', '$dynamicRef', '$id', '$anchor', '$dynamicAnchor']) {
      const schema = { type: 'object', properties: { value: { [field]: '#/existing' } } }
      expect(compactClaudeToolSchema(schema)).toEqual(schema)
    }
  })

  it('leaves a small schema alone', () => {
    const schema = { type: 'object', properties: { value: { type: 'number' } } }
    expect(compactClaudeToolSchema(schema)).toEqual(schema)
  })
})
