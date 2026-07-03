import { z } from 'zod'
import { ActionSchema, type Action } from './action.ts'

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
] as const

export const AtomTypeSchema = z.enum(atomTypes)
export type AtomType = z.infer<typeof AtomTypeSchema>

/**
 * The parsed shape of a node: `actions[].path` is always materialized
 * (the schema defaults it to "agent" at parse time). Inputs may omit
 * `path` — validation is the only door into this type.
 */
export interface AtomNode {
  id: string
  type: AtomType
  /** Static props (label, variant...). */
  props?: Record<string, unknown>
  /** Key into the Surface's typed state this node reads from. */
  binding?: string
  actions?: Action[]
  children?: AtomNode[]
}

export const AtomNodeSchema: z.ZodType<AtomNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: AtomTypeSchema,
    props: z.record(z.unknown()).optional(),
    binding: z.string().optional(),
    actions: z.array(ActionSchema).optional(),
    children: z.array(AtomNodeSchema).optional(),
  }),
) as z.ZodType<AtomNode>
