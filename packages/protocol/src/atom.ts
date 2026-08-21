import { z } from 'zod'
import { ActionSchema, type Action } from './action.ts'
import { JsonObjectSchema, type JsonObject } from './json.ts'

/**
 * The closed Atom catalog (ADR-0003): ChatKit-style set plus
 * Progress, Stat, ListItem, Automation. Surfaces are trees of these
 * and nothing else — unknown types are rejected at validation time.
 */
export const atomTypes = [
  // Controls
  'Button',
  'DatePicker',
  'Select',
  'Checkbox',
  'RadioGroup',
  'Input',
  'Textarea',
  'Form',
  // Layout
  'Box',
  'Row',
  'Col',
  'Spacer',
  'Divider',
  'Table',
  // Typography
  'Text',
  'Title',
  'Caption',
  'Label',
  'Markdown',
  // Content
  'Image',
  'Icon',
  'Chart',
  'Badge',
  // Other
  'Transition',
  // Veduta additions
  'Progress',
  'Stat',
  'ListItem',
  'Automation',
  // Transient Surface composition
  'Pending',
] as const

export const AtomTypeSchema = z.enum(atomTypes)
export type AtomType = z.infer<typeof AtomTypeSchema>

export const pendingSlotVariants = ['text', 'list', 'image', 'stat', 'chart'] as const
export const PendingSlotVariantSchema = z.enum(pendingSlotVariants)
export type PendingSlotVariant = z.infer<typeof PendingSlotVariantSchema>

export const MIN_PENDING_SLOT_TIMEOUT_MS = 1_000
export const DEFAULT_PENDING_SLOT_TIMEOUT_MS = 30_000
export const MAX_PENDING_SLOT_TIMEOUT_MS = 120_000

const PendingAtomSharedPropsSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  /** Server-owned start of this slot's bounded composition window. */
  startedAt: z.string().datetime().optional(),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_PENDING_SLOT_TIMEOUT_MS)
    .max(MAX_PENDING_SLOT_TIMEOUT_MS)
    .optional(),
})

/**
 * Footprint metadata for a transient Pending Atom. The variants are strict
 * so a misspelled footprint or dimension cannot silently render as a
 * different skeleton.
 */
export const PendingAtomPropsSchema = z.discriminatedUnion('variant', [
  PendingAtomSharedPropsSchema.extend({
    variant: z.literal('text'),
    lines: z.number().int().min(1).max(6).optional(),
  }).strict(),
  PendingAtomSharedPropsSchema.extend({
    variant: z.literal('list'),
    rows: z.number().int().min(1).max(8).optional(),
  }).strict(),
  PendingAtomSharedPropsSchema.extend({ variant: z.literal('image') }).strict(),
  PendingAtomSharedPropsSchema.extend({ variant: z.literal('stat') }).strict(),
  PendingAtomSharedPropsSchema.extend({ variant: z.literal('chart') }).strict(),
])

export type PendingAtomProps = z.infer<typeof PendingAtomPropsSchema>

/**
 * The parsed shape of a node: `actions[].path` is always materialized
 * (the schema defaults it to "agent" at parse time). Inputs may omit
 * `path` — validation is the only door into this type.
 */
export interface AtomNode {
  id: string
  type: AtomType
  /** Static props (label, variant...). */
  props?: JsonObject
  /** Key into the Surface's typed state this node reads from. */
  binding?: string
  actions?: Action[]
  children?: AtomNode[]
}

export const AtomNodeSchema: z.ZodType<AtomNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      type: AtomTypeSchema,
      props: JsonObjectSchema.optional(),
      binding: z.string().min(1).optional(),
      actions: z.array(ActionSchema).optional(),
      children: z.array(AtomNodeSchema).optional(),
    })
    .superRefine(validatePendingAtom),
) as z.ZodType<AtomNode>

interface PendingAtomCandidate {
  type: AtomType
  props?: JsonObject | undefined
  binding?: string | undefined
  actions?: Action[] | undefined
  children?: AtomNode[] | undefined
}

function validatePendingAtom(node: PendingAtomCandidate, ctx: z.RefinementCtx): void {
  if (node.type !== 'Pending') return

  const props = PendingAtomPropsSchema.safeParse(node.props)
  if (!props.success) {
    for (const issue of props.error.issues) {
      ctx.addIssue({ ...issue, path: ['props', ...issue.path] })
    }
  }

  for (const field of ['binding', 'actions', 'children'] as const) {
    if (node[field] === undefined) continue
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: 'Pending must be a leaf Atom',
    })
  }
}
