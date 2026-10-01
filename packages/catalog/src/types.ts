import type {
  KnownRenderableAtomNode,
  RenderableAtomNode,
  JsonObject,
  JsonValue,
} from '@veduta/protocol'
import type { ReactNode } from 'react'
import type { CatalogTheme } from './design-system.ts'

export interface SurfaceUpdateFeedback {
  key: string
  atomIds: readonly string[]
}

export interface FastActionConfirmation {
  path?: 'fast'
  intentId: string
  actionRevision: string
  inputs: JsonObject
  outcome: 'committed' | 'noop'
}

export interface AgentActionConfirmation {
  path: 'agent'
  intentId: string
  turnId: string
  payload: JsonObject
  outcome: 'completed'
}

export type ActionConfirmation = FastActionConfirmation | AgentActionConfirmation

export type ActionConfirmations = Record<string, Record<string, ActionConfirmation>>

export type ActionStatus = { status: 'pending' } | { status: 'queued' | 'failed'; message: string }

export type ActionStatuses = Record<string, Record<string, ActionStatus>>

/** What the renderer hands to every Atom. */
export interface RenderContext {
  /** The Surface's typed state (Atoms read via `binding`). */
  state: JsonObject
  /** Design-system theme. Defaults to light. */
  theme?: CatalogTheme
  /** Dispatch a declared action. The renderer never decides fast vs agent — the Atom's declaration does (ADR-0003). */
  dispatch: (
    node: KnownRenderableAtomNode,
    actionName: string,
    value?: JsonValue,
  ) => void | Promise<void>
  /** Completed runtime intents, scoped by Atom id and action name; never Surface state. */
  actionConfirmations?: ActionConfirmations | undefined
  /** Current runtime waits and recoverable failures, scoped by Atom id and action name. */
  actionStatuses?: ActionStatuses | undefined
  /** Consume the matching completion after reconciling a submitted local draft. */
  acknowledgeAction?: ((nodeId: string, actionName: string, intentId: string) => void) | undefined
  /** Transient visual feedback supplied by the Surface host; never persisted in the Surface. */
  motion?: {
    update?: SurfaceUpdateFeedback
  }
}

export interface AtomProps {
  node: KnownRenderableAtomNode
  ctx: RenderContext
  /** The node's children, already rendered by the tree walker. */
  children?: ReactNode
}

export interface RenderableAtomProps extends Omit<AtomProps, 'node'> {
  node: RenderableAtomNode
}
