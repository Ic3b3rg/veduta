import type { CatalogTheme } from '@veduta/catalog'
import { createContext, useContext } from 'react'

/** Presentation inputs only; deterministic references never replace Gateway state (issue #162). */
export const PresentationContext = createContext<{
  theme?: CatalogTheme
  now?: number
  reducedMotion?: boolean
}>({})

export function usePresentation() {
  return useContext(PresentationContext)
}
