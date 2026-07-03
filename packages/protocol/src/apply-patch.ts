import type { Patch, PatchOperation } from './patch.ts'
import { parseSurface, type Surface } from './surface.ts'
import type { SurfacePatchEvent } from './gateway.ts'

type MutableRecord = Record<string, unknown>

/** Apply a protocol Patch to a Surface and validate the resulting Surface. */
export function applySurfacePatch(surface: Surface, patch: Patch): Surface {
  if (surface.id !== patch.surfaceId) {
    throw new Error(`patch for ${patch.surfaceId} cannot be applied to Surface ${surface.id}`)
  }

  const next = clonePlain(surface)

  for (const operation of patch.operations) {
    applyOperation(operation.target === 'state' ? next.state : next.tree, operation)
  }

  return parseSurface(next)
}

/** Apply a replayable Gateway patch event, including Surface freshness metadata. */
export function applySurfacePatchEvent(surface: Surface, event: SurfacePatchEvent): Surface {
  const patched = applySurfacePatch(surface, event.patch)
  return parseSurface({ ...patched, freshness: event.freshness })
}

function applyOperation(target: unknown, operation: PatchOperation): void {
  if (operation.op === 'move') {
    const value = getValueAtPath(target, operation.from)
    removeValueAtPath(target, operation.from)
    setValueAtPath(target, operation.path, value, 'add')
    return
  }

  if (operation.op === 'remove') {
    removeValueAtPath(target, operation.path)
    return
  }

  setValueAtPath(target, operation.path, clonePlain(operation.value), operation.op)
}

function getValueAtPath(root: unknown, pointer: string): unknown {
  const { container, key } = parentAtPath(root, pointer)
  if (Array.isArray(container)) return container[indexFor(container, key)]
  return container[key]
}

function setValueAtPath(
  root: unknown,
  pointer: string,
  value: unknown,
  op: 'add' | 'replace',
): void {
  const { container, key } = parentAtPath(root, pointer)

  if (Array.isArray(container)) {
    const index = key === '-' ? container.length : indexForAdd(container, key)
    if (op === 'replace') {
      if (index >= container.length) throw new Error(`cannot replace missing path ${pointer}`)
      container[index] = value
      return
    }
    container.splice(index, 0, value)
    return
  }

  if (op === 'replace' && !Object.prototype.hasOwnProperty.call(container, key)) {
    throw new Error(`cannot replace missing path ${pointer}`)
  }
  container[key] = value
}

function removeValueAtPath(root: unknown, pointer: string): void {
  const { container, key } = parentAtPath(root, pointer)
  if (Array.isArray(container)) {
    container.splice(indexFor(container, key), 1)
    return
  }
  if (!Object.prototype.hasOwnProperty.call(container, key)) {
    throw new Error(`cannot remove missing path ${pointer}`)
  }
  delete container[key]
}

function parentAtPath(
  root: unknown,
  pointer: string,
): { container: MutableRecord | unknown[]; key: string } {
  const segments = decodePointer(pointer)
  if (segments.length === 0) throw new Error('root-level patch operations are not supported')

  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = childAt(current, segment, pointer)
  }

  if (!isContainer(current)) {
    throw new Error(`patch path ${pointer} reaches a non-container value`)
  }

  return { container: current, key: segments[segments.length - 1]! }
}

function childAt(container: unknown, key: string, pointer: string): unknown {
  if (Array.isArray(container)) return container[indexFor(container, key)]
  if (isRecord(container)) return container[key]
  throw new Error(`patch path ${pointer} reaches a non-container value`)
}

function decodePointer(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function indexFor(array: unknown[], key: string): number {
  const index = Number(key)
  if (!Number.isInteger(index) || index < 0 || index >= array.length) {
    throw new Error(`invalid array index "${key}"`)
  }
  return index
}

function indexForAdd(array: unknown[], key: string): number {
  const index = Number(key)
  if (!Number.isInteger(index) || index < 0 || index > array.length) {
    throw new Error(`invalid array index "${key}"`)
  }
  return index
}

function isContainer(value: unknown): value is MutableRecord | unknown[] {
  return Array.isArray(value) || isRecord(value)
}

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
