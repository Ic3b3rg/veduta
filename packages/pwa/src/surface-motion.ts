import {
  SurfaceSchema,
  applySurfacePatch,
  collectNodeBindingRefs,
  type AtomNode,
  type JsonObject,
  type PatchOperation,
  type Surface,
} from '@veduta/protocol'

export type { SurfaceUpdateFeedback } from '@veduta/catalog'

/**
 * Resolves patch paths to the smallest visible Atom regions that can provide
 * feedback after the patch has been applied. State paths map through Atom
 * bindings; tree removals fall back to their nearest surviving ancestor.
 */
export function affectedAtomIdsForPatch(
  previous: Surface,
  next: Surface,
  operations: PatchOperation[],
): string[] {
  const affected = new Set<string>()
  let trackingSurface = surfaceWithAllBindingKeys(previous, next, operations)

  for (const operation of operations) {
    if (operation.target === 'state') {
      const stateKey = decodePointer(operation.path)[0]
      if (stateKey !== undefined) collectBoundAtomIds(next.tree, stateKey, affected)
      continue
    }

    if (operation.op === 'remove') {
      const parent = nearestAtomBeforeTarget(trackingSurface.tree, operation.path)
      if (parent && containsAtom(next.tree, parent.id)) affected.add(parent.id)
    } else if (operation.op === 'move') {
      const moved = atomAtPointer(trackingSurface.tree, operation.from)
      if (moved && containsAtom(next.tree, moved.id)) affected.add(moved.id)
    } else if (containsAtom(next.tree, operation.value.id)) {
      affected.add(operation.value.id)
    }

    trackingSurface = applySurfacePatch(trackingSurface, {
      surfaceId: trackingSurface.id,
      operations: [operation],
    })
  }

  return smallestVisibleRegions(next.tree, affected)
}

function surfaceWithAllBindingKeys(
  previous: Surface,
  next: Surface,
  operations: PatchOperation[],
): Surface {
  const state: JsonObject = { ...previous.state, ...next.state }
  const trees = [
    previous.tree,
    next.tree,
    ...operations.flatMap((operation) =>
      operation.target === 'tree' && (operation.op === 'add' || operation.op === 'replace')
        ? [operation.value]
        : [],
    ),
  ]

  for (const tree of trees) {
    for (const ref of collectNodeBindingRefs(tree, ['tree'])) {
      if (!Object.prototype.hasOwnProperty.call(state, ref.key)) state[ref.key] = null
    }
  }

  return SurfaceSchema.parse({ ...previous, state })
}

function collectBoundAtomIds(node: AtomNode, stateKey: string, ids: Set<string>): void {
  if (node.binding === stateKey) ids.add(node.id)
  for (const child of node.children ?? []) collectBoundAtomIds(child, stateKey, ids)
}

function nearestAtomBeforeTarget(root: AtomNode, pointer: string): AtomNode | undefined {
  let current: unknown = root
  let nearest: AtomNode | undefined = root

  for (const segment of decodePointer(pointer).slice(0, -1)) {
    current = childAt(current, segment)
    if (isAtomNode(current)) nearest = current
  }

  return nearest
}

function atomAtPointer(root: AtomNode, pointer: string): AtomNode | undefined {
  let current: unknown = root
  for (const segment of decodePointer(pointer)) current = childAt(current, segment)
  return isAtomNode(current) ? current : undefined
}

function childAt(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    const index = Number(segment)
    return Number.isInteger(index) && index >= 0 ? value[index] : undefined
  }
  return isRecord(value) ? value[segment] : undefined
}

function decodePointer(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function containsAtom(node: AtomNode, id: string): boolean {
  return node.id === id || (node.children ?? []).some((child) => containsAtom(child, id))
}

function smallestVisibleRegions(node: AtomNode, affected: Set<string>): string[] {
  if (affected.has(node.id)) return [node.id]
  return (node.children ?? []).flatMap((child) => smallestVisibleRegions(child, affected))
}

function isAtomNode(value: unknown): value is AtomNode {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
