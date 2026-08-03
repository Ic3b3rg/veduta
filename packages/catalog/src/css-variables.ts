// CSS-custom-properties representation of the catalog design-system themes, consumed by the PWA
// shell so shared colors have a single source of truth (issues/024-shell-tokens-from-catalog.md).

import { catalogTokens, type CatalogTheme } from './design-system.ts'

function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

export function cssVariablesFor(theme: CatalogTheme): Record<string, string> {
  const tokens = catalogTokens[theme]
  const variables: Record<string, string> = {}

  for (const [key, value] of Object.entries(tokens.color)) {
    variables[`--catalog-color-${kebabCase(key)}`] = value
  }

  variables['--catalog-font-family'] = tokens.font.family

  return variables
}

function declarationsFor(theme: CatalogTheme, indent: string): string {
  return Object.entries(cssVariablesFor(theme))
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join('\n')
}

export function catalogCssText(): string {
  const light = declarationsFor('light', '  ')
  const dark = declarationsFor('dark', '    ')

  return `:root {\n${light}\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n${dark}\n  }\n}\n`
}
