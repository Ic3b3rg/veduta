import { catalogCssText } from '@veduta/catalog'

// The catalog design-system tokens are injected at runtime so the shell's
// shared variables cannot drift from catalogTokens (issue 024,
// issue #24). Idempotent: re-running replaces
// the content of the same style element instead of stacking duplicates.
export function installCatalogTokens(): void {
  let style = document.head.querySelector('style[data-catalog-tokens]')
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('data-catalog-tokens', '')
    document.head.appendChild(style)
  }
  style.textContent = catalogCssText()
}
