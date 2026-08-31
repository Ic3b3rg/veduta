import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { catalogCssText, catalogTokens } from '@veduta/catalog'

// Drift gate for issue 024 (issues/024-shell-tokens-from-catalog.md): the
// shell shares colors with the catalog design system only through the
// derived --catalog-* variables injected by main.tsx. Reading the built
// stylesheet and static entry files from disk (rather than importing
// modules) is deliberate: it verifies exactly what ships, including the
// two files that cannot reference CSS custom properties at all.

// Comments are stripped before any parsing so a commented-out declaration
// can never satisfy a guard as if it were live CSS.
function readCssWithImports(url: URL, seen = new Set<string>()): string {
  if (seen.has(url.href)) throw new Error(`cyclic CSS import: ${url.href}`)
  seen.add(url.href)
  const source = readFileSync(url, 'utf8')
  return source.replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_statement, path: string) =>
    readCssWithImports(new URL(path, url), seen),
  )
}

const appCss = readCssWithImports(new URL('./app.css', import.meta.url)).replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
) as { theme_color: string; background_color: string }

// -- small pure helpers ----------------------------------------------------

function extractBlock(css: string, pattern: RegExp): string {
  const match = css.match(pattern)
  if (!match || !match[1]) {
    throw new Error(`Block not found for pattern ${pattern.toString()}`)
  }
  return match[1]
}

const baseBlock = extractBlock(appCss, /:root\s*{([^}]*)}/)
const darkBlock = extractBlock(
  appCss,
  /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/,
)

// Anchored on the full custom-property name (not preceded or followed by a
// word/hyphen char) so `--text` never also matches `--text-muted` or
// `--text-soft`, and matching is independent of where in a line the
// declaration sits.
function propertyPattern(property: string): string {
  return `(?<![\\w-])${property}(?![\\w-])`
}

function declarationValue(block: string, property: string): string | undefined {
  const pattern = new RegExp(`${propertyPattern(property)}\\s*:\\s*([^;]+);`)
  return block
    .match(pattern)?.[1]
    ?.trim()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
}

function declarationCount(css: string, property: string): number {
  const pattern = new RegExp(`${propertyPattern(property)}\\s*:`, 'g')
  return css.match(pattern)?.length ?? 0
}

function metaThemeColor(html: string, media: string): string {
  const escapedMedia = media.replace(/[()]/g, '\\$&')
  const pattern = new RegExp(`<meta name="theme-color" media="${escapedMedia}" content="([^"]+)"`)
  const match = html.match(pattern)
  if (!match || !match[1]) {
    throw new Error(`theme-color meta not found for media ${media}`)
  }
  return match[1]
}

// -- guard 1: cascade safety -----------------------------------------------

describe('derived aliases are declared once, in the base block, at the expected value', () => {
  const aliases: Array<[string, string]> = [
    ['--text', 'var(--catalog-color-text)'],
    ['--text-muted', 'var(--catalog-color-text-muted)'],
    ['--surface', 'var(--catalog-color-surface-raised)'],
    ['--border', 'var(--catalog-color-border)'],
    ['--accent', 'var(--catalog-color-accent)'],
    ['--accent-text', 'var(--catalog-color-accent-text)'],
    ['--focus', 'var(--catalog-color-focus)'],
    ['--chat-dock-bg', 'var(--surface)'],
  ]

  for (const [name, expected] of aliases) {
    it(`${name} resolves to ${expected} and is absent from the dark block`, () => {
      expect(declarationCount(appCss, name)).toBe(1)
      expect(declarationValue(baseBlock, name)).toBe(expected)
      expect(declarationValue(darkBlock, name)).toBeUndefined()
    })
  }

  it('base :root font-family is the catalog font family', () => {
    expect(declarationValue(baseBlock, 'font-family')).toBe('var(--catalog-font-family)')
  })
})

// -- guard 1b: referenced catalog variables exist -----------------------------

