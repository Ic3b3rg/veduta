import type { JsonValue, PatchOperation } from '@veduta/protocol'

export function statePatchOperations(
  current: Record<string, JsonValue>,
  next: Record<string, JsonValue>,
  ignoredKeys: readonly string[] = [],
): PatchOperation[] {
  const ignored = new Set(ignoredKeys)
  return Object.entries(next).flatMap(([key, value]) => {
    if (ignored.has(key) || jsonEqual(current[key], value)) return []
    return [
      {
        target: 'state' as const,
        op: Object.prototype.hasOwnProperty.call(current, key)
          ? ('replace' as const)
          : ('add' as const),
        path: `/${key}`,
        value,
      },
    ]
  })
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
