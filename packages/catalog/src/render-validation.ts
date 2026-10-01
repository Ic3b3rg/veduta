import { AtomTreeStateSchema, atomTypes, formatSurfaceIssues } from '@veduta/protocol'

/**
 * A newer Gateway may send an Atom this catalog cannot render yet. Validate its
 * known descendants using a container surrogate; keep the original tree for the
 * visible UnknownAtom fallback. Authoring still uses the closed protocol schema.
 */
export function renderValidationIssues(tree: unknown, state: unknown): string[] {
  const result = AtomTreeStateSchema.safeParse({ tree: compatibleTree(tree), state })
  return result.success ? [] : formatSurfaceIssues(result.error.issues)
}

function compatibleTree(node: unknown): unknown {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return node
  const value: Record<string, unknown> = Object.fromEntries(Object.entries(node))
  const children = Array.isArray(value['children'])
    ? value['children'].map(compatibleTree)
    : value['children']
  if (
    typeof value['type'] === 'string' &&
    value['type'].length > 0 &&
    !atomTypes.some((type) => type === value['type'])
  ) {
    return { id: value['id'], type: 'Box', ...(children === undefined ? {} : { children }) }
  }
  return { ...value, ...(children === undefined ? {} : { children }) }
}
