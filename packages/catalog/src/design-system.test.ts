import { describe, expect, it } from 'vitest'
import { catalogTokens } from './design-system.ts'

describe('dark catalog color semantics', () => {
  it('keeps the primary action accent distinct from success and its text readable', () => {
    const accent = rgb(catalogTokens.dark.color.accent)
    const success = rgb(catalogTokens.dark.color.success)

    expect(rgbDistance(accent, success)).toBeGreaterThan(100)
    expect(contrastRatio(rgb(catalogTokens.dark.color.accentText), accent)).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it.each(['surface', 'surfaceMuted', 'surfaceRaised'] as const)(
    'keeps normal and muted text readable on %s',
    (surfaceName) => {
      const surface = rgb(catalogTokens.dark.color[surfaceName])

      expect(contrastRatio(rgb(catalogTokens.dark.color.text), surface)).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(rgb(catalogTokens.dark.color.textMuted), surface),
      ).toBeGreaterThanOrEqual(4.5)
    },
  )
})

function rgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error('expected an opaque six-digit hex: ' + hex)
  }
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ]
}

function rgbDistance(
  [redA, greenA, blueA]: [number, number, number],
  [redB, greenB, blueB]: [number, number, number],
): number {
  return Math.hypot(redA - redB, greenA - greenB, blueA - blueB)
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(color: [number, number, number]): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}