describe('every --catalog-* variable referenced by the PWA styles is one the catalog declares', () => {
  // Guard 1 pins the literal stylesheet text, so renaming a token in
  // catalogTokens (name drift, not value drift) would leave these var()
  // references dangling -- resolving to nothing at runtime -- while the
  // stylesheet text stays unchanged. Cross-checking the references against
  // the generated stylesheet closes that hole.
  it('finds every referenced variable declared in catalogCssText()', () => {
    const referenced = [...new Set(appCss.match(/--catalog-[a-z0-9-]+/g) ?? [])]
    const generated = catalogCssText()
    expect(referenced.length).toBeGreaterThan(0)
    const dangling = referenced.filter((name) => !generated.includes(`${name}:`))
    expect(dangling).toEqual([])
  })

  it('never declares a --catalog-* variable itself, which would override the catalog', () => {
    expect(appCss).not.toMatch(/--catalog-[a-z0-9-]+\s*:/)
  })
})

// -- guard 2: dark status references pinned ---------------------------------

describe('dark status text aliases reference the raw catalog status tokens', () => {
  const darkStatusAliases: Array<[string, string]> = [
    ['--success-text', 'var(--catalog-color-success)'],
    ['--warning-text', 'var(--catalog-color-warning)'],
    ['--danger-text', 'var(--catalog-color-danger)'],
  ]

  for (const [name, expected] of darkStatusAliases) {
    it(`${name} in the dark block is ${expected}`, () => {
      expect(declarationValue(darkBlock, name)).toBe(expected)
    })
  }
})

describe('topbar action hierarchy', () => {
  it('does not synthesize a decorative mark beside the Veduta wordmark', () => {
    expect(appCss).not.toContain('.topbar h1::before')
  })

  it('keeps the Install action accented instead of applying the secondary material', () => {
    const installBlock = extractBlock(appCss, /\.install-button\s*{([^}]*)}/)

    expect(appCss).toContain('.topbar-utilities > button:not(.install-button),')
    expect(declarationValue(installBlock, 'background')).toBe('var(--accent)')
    expect(declarationValue(installBlock, 'color')).toBe('var(--accent-text)')
  })
})

describe('solid shell materials', () => {
  it('does not depend on blur or glass-only aliases', () => {
    expect(appCss).not.toMatch(/--glass-|backdrop-filter/)
  })
})

describe('button interaction states', () => {
  it('routes neutral hover and active colors through overridable variant properties', () => {
    const buttonBlock = extractBlock(appCss, /button\s*{([^}]*)}/)
    const hoverBlock = extractBlock(appCss, /button:hover:not\(:disabled\)\s*{([^}]*)}/)
    const activeBlock = extractBlock(appCss, /button:active:not\(:disabled\)\s*{([^}]*)}/)

    expect(declarationValue(buttonBlock, '--button-hover-bg')).toBe('var(--control-hover)')
    expect(declarationValue(buttonBlock, '--button-active-bg')).toBe(
      'color-mix(in srgb, var(--text) 8%, var(--surface))',
    )
    expect(declarationValue(hoverBlock, 'background')).toBe('var(--button-hover-bg)')
    expect(declarationValue(activeBlock, 'background')).toBe('var(--button-active-bg)')
  })

  it('gives every primary button a contrast-preserving interaction variant', () => {
    const installBlock = extractBlock(appCss, /\.install-button\s*{([^}]*)}/)
    const chatAndAuthBlock = extractBlock(
      appCss,
      /\.chat-compose button,\s*\.auth-form button\s*{([^}]*)}/,
    )
    const wizardBlock = extractBlock(appCss, /\.wizard-actions button\s*{([^}]*)}/)

    for (const block of [installBlock, chatAndAuthBlock, wizardBlock]) {
      expect(declarationValue(block, '--button-hover-bg')).toBe('var(--accent-hover)')
      expect(declarationValue(block, '--button-active-bg')).toBe('var(--accent-active)')
    }

    expect(declarationValue(baseBlock, '--accent-hover')).toBe(
      'color-mix(in srgb, var(--accent) 88%, black 12%)',
    )
    expect(declarationValue(darkBlock, '--accent-hover')).toBe(
      'color-mix(in srgb, var(--accent) 88%, white 12%)',
    )
  })
})

