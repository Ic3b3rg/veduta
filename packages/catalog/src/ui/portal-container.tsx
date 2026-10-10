import { createContext } from 'react'

/** Keeps temporary controls within an optional presentation boundary; defaults to the body. */
export const PortalContainerContext = createContext<HTMLElement | null>(null)
