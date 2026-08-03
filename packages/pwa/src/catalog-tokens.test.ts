// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { catalogCssText } from '@veduta/catalog'
import { installCatalogTokens } from './catalog-tokens.ts'

// The drift gate in app-css-tokens.test.ts only proves the stylesheet text
// is right; this proves the shell actually installs the catalog variables
// the aliases reference.
describe('installCatalogTokens', () => {
  it('installs one style element carrying the generated catalog stylesheet', () => {
    installCatalogTokens()

    const styles = document.head.querySelectorAll('style[data-catalog-tokens]')
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toBe(catalogCssText())
  })

  it('is idempotent: a second run reuses the element instead of stacking', () => {
    installCatalogTokens()
    installCatalogTokens()

    expect(document.head.querySelectorAll('style[data-catalog-tokens]')).toHaveLength(1)
  })
})
