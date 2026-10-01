import { randomUUID } from 'node:crypto'
import {
  findAtom,
  owningActionInputs,
  type FastActionInvocation,
  type JsonObject,
  type JsonValue,
} from '@veduta/protocol'
import type { Store } from './store.ts'
import { SurfaceCommitRecoveryPendingError } from './surface-commit.ts'
import { walkAtomTree } from './templates.ts'

const intents = new Map<string, string>()
function fixtureIntent(key?: string): string {
  if (key === undefined) return randomUUID()
  const previous = intents.get(key)
  if (previous) return previous
  const id = randomUUID()
  intents.set(key, id)
  return id
}

/** Canonical identities for tests that exercise the public owning interaction. */
export function fastInvocation(
  store: Store,
  surfaceId: string,
  nodeId: string,
  name: string,
  inputs: JsonObject = {},
  intentKey?: string,
): FastActionInvocation {
  const surface = store.getSurface(surfaceId)
  const action =
    surface && findAtom(surface.tree, nodeId)?.actions?.find((action) => action.name === name)
  if (action?.path !== 'fast' || !action.revision)
    throw new Error('test requires a canonical declared fast Action')
  return {
    nodeId,
    name,
    actionRevision: action.revision,
    intentId: fixtureIntent(intentKey),
    inputs,
  }
}

/** The cross-family recovery fixtures require Event delivery before their mutation returns. */
export function commitFastAction(
  store: Store,
  surfaceId: string,
  target: string,
  value: JsonValue,
  intentKey?: string,
) {
  const surface = store.getSurface(surfaceId)
  if (!surface) throw new Error('test Surface missing')
  let invocation: FastActionInvocation | undefined
  walkAtomTree(surface.tree, (node) => {
    if (invocation) return
    const action = node.actions?.find(
      (action) => action.path === 'fast' && Object.hasOwn(action.plan.targets, target),
    )
    if (action?.path !== 'fast') return
    const owned = owningActionInputs(node)
    invocation = fastInvocation(
      store,
      surfaceId,
      node.id,
      action.name,
      Object.hasOwn(owned, 'value') ? { value } : {},
      intentKey,
    )
  })
  if (!invocation) throw new Error(`test requires a declared Action targeting ${target}`)
  const result = store.invokeSurfaceAction(surfaceId, invocation)
  if (result.path !== 'fast') throw new Error('fast Action required')
  if (result.outcome.outcome === 'recovery_pending')
    throw new SurfaceCommitRecoveryPendingError(
      result.outcome.surfaceCommitId,
      result.outcome.spaceId,
    )
  return result.outcome
}
