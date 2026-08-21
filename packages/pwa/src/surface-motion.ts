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
  const previousAtoms = atomLocations(previous.tree)
  const nextAtoms = atomLocations(next.tree)
  const affected = affectedStateRegions(previous, next, operations)
  const candidates = treeRegionCandidates(previous, next, operations, nextAtoms)
  for (const atomId of changedTreeRegions(candidates, previousAtoms, nextAtoms)) {
    affected.add(atomId)
  }

  return smallestVisibleRegions(next.tree, affected)
}

function affectedStateRegions(
  previous: Surface,
  next: Surface,
  operations: PatchOperation[],
): Set<string> {
  const affected = new Set<string>()
  for (const operation of operations) {
    if (operation.target !== 'state') continue
    const stateKey = decodePointer(operation.path)[0]
    if (stateKey !== undefined && !valuesEqual(previous.state[stateKey], next.state[stateKey])) {
      collectBoundAtomIds(next.tree, stateKey, affected)
    }
  }
  return affected
}

interface TreeRegionCandidate {
  previousAtomId: string
  comparePath: boolean
}

function treeRegionCandidates(
  previous: Surface,
  next: Surface,
  operations: PatchOperation[],
  nextAtoms: ReadonlyMap<string, AtomLocation>,
): ReadonlyMap<string, TreeRegionCandidate> {
  const candidates = new Map<string, TreeRegionCandidate>()
  const replacementOrigins = new Map<string, string>()
  const treeChanged = !valuesEqual(previous.tree, next.tree)
  let trackingSurface = surfaceWithAllBindingKeys(previous, next, operations)

  function addCandidate(atomId: string, comparePath = false): void {
    candidates.set(atomId, {
      previousAtomId: replacementOrigins.get(atomId) ?? atomId,
      comparePath: comparePath || candidates.get(atomId)?.comparePath === true,
    })
  }

  for (const operation of operations) {
    if (operation.target === 'state') continue
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
      if (parent && nextAtoms.has(parent.id)) addCandidate(parent.id)
    } else if (operation.op === 'move') {
      const moved = atomAtPointer(trackingSurface.tree, operation.from)
      if (moved && nextAtoms.has(moved.id)) addCandidate(moved.id, true)
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
      if (nextAtoms.has(operation.value.id)) addCandidate(operation.value.id)
    }

    trackingSurface = surfaceAfterOperation
  }

  return candidates
}

function changedTreeRegions(
  candidates: ReadonlyMap<string, TreeRegionCandidate>,
  previousAtoms: ReadonlyMap<string, AtomLocation>,
  nextAtoms: ReadonlyMap<string, AtomLocation>,
): Set<string> {
  const changed = new Set<string>()
  const handledPreviousIds = new Set<string>()
  const structuralCandidates: [string, TreeRegionCandidate][] = []

  for (const [atomId, candidate] of candidates) {
    if (
      atomOwnFieldsChangedBetweenTrees(
        previousAtoms.get(candidate.previousAtomId),
        nextAtoms.get(atomId),
        candidate.comparePath,
      )
    ) {
      changed.add(atomId)
      handledPreviousIds.add(candidate.previousAtomId)
    } else {
      structuralCandidates.push([atomId, candidate])
    }
  }
  structuralCandidates.sort(
    ([left], [right]) =>
      atomMaxDepth(previousAtoms, nextAtoms, right) - atomMaxDepth(previousAtoms, nextAtoms, left),
  )

  for (const [atomId, candidate] of structuralCandidates) {
    const before = previousAtoms.get(candidate.previousAtomId)
    const after = nextAtoms.get(atomId)
    if (
      !before ||
      !after ||
      !valuesEqual(
        residualAtomSnapshot(before.node, handledPreviousIds),
        residualAtomSnapshot(after.node, changed),
      )
    ) {
      changed.add(atomId)
      handledPreviousIds.add(candidate.previousAtomId)
    }
  }
  return changed
}

/** Adds bindings from every replayed tree so intermediate patches remain schema-valid. */
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
  previous: ReadonlyMap<string, AtomLocation>,
  next: ReadonlyMap<string, AtomLocation>,
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
