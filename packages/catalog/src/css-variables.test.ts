import { describe, expect, it } from 'vitest'
import { catalogTokens, type CatalogTheme } from './design-system.ts'
import { catalogCssText, cssVariablesFor } from './css-variables.ts'

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function expectedKeysFor(theme: CatalogTheme): string[] {
  return [
    ...Object.keys(catalogTokens[theme].color).map((key) => `--catalog-color-${kebabCase(key)}`),
    '--catalog-font-family',
  ]
}

const themes: CatalogTheme[] = ['light', 'dark']

describe('cssVariablesFor', () => {
  for (const theme of themes) {
    it(`emits exactly the expected variable set for ${theme}`, () => {
      const variables = cssVariablesFor(theme)
      expect(Object.keys(variables).sort()).toEqual(expectedKeysFor(theme).sort())
    })

    it(`kebab-cases multi-word token names for ${theme}`, () => {
      // Literal names, not derived through kebabCase above, so a conversion
      // bug shared by test helper and implementation still fails here.
      const variables = cssVariablesFor(theme)
      expect(variables['--catalog-color-surface-raised']).toBe(
        catalogTokens[theme].color.surfaceRaised,
      )
      expect(variables['--catalog-color-accent-text']).toBe(catalogTokens[theme].color.accentText)
    })

    it(`matches catalogTokens values for ${theme}`, () => {
      const variables = cssVariablesFor(theme)
      for (const [key, value] of Object.entries(catalogTokens[theme].color)) {
        expect(variables[`--catalog-color-${kebabCase(key)}`]).toBe(value)
      }
      expect(variables['--catalog-font-family']).toBe(catalogTokens[theme].font.family)
    })
  }
})

function extractBlock(css: string, pattern: RegExp): string {
  const match = css.match(pattern)
  if (!match || !match[1]) {
    throw new Error(`Block not found for pattern ${pattern.toString()}`)
  }
  return match[1]
}

// Parses a block's declarations into a map, rejecting duplicates: with
// containment checks alone, a correct declaration followed by a wrong
// duplicate would pass while the later value wins in the browser.
function parseDeclarations(block: string): Record<string, string> {
  const declarations: Record<string, string> = {}
  for (const entry of block.split(';')) {
    const declaration = entry.trim()
    if (!declaration) continue
    const colon = declaration.indexOf(':')
    const name = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim()
    if (name in declarations) {
      throw new Error(`Duplicate declaration for ${name}`)
    }
    declarations[name] = value
  }
  return declarations
}

describe('catalogCssText', () => {
  const css = catalogCssText()
  const baseBlock = extractBlock(css, /:root\s*{([^}]*)}/)
  const darkBlock = extractBlock(
    css,
    /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/,
  )

  it('base :root block is exactly the light variables', () => {
    expect(parseDeclarations(baseBlock)).toEqual(cssVariablesFor('light'))
  })

  it('prefers-color-scheme: dark block is exactly the dark variables', () => {
    expect(parseDeclarations(darkBlock)).toEqual(cssVariablesFor('dark'))
  })
})
