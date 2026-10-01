import { z } from 'zod'
import {
  AtomNodeSchema,
  AtomNodeBranches,
  atomTypes,
  type AtomNode,
  type AtomType,
} from './atom.ts'
import type { ActionOwningNode } from './action-inputs.ts'
import { JsonObjectSchema, JsonValueSchema } from './json.ts'

const knownTypes = new Set<string>(atomTypes)
const UnknownAtomTypeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((type) => !knownTypes.has(type), 'Known Atoms must use their catalog contract')
  .brand<'UnknownAtomType'>()

interface OptionalRenderableChildren {
  children?: RenderableAtomNode[] | undefined
}
interface RequiredRenderableChildren {
  children: RenderableAtomNode[]
}
type RenderableKnownNode<Node> = Node extends { type: AtomType }
  ? Omit<Node, 'children'> &
      (Node['type'] extends 'Box' | 'Row' | 'Col'
        ? OptionalRenderableChildren
        : Node['type'] extends 'Form' | 'Collapsible' | 'Transition' | 'Accordion'
          ? RequiredRenderableChildren
          : { children?: undefined })
  : never

export type KnownRenderableAtomNode = RenderableKnownNode<AtomNode>

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

interface AtomValidationNode extends ActionOwningNode {
  id: string
  type: AtomType
  children?: AtomValidationNode[] | undefined
}

/** A validation input, never an assertion that an unknown wire Atom is canonical authoring. */
export function atomValidationTree(node: RenderableAtomNode): AtomValidationNode {
  const ids = new Set<string>()
  function collectIds(current: RenderableAtomNode): void {
    ids.add(current.id)
    current.children?.forEach(collectIds)
  }
  collectIds(node)
  let sequence = 0
  function project(current: RenderableAtomNode): AtomValidationNode {
    const children = current.children?.map(project)
    if (!isKnownRenderableAtomNode(current)) {
      let placeholderId: string
      do placeholderId = `read-placeholder-${++sequence}`
      while (ids.has(placeholderId))
      ids.add(placeholderId)
      // UnknownAtom itself is visible. Represent that fact only in the
      // validation projection; the wire tree and its metadata stay intact.
      return {
        id: current.id,
        type: 'Box',
        children: [
          { id: placeholderId, type: 'Text', props: { text: `Unsupported Atom: ${current.type}` } },
          ...(children ?? []),
        ],
      }
    }
    const { children: _children, ...own } = current
    return { ...own, ...(children === undefined ? {} : { children }) }
  }
  return project(node)
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

const readChildren = z.array(RenderableAtomNodeSchema)
const readBranches = {
  ...AtomNodeBranches,
  Box: AtomNodeBranches.Box.extend({ children: readChildren.optional() }),
  Row: AtomNodeBranches.Row.extend({ children: readChildren.optional() }),
  Col: AtomNodeBranches.Col.extend({ children: readChildren.optional() }),
  Form: AtomNodeBranches.Form.extend({ children: readChildren.min(1) }),
  Collapsible: AtomNodeBranches.Collapsible.extend({ children: readChildren.min(1) }),
  Transition: AtomNodeBranches.Transition.extend({ children: readChildren.min(1) }),
  Accordion: AtomNodeBranches.Accordion.extend({ children: readChildren.min(1) }),
}

/** Reuse strict known branches; only recursive reads gain explicit unknown-node compatibility. */
const KnownRenderableAtomNodeSchema = z
  .discriminatedUnion('type', [
    readBranches.Button,
    readBranches.DatePicker,
    readBranches.Select,
    readBranches.Checkbox,
    readBranches.Switch,
    readBranches.RadioGroup,
    readBranches.Combobox,
    readBranches.Input,
    readBranches.Textarea,
    readBranches.Form,
    readBranches.Box,
    readBranches.Row,
    readBranches.Col,
    readBranches.Spacer,
    readBranches.Divider,
    readBranches.Collapsible,
    readBranches.Accordion,
    readBranches.Table,
    readBranches.Text,
    readBranches.Title,
    readBranches.Caption,
    readBranches.Label,
    readBranches.Markdown,
    readBranches.Image,
    readBranches.Icon,
    readBranches.Chart,
    readBranches.Badge,
    readBranches.Transition,
    readBranches.Progress,
    readBranches.Stat,
    readBranches.ListItem,
    readBranches.Automation,
    readBranches.Pending,
  ])
  .superRefine((node, ctx) => {
    const parsed = AtomNodeSchema.safeParse(atomValidationTree(node))
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue)
  })

const UnknownRenderableAtomNodeSchema = z
  .object({
    id: z.string().min(1),
    type: UnknownAtomTypeSchema,
    props: JsonObjectSchema.optional(),
    children: z.array(RenderableAtomNodeSchema).optional(),
  })
  .catchall(JsonValueSchema)
