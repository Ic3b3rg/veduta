import { describe, expect, it } from 'vitest'
import { canonicalJson, isJsonValue } from './json.ts'

describe('canonicalJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, 0] })).toBe(
      '{"list":[{"x":1,"y":2},0],"nested":{"a":1,"b":2},"z":1}',
    )
  })
})

describe('isJsonValue', () => {
  it('accepts recursive JSON values', () => {
    expect(isJsonValue({ text: 'value', nested: [null, true, 3, { ok: false }] })).toBe(true)
  })

  it('rejects values outside the protocol JSON contract', () => {
    expect(isJsonValue({ callback: () => undefined })).toBe(false)
    expect(isJsonValue(undefined)).toBe(false)
  })
})
