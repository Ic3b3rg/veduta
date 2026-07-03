import type { AtomNode } from '@veduta/protocol'

/** What the renderer hands to every Atom. */
export interface RenderContext {
  /** The Surface's typed state (Atoms read via `binding`). */
  state: Record<string, unknown>
  /** Dispatch a declared action. The renderer never decides fast vs agent — the Atom's declaration does (ADR-0003). */
  dispatch: (node: AtomNode, actionName: string, value?: unknown) => void
}

export interface AtomProps {
  node: AtomNode
  ctx: RenderContext
}
