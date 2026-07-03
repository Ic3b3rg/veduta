import type { Action } from './action.ts'
import type { AtomNode } from './atom.ts'

/** Depth-first lookup of a node in a Surface tree. */
export function findAtom(root: AtomNode, id: string): AtomNode | undefined {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const hit = findAtom(child, id)
    if (hit) return hit
  }
  return undefined
}

/** Resolve an action declared by a node, regardless of path. */
export function findDeclaredAction(
  root: AtomNode,
  nodeId: string,
  actionName: string,
): Action | undefined {
  const node = findAtom(root, nodeId)
  return node?.actions?.find((action) => action.name === actionName)
}

/**
 * Resolve a fast action declared by a node, or undefined if the node
 * does not exist or does not declare it. This is the check behind the
 * fast-path contract (ADR-0003): clients invoke declared actions,
 * they never get to pick arbitrary state keys.
 */
export function findDeclaredFastAction(
  root: AtomNode,
  nodeId: string,
  actionName: string,
): (Action & { path: 'fast'; stateKey: string }) | undefined {
  const action = findDeclaredAction(root, nodeId, actionName)
  if (!action || action.stateKey === undefined) return undefined
  if (action.path !== 'fast') return undefined
  return { ...action, path: 'fast', stateKey: action.stateKey }
}

/** Resolve an Agent-path action declared by a node. */
export function findDeclaredAgentAction(
  root: AtomNode,
  nodeId: string,
  actionName: string,
): (Action & { path: 'agent' }) | undefined {
  const action = findDeclaredAction(root, nodeId, actionName)
  if (!action || action.path !== 'agent') return undefined
  return { ...action, path: 'agent' }
}
