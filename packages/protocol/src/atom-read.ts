import { z } from 'zod'
import { ActionSchema } from './action.ts'
import { AtomNodeSchema, AtomTypeSchema, atomTypes, type AtomNode } from './atom.ts'
import { JsonObjectSchema, JsonValueSchema } from './json.ts'

const knownTypes = new Set<string>(atomTypes)
const UnknownAtomTypeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((type) => !knownTypes.has(type), 'Known Atoms must use their catalog contract')
  .brand<'UnknownAtomType'>()

export interface KnownRenderableAtomNode extends Omit<AtomNode, 'children'> {
  children?: RenderableAtomNode[] | undefined
}

export interface UnknownRenderableAtomNode {
  id: string
  type: z.infer<typeof UnknownAtomTypeSchema>
  props?: z.infer<typeof JsonObjectSchema> | undefined
  children?: RenderableAtomNode[] | undefined
  /** Future metadata is retained for replay but is never an executable client contract. */
  [field: string]: unknown
}

export type RenderableAtomNode = KnownRenderableAtomNode | UnknownRenderableAtomNode

export function isKnownRenderableAtomNode(
  node: RenderableAtomNode,
): node is KnownRenderableAtomNode {
  return knownTypes.has(node.type)
}

/** A separate validation value preserves known descendant and ancestor contracts. */
export function atomValidationTree(node: RenderableAtomNode): AtomNode {
  const children = node.children?.map(atomValidationTree)
  if (!isKnownRenderableAtomNode(node)) {
    return { id: node.id, type: 'Box', ...(children === undefined ? {} : { children }) }
  }
  const { children: _children, ...own } = node
  return { ...own, ...(children === undefined ? {} : { children }) }
}

/** Read compatibility does not participate in authoring, Templates, or daemon persistence. */
export const RenderableAtomNodeSchema: z.ZodType<RenderableAtomNode, z.ZodTypeDef, unknown> =
  z.lazy(() =>
    z.unknown().transform((input, ctx): RenderableAtomNode => {
      const header = z.object({ type: z.string() }).safeParse(input)
      const schema =
        header.success && knownTypes.has(header.data.type)
          ? KnownRenderableAtomNodeSchema
          : UnknownRenderableAtomNodeSchema
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue(issue)
        return z.NEVER
      }
      return parsed.data
    }),
  )

const KnownRenderableAtomNodeSchema = z
  .object({
    id: z.string().min(1),
    type: AtomTypeSchema,
    props: JsonObjectSchema.optional(),
    binding: z.string().min(1).optional(),
    actions: z.array(ActionSchema).optional(),
    children: z.array(RenderableAtomNodeSchema).optional(),
  })
  .strict()
  .transform((node, ctx): KnownRenderableAtomNode => {
    const parsed = AtomNodeSchema.safeParse({
      ...node,
      ...(node.children === undefined ? {} : { children: node.children.map(atomValidationTree) }),
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue)
      return z.NEVER
    }
    const { children: _children, ...own } = parsed.data
    return { ...own, ...(node.children === undefined ? {} : { children: node.children }) }
  })

const UnknownRenderableAtomNodeSchema = z
  .object({
    id: z.string().min(1),
    type: UnknownAtomTypeSchema,
    props: JsonObjectSchema.optional(),
    children: z.array(RenderableAtomNodeSchema).optional(),
  })
  .catchall(JsonValueSchema)
