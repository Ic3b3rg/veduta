import { z } from 'zod'
import { ActionSchema } from './action.ts'

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

export interface AtomNode {
  id: string
  type: AtomType
  /** Static props (label, variant...). */
  props?: Record<string, unknown>
  /** Key into the Surface's typed state this node reads from. */
  binding?: string
  actions?: z.input<typeof ActionSchema>[]
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