describe('compact mobile shell geometry', () => {
  it('lets the topbar scroll away on narrower viewports', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.topbar\s*{[^}]*position:\s*static;/,
    )
  })

  it('keeps a compact, wrapping multi-row chat history on narrow phones', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.chat-log\s*{[^}]*max-height:\s*48px;/,
    )
    expect(appCss).not.toMatch(/\.chat-entry span\s*{[^}]*white-space:\s*nowrap;/)
  })

  it('keeps narrow-phone utility controls touchable and the rail on one row', () => {
    expect(appCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.space-rail\s*{[^}]*minmax\(92px, 1fr\)/,
    )
    expect(appCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.topbar-utilities > button\.topbar-model-connections,[\s\S]*?min-height:\s*44px;/,
    )
    expect(appCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.chat-scroll-to-bottom\s*{[^}]*height:\s*44px;/,
    )
    expect(appCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.surface-pin\s*{[^}]*min-width:\s*44px;/,
    )
  })
})

// -- guard 3: duplication scanner (secondary guard) -------------------------

describe('no hand-authored hex literal duplicates a catalog color', () => {
  // PWA styles only hand-author hex and rgba(...) literals, plus the
  // derived color-mix() alias asserted above -- so hex equality against
  // catalogTokens is a sufficient literal check here. Hex is normalized to
  // opaque 6-digit form (#abc expands, alpha digits drop) so a shorthand or
  // alpha variant of a catalog color cannot slip through. The primary drift
  // gate is the exact alias assertions in guards 1, 1b, and 2 above; this
  // scanner only catches a stray hand-authored literal that happens to
  // match a catalog color.
  function normalizeHex(hex: string): string {
    const digits = hex.slice(1).toLowerCase()
    const expanded =
      digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
    return `#${expanded.slice(0, 6)}`
  }

  const hexInAppCss = new Set((appCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map(normalizeHex))

  const catalogHexValues = new Set(
    (['light', 'dark'] as const).flatMap((theme) =>
      Object.values(catalogTokens[theme].color).map((value) => value.toLowerCase()),
    ),
  )

  it('has no overlap between PWA stylesheet hex literals and catalogTokens colors', () => {
    const overlap = [...hexInAppCss].filter((hex) => catalogHexValues.has(hex))
    expect(overlap).toEqual([])
  })
})

// -- guard 4: static metadata guard ------------------------------------------

describe('static metadata pins the same colors as the catalog and app.css', () => {
  // index.html and manifest.webmanifest are static files parsed before any
  // stylesheet runs, so they cannot reference CSS custom properties -- exact
  // literal equality against catalogTokens / the loaded styles is asserted instead.
  it('index.html light theme-color matches catalogTokens.light.color.accent', () => {
    expect(metaThemeColor(indexHtml, '(prefers-color-scheme: light)')).toBe(
      catalogTokens.light.color.accent,
    )
  })

  it('index.html dark theme-color matches the dark --page-bg', () => {
    const pageBgDark = declarationValue(darkBlock, '--page-bg')
    expect(metaThemeColor(indexHtml, '(prefers-color-scheme: dark)')).toBe(pageBgDark)
  })

  it('manifest theme_color matches catalogTokens.light.color.accent', () => {
    expect(manifest.theme_color).toBe(catalogTokens.light.color.accent)
  })

  it('manifest background_color matches the base --page-bg', () => {
    const pageBgBase = declarationValue(baseBlock, '--page-bg')
    expect(manifest.background_color).toBe(pageBgBase)
  })
})
