import type { AtomNode, JsonObject, JsonValue } from '@veduta/protocol'
import type { ReactNode } from 'react'

/** What the renderer hands to every Atom. */
export interface RenderContext {
  /** The Surface's typed state (Atoms read via `binding`). */
  state: JsonObject
  /** Dispatch a declared action. The renderer never decides fast vs agent — the Atom's declaration does (ADR-0003). */
  dispatch: (node: AtomNode, actionName: string, value?: JsonValue) => void
}

export interface AtomProps {
  node: AtomNode
  ctx: RenderContext
  /** The node's children, already rendered by the tree walker. */
  children?: ReactNode
}
