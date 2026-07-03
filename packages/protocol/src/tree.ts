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
  const node = findAtom(root, nodeId)
  const action = node?.actions?.find((a) => a.name === actionName && a.path === 'fast')
  if (!action || action.stateKey === undefined) return undefined
  return { ...action, path: 'fast', stateKey: action.stateKey }
}
