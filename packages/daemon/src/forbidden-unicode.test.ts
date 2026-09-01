import { describe, expect, it } from 'vitest'
import { sanitizeJsonForForbiddenUnicode, stripForbiddenUnicode } from './forbidden-unicode.ts'

describe('stripForbiddenUnicode', () => {
  it('removes exactly the forbidden injection-corpus code points and preserves joiners', () => {
    const forbiddenCodePoints = [
      0x200b,
      0x200e,
      0x200f,
      0xfeff,
      ...codePointsFrom(0x2028, 0x202e),
      ...codePointsFrom(0x2066, 0x2069),
      ...codePointsFrom(0xe0000, 0xe007f),
    ]
    const forbidden = forbiddenCodePoints.map((value) => String.fromCodePoint(value)).join('')
    const allowedNeighbors = [
      0x200a, 0x200c, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff00, 0xdffff,
      0xe0080,
    ]
      .map((value) => String.fromCodePoint(value))
      .join('')

    expect(stripForbiddenUnicode(`before${forbidden}after`)).toBe('beforeafter')
    expect(stripForbiddenUnicode(allowedNeighbors)).toBe(allowedNeighbors)
    expect(stripForbiddenUnicode('Persian:\u200C Indic/emoji:\u200D')).toBe(
      'Persian:\u200C Indic/emoji:\u200D',
    )
  })
})

describe('sanitizeJsonForForbiddenUnicode', () => {
  it('sanitizes every string leaf and object key through nested arrays and objects', () => {
    expect(
      sanitizeJsonForForbiddenUnicode({
        'sub\u200Bject': 'ro\u202Ead',
        nested: [{ 'ta\u2066g': `val\u{E0069}ue\u200C` }, ['kept\u200Djoiner']],
      }),
    ).toEqual({
      subject: 'road',
      nested: [{ tag: 'value\u200C' }, ['kept\u200Djoiner']],
    })
  })

  it('rejects an object when sanitizing its keys would overwrite a value', () => {
    expect(() =>
      sanitizeJsonForForbiddenUnicode({
        account: 'first',
        'acc\u200Bount': 'second',
      }),
    ).toThrow(/forbidden Unicode.*key collision/i)
  })
})

function codePointsFrom(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}
