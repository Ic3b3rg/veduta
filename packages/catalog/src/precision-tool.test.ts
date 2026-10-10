import { describe, expect, it } from 'vitest'
import { catalogCssText } from './css-variables.ts'
import { precisionToolCssText } from './precision-tool.ts'

describe('Precision Tool component recipes', () => {
  it('provides each shared component role using declared catalog tokens', () => {
    const css = precisionToolCssText()
    for (const role of [
      'surface',
      'control',
      'input',
      'menu',
      'overlay',
      'status',
      'focus',
      'motion',
    ]) {
      expect(css).toContain(`.recipe-${role}`)
    }
    const declarations = new Set(
      [...catalogCssText().matchAll(/(--catalog-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
    )
    const references = [...css.matchAll(/var\((--catalog-[a-z0-9-]+)/g)].map((match) => match[1])
    expect(references.length).toBeGreaterThan(0)
    expect(references.filter((name) => !declarations.has(name))).toEqual([])
    expect(css).not.toMatch(/backdrop-filter|linear-gradient|radial-gradient/)
    expect(css).toContain('(pointer: coarse)')
    expect(css).toContain('(prefers-reduced-motion: reduce)')
  })
})
