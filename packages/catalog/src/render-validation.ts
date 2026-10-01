import { RenderableAtomTreeStateSchema, formatSurfaceIssues } from '@veduta/protocol'

/**
 * A newer Gateway may send an Atom this catalog cannot render yet. Validate its
 * known descendants through the shared read contract; keep the original tree
 * for the visible UnknownAtom fallback. Authoring uses the closed schema.
 */
export function renderValidationIssues(tree: unknown, state: unknown): string[] {
  const result = RenderableAtomTreeStateSchema.safeParse({ tree, state })
  return result.success ? [] : formatSurfaceIssues(result.error.issues)
}
