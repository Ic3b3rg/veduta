import type { CatalogTheme } from '@veduta/catalog'
import { useSyncExternalStore } from 'react'

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

export function preferredTheme(): CatalogTheme {
  return window.matchMedia(DARK_SCHEME_QUERY).matches ? 'dark' : 'light'
}

export function subscribeToThemeChanges(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_SCHEME_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** The catalog theme matching the device color scheme, updated live. */
export function useCatalogTheme(): CatalogTheme {
  return useSyncExternalStore(subscribeToThemeChanges, preferredTheme)
}
