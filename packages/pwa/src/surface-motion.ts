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

/** Resolves a fast-path state mutation to every smallest Atom region bound to that state key. */
export function affectedAtomIdsForStateKey(root: AtomNode, stateKey: string): string[] {
  const affected = new Set<string>()
  collectBoundAtomIds(root, stateKey, affected)
  return smallestVisibleRegions(root, affected)
}

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
  const treeAffected = new Set<string>()
  const movedAtomIds = new Set<string>()
  const replacementOrigins = new Map<string, string>()
  const treeChanged = !valuesEqual(previous.tree, next.tree)
  let trackingSurface = surfaceWithAllBindingKeys(previous, next, operations)

  for (const operation of operations) {
    if (operation.target === 'state') {
      const stateKey = decodePointer(operation.path)[0]
      if (stateKey !== undefined && !valuesEqual(previous.state[stateKey], next.state[stateKey])) {
        collectBoundAtomIds(next.tree, stateKey, affected)
      }
      continue
    }

    const surfaceAfterOperation = applySurfacePatch(trackingSurface, {
      surfaceId: trackingSurface.id,
      operations: [operation],
    })
    if (!treeChanged || valuesEqual(trackingSurface.tree, surfaceAfterOperation.tree)) {
      trackingSurface = surfaceAfterOperation
      continue
    }

    if (operation.op === 'remove') {
      const parent = nearestAtomBeforeTarget(trackingSurface.tree, operation.path)
      if (parent && containsAtom(next.tree, parent.id)) treeAffected.add(parent.id)
    } else if (operation.op === 'move') {
      const moved = atomAtPointer(trackingSurface.tree, operation.from)
      if (moved && containsAtom(next.tree, moved.id)) {
        treeAffected.add(moved.id)
        movedAtomIds.add(moved.id)
      }
    } else {
      if (operation.op === 'replace') {
        const replaced = atomAtPointer(trackingSurface.tree, operation.path)
        if (replaced) {
          replacementOrigins.set(
            operation.value.id,
            replacementOrigins.get(replaced.id) ?? replaced.id,
          )
        }
      }
      if (containsAtom(next.tree, operation.value.id)) treeAffected.add(operation.value.id)
    }

    trackingSurface = surfaceAfterOperation
  }

  const previousAtoms = atomLocations(previous.tree)
  const nextAtoms = atomLocations(next.tree)
  const retained = new Set(
    [...treeAffected].filter((atomId) =>
      atomOwnFieldsChangedBetweenTrees(
        previousAtoms.get(atomId),
        nextAtoms.get(atomId),
        movedAtomIds.has(atomId),
      ),
    ),
  )
  const structuralCandidates = [...treeAffected]
    .filter((atomId) => !retained.has(atomId))
    .sort(
      (left, right) =>
        atomMaxDepth(previousAtoms, nextAtoms, right) -
        atomMaxDepth(previousAtoms, nextAtoms, left),
    )
  const retainedPreviousIds = new Set(
    [...retained].map((atomId) => replacementOrigins.get(atomId) ?? atomId),
  )

  for (const atomId of structuralCandidates) {
    const before = previousAtoms.get(atomId)
    const after = nextAtoms.get(atomId)
    if (
      !before ||
      !after ||
      !valuesEqual(
        residualAtomSnapshot(before.node, retainedPreviousIds),
        residualAtomSnapshot(after.node, retained),
      )
    ) {
      retained.add(atomId)
      retainedPreviousIds.add(replacementOrigins.get(atomId) ?? atomId)
    }
  }
  for (const atomId of retained) affected.add(atomId)

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

function atomOwnFieldsChangedBetweenTrees(
  before: AtomLocation | undefined,
  after: AtomLocation | undefined,
  includePath: boolean,
): boolean {
  if (!before || !after) return true
  return (
    (includePath && before.path !== after.path) ||
    !valuesEqual(atomOwnFields(before.node), atomOwnFields(after.node))
  )
}

function atomOwnFields(node: AtomNode): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...node }
  delete fields['children']
  return fields
}

function residualAtomSnapshot(
  node: AtomNode,
  handledAtomIds: Set<string>,
): Record<string, unknown> {
  const snapshot = atomOwnFields(node)
  const children = (node.children ?? [])
    .filter((child) => !handledAtomIds.has(child.id))
    .map((child) => residualAtomSnapshot(child, handledAtomIds))
  if (children.length > 0) snapshot['children'] = children
  return snapshot
}

interface AtomLocation {
  node: AtomNode
  path: string
  depth: number
}

function atomLocations(root: AtomNode): Map<string, AtomLocation> {
  const locations = new Map<string, AtomLocation>()

  function visit(node: AtomNode, path: string, depth: number): void {
    locations.set(node.id, { node, path, depth })
    for (const [index, child] of (node.children ?? []).entries()) {
      visit(child, `${path}/children/${index}`, depth + 1)
    }
  }

  visit(root, '', 0)
  return locations
}

function atomMaxDepth(
  previous: Map<string, AtomLocation>,
  next: Map<string, AtomLocation>,
  atomId: string,
): number {
  return Math.max(previous.get(atomId)?.depth ?? -1, next.get(atomId)?.depth ?? -1)
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

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && valuesEqual(left[key], right[key]),
    )
  )
}
