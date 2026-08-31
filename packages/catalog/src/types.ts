import type { AtomNode, JsonObject, JsonValue } from '@veduta/protocol'
import type { ReactNode } from 'react'
import type { CatalogTheme } from './design-system.ts'

export interface SurfaceUpdateFeedback {
  key: string
  atomIds: readonly string[]
}

/** What the renderer hands to every Atom. */
export interface RenderContext {
  /** The Surface's typed state (Atoms read via `binding`). */
  state: JsonObject
  /** Design-system theme. Defaults to light. */
  theme?: CatalogTheme
  /** Dispatch a declared action. The renderer never decides fast vs agent — the Atom's declaration does (ADR-0003). */
  dispatch: (node: AtomNode, actionName: string, value?: JsonValue) => void | Promise<void>
  /** Transient visual feedback supplied by the Surface host; never persisted in the Surface. */
  motion?: {
    update?: SurfaceUpdateFeedback
  }
}

export interface AtomProps {
  node: AtomNode
  ctx: RenderContext
  /** The node's children, already rendered by the tree walker. */
  children?: ReactNode
}
