import { z } from 'zod'
import {
  atomValidationTree,
  RenderableAtomNodeSchema,
  type RenderableAtomNode,
} from './atom-read.ts'
import { JsonObjectSchema } from './json.ts'
import {
  AtomTreeStateSchema,
  SurfaceObjectSchema,
  SurfaceSchema,
  collectNodeBindingRefs,
  type NodeBindingRef,
} from './surface.ts'

export const RenderableAtomTreeStateSchema = z
  .object({ tree: RenderableAtomNodeSchema, state: JsonObjectSchema })
  .superRefine((value, ctx) => {
    const parsed = AtomTreeStateSchema.safeParse({
      tree: atomValidationTree(value.tree),
      state: value.state,
    })
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue)
  })

/** Validated client projection of a canonical Surface from a possibly newer Gateway. */
export const RenderableSurfaceSchema = SurfaceObjectSchema.extend({
  tree: RenderableAtomNodeSchema,
}).transform((value, ctx) => {
  const parsed = SurfaceSchema.safeParse({ ...value, tree: atomValidationTree(value.tree) })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue)
    return z.NEVER
  }
  return { ...parsed.data, tree: value.tree }
})

export type RenderableSurface = z.infer<typeof RenderableSurfaceSchema>

/** Unknown metadata has no local binding contract; known descendants retain their dependencies. */
export function collectRenderableNodeBindingRefs(
  node: RenderableAtomNode,
  path: (string | number)[],
): NodeBindingRef[] {
  return collectNodeBindingRefs(atomValidationTree(node), path)
}
