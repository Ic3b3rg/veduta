import { z } from 'zod'
import { validateOwningActionDeclarations } from './action-inputs.ts'
import {
  ActionSchema,
  FastActionSchema,
  AgentActionSchema,
  FormSubmitActionSchema,
} from './action.ts'
import { ChartAtomPropsSchema } from './chart.ts'
import {
  validateContentAtom,
  TextAtomPropsSchema,
  TitleAtomPropsSchema,
  CaptionAtomPropsSchema,
  LabelAtomPropsSchema,
  MarkdownAtomPropsSchema,
  BadgeAtomPropsSchema,
  ListItemAtomPropsSchema,
  StatAtomPropsSchema,
  ProgressAtomPropsSchema,
  TableAtomPropsSchema,
  AutomationAtomPropsSchema,
} from './content-atoms.ts'
import {
  validateSelectionControl,
  validateTypedControlBindingWrite,
  ButtonAtomPropsSchema,
  CheckboxAtomPropsSchema,
  SelectAtomPropsSchema,
  RadioGroupAtomPropsSchema,
  DatePickerAtomPropsSchema,
} from './control-atoms.ts'
import {
  BoxAtomPropsSchema,
  RowAtomPropsSchema,
  ColAtomPropsSchema,
  SpacerAtomPropsSchema,
  DividerAtomPropsSchema,
  TransitionAtomPropsSchema,
  ImageAtomPropsSchema,
  IconAtomPropsSchema,
} from './layout-atoms.ts'
export { AutomationAtomPropsSchema, type AutomationAtomProps } from './content-atoms.ts'

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
  'Switch',
  'RadioGroup',
  'Combobox',
  'Input',
  'Textarea',
  'Form',
  // Layout
  'Box',
  'Row',
  'Col',
  'Spacer',
  'Divider',
  'Collapsible',
  'Accordion',
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

export const InputAtomPropsSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    placeholder: z.string().max(240).optional(),
    inputType: z.enum(['text', 'email', 'search', 'tel', 'url']).optional(),
    valueType: z.literal('number').optional(),
  })
  .strict()

export type InputAtomProps = z.infer<typeof InputAtomPropsSchema>

export const TextareaAtomPropsSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    placeholder: z.string().max(240).optional(),
    rows: z.number().int().min(2).max(12).optional(),
  })
  .strict()

export type TextareaAtomProps = z.infer<typeof TextareaAtomPropsSchema>

export const FormAtomPropsSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    submitLabel: z.string().trim().min(1).max(120),
  })
  .strict()

export type FormAtomProps = z.infer<typeof FormAtomPropsSchema>

export const CollapsibleAtomPropsSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    defaultOpen: z.boolean().optional(),
  })
  .strict()

export const AccordionAtomPropsSchema = z
  .object({ mode: z.enum(['single', 'multiple']).optional() })
  .strict()

export const SwitchAtomPropsSchema = z
  .object({ label: z.string().trim().min(1).max(120), disabled: z.boolean().optional() })
  .strict()

export const ComboboxAtomPropsSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    placeholder: z.string().max(240).optional(),
    emptyText: z.string().max(240).optional(),
    disabled: z.boolean().optional(),
    options: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(120),
            value: z.string().min(1).max(160),
          })
          .strict(),
      )
      .min(1)
      .superRefine((options, ctx) => {
        const seen = new Set<string>()
        options.forEach((option, index) => {
          if (seen.has(option.value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'value'],
              message: `duplicate Combobox option value "${option.value}"`,
            })
          }
          seen.add(option.value)
        })
      }),
  })
  .strict()

export type CollapsibleAtomProps = z.infer<typeof CollapsibleAtomPropsSchema>
export type AccordionAtomProps = z.infer<typeof AccordionAtomPropsSchema>
export type SwitchAtomProps = z.infer<typeof SwitchAtomPropsSchema>
export type ComboboxAtomProps = z.infer<typeof ComboboxAtomPropsSchema>

const forbidden = z.never().optional()
const binding = z.string().min(1)
const namedAction = <Name extends string>(name: Name) =>
  z.union([
    FastActionSchema.extend({ name: z.literal(name) }),
    AgentActionSchema.extend({ name: z.literal(name) }),
  ])
const fastAction = <Name extends string>(name: Name) =>
  FastActionSchema.extend({ name: z.literal(name) })

function atomBranch<Type extends AtomType, Shape extends z.ZodRawShape>(type: Type, shape: Shape) {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      props: forbidden,
      binding: forbidden,
      actions: forbidden,
      children: forbidden,
    })
    .extend(shape)
    .strict()
}

/** Nonrecursive branch declarations keep each type's props and Action shape closed. */
const ownBranches = {
  Button: atomBranch('Button', {
    props: ButtonAtomPropsSchema,
    actions: z.array(ActionSchema).length(1),
  }),
  DatePicker: atomBranch('DatePicker', {
    props: DatePickerAtomPropsSchema,
    binding,
    actions: z.array(fastAction('change')).length(1),
  }),
  Select: atomBranch('Select', {
    props: SelectAtomPropsSchema,
    binding,
    actions: z.array(fastAction('change')).length(1),
  }),
  Checkbox: atomBranch('Checkbox', {
    props: CheckboxAtomPropsSchema,
    binding,
    actions: z.array(fastAction('toggle')).length(1),
  }),
  Switch: atomBranch('Switch', {
    props: SwitchAtomPropsSchema,
    binding,
    actions: z.array(namedAction('toggle')).length(1),
  }),
  RadioGroup: atomBranch('RadioGroup', {
    props: RadioGroupAtomPropsSchema,
    binding,
    actions: z.array(fastAction('change')).length(1),
  }),
  Combobox: atomBranch('Combobox', {
    props: ComboboxAtomPropsSchema,
    binding,
    actions: z.array(namedAction('change')).length(1),
  }),
  Input: atomBranch('Input', {
    props: InputAtomPropsSchema,
    binding: z.string({ required_error: 'Input requires a binding' }).min(1),
    actions: z.never({ invalid_type_error: 'Input must be a submit-only leaf Atom' }).optional(),
    children: z.never({ invalid_type_error: 'Input must be a submit-only leaf Atom' }).optional(),
  }),
  Textarea: atomBranch('Textarea', { props: TextareaAtomPropsSchema, binding }),
  Form: atomBranch('Form', {
    props: FormAtomPropsSchema,
    actions: z.array(FormSubmitActionSchema).length(1),
  }),
  Box: atomBranch('Box', { props: BoxAtomPropsSchema.optional() }),
  Row: atomBranch('Row', { props: RowAtomPropsSchema.optional() }),
  Col: atomBranch('Col', { props: ColAtomPropsSchema.optional() }),
  Spacer: atomBranch('Spacer', { props: SpacerAtomPropsSchema.optional() }),
  Divider: atomBranch('Divider', { props: DividerAtomPropsSchema.optional() }),
  Collapsible: atomBranch('Collapsible', { props: CollapsibleAtomPropsSchema }),
  Accordion: atomBranch('Accordion', { props: AccordionAtomPropsSchema.optional() }),
  Table: atomBranch('Table', { props: TableAtomPropsSchema, binding: binding.optional() }),
  Text: atomBranch('Text', { props: TextAtomPropsSchema.optional(), binding: binding.optional() }),
  Title: atomBranch('Title', {
    props: TitleAtomPropsSchema.optional(),
    binding: binding.optional(),
  }),
  Caption: atomBranch('Caption', {
    props: CaptionAtomPropsSchema.optional(),
    binding: binding.optional(),
  }),
  Label: atomBranch('Label', {
    props: LabelAtomPropsSchema.optional(),
    binding: binding.optional(),
  }),
  Markdown: atomBranch('Markdown', {
    props: MarkdownAtomPropsSchema.optional(),
    binding: binding.optional(),
  }),
  Image: atomBranch('Image', { props: ImageAtomPropsSchema }),
  Icon: atomBranch('Icon', { props: IconAtomPropsSchema }),
  Chart: atomBranch('Chart', { props: ChartAtomPropsSchema, binding }),
  Badge: atomBranch('Badge', { props: BadgeAtomPropsSchema }),
  Transition: atomBranch('Transition', { props: TransitionAtomPropsSchema.optional() }),
  Progress: atomBranch('Progress', { props: ProgressAtomPropsSchema, binding: binding.optional() }),
  Stat: atomBranch('Stat', { props: StatAtomPropsSchema, binding: binding.optional() }),
  ListItem: atomBranch('ListItem', {
    props: ListItemAtomPropsSchema,
    actions: z.array(namedAction('click')).length(1).optional(),
  }),
  Automation: atomBranch('Automation', {
    props: AutomationAtomPropsSchema,
    binding: binding.optional(),
    actions: z.array(namedAction('toggle')).length(1).optional(),
  }),
  Pending: atomBranch('Pending', { props: PendingAtomPropsSchema }),
} satisfies Record<AtomType, z.AnyZodObject>

type OwnNode = z.infer<(typeof ownBranches)[AtomType]>
interface OptionalAtomChildren {
  children?: AtomNode[] | undefined
}
interface RequiredAtomChildren {
  children: AtomNode[]
}
interface AccordionAtomChildren {
  children: (AtomNode & { type: 'Collapsible' })[]
}
type RecursiveNode<Node> = Node extends { type: AtomType }
  ? Omit<Node, 'children'> &
      (Node['type'] extends 'Box' | 'Row' | 'Col'
        ? OptionalAtomChildren
        : Node['type'] extends 'Form' | 'Collapsible' | 'Transition'
          ? RequiredAtomChildren
          : Node['type'] extends 'Accordion'
            ? AccordionAtomChildren
            : { children?: undefined })
  : never

/** Parsed, discriminated catalog contract; Agent Action defaults are materialized by parsing. */
export type AtomNode = RecursiveNode<OwnNode>

const ChildAtomNodeSchema: z.ZodType<AtomNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  AtomNodeUnionSchema.superRefine(validateAtomNode),
)
const children = z.array(ChildAtomNodeSchema)
const CollapsibleChildSchema = ownBranches.Collapsible.extend({
  children: children.min(1),
}).superRefine(validateAtomNode)

export const AtomNodeBranches = {
  ...ownBranches,
  Box: ownBranches.Box.extend({ children: children.optional() }),
  Row: ownBranches.Row.extend({ children: children.optional() }),
  Col: ownBranches.Col.extend({ children: children.optional() }),
  Form: ownBranches.Form.extend({ children: children.min(1) }),
  Collapsible: ownBranches.Collapsible.extend({ children: children.min(1) }),
  Transition: ownBranches.Transition.extend({ children: children.min(1) }),
  Accordion: ownBranches.Accordion.extend({
    children: z.array(CollapsibleChildSchema).min(1),
  }),
}

/** Every recognized name selects its own strict object before semantic tree/state validation. */
export const AtomNodeUnionSchema = z.discriminatedUnion(
  'type',
  [
    AtomNodeBranches.Button,
    AtomNodeBranches.DatePicker,
    AtomNodeBranches.Select,
    AtomNodeBranches.Checkbox,
    AtomNodeBranches.Switch,
    AtomNodeBranches.RadioGroup,
    AtomNodeBranches.Combobox,
    AtomNodeBranches.Input,
    AtomNodeBranches.Textarea,
    AtomNodeBranches.Form,
    AtomNodeBranches.Box,
    AtomNodeBranches.Row,
    AtomNodeBranches.Col,
    AtomNodeBranches.Spacer,
    AtomNodeBranches.Divider,
    AtomNodeBranches.Collapsible,
    AtomNodeBranches.Accordion,
    AtomNodeBranches.Table,
    AtomNodeBranches.Text,
    AtomNodeBranches.Title,
    AtomNodeBranches.Caption,
    AtomNodeBranches.Label,
    AtomNodeBranches.Markdown,
    AtomNodeBranches.Image,
    AtomNodeBranches.Icon,
    AtomNodeBranches.Chart,
    AtomNodeBranches.Badge,
    AtomNodeBranches.Transition,
    AtomNodeBranches.Progress,
    AtomNodeBranches.Stat,
    AtomNodeBranches.ListItem,
    AtomNodeBranches.Automation,
    AtomNodeBranches.Pending,
  ],
  {
    errorMap: (issue, context) => {
      const type =
        context.data !== null && typeof context.data === 'object' ? context.data['type'] : undefined
      return {
        message:
          issue.code === 'invalid_union_discriminator' && typeof type === 'string'
            ? `unknown Atom "${type}"; expected one of ${issue.options.join(', ')}`
            : context.defaultError,
      }
    },
  },
)

export const AtomNodeSchema = ChildAtomNodeSchema.superRefine((tree, ctx) => {
  const seen = new Set<string>()
  function walk(node: AtomNode, path: (string | number)[]): void {
    if (seen.has(node.id))
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'id'],
        params: { semanticCode: 'duplicate_node_id' },
        message: `Atom id "${node.id}" is duplicated in the complete tree`,
      })
    seen.add(node.id)
    node.children?.forEach((child, index) => walk(child, [...path, 'children', index]))
  }
  walk(tree, [])
})

function validateAtomNode(node: AtomNode, ctx: z.RefinementCtx): void {
  validateOwningActionDeclarations(node, ctx)
  validateContentAtom(node, ctx)
  validateSelectionControl(node, ctx)
  if (node.type === 'Accordion' && node.props?.mode !== 'multiple') {
    const defaults = node.children.filter((child) => child.props.defaultOpen === true)
    if (defaults.length > 1)
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        params: { semanticCode: 'multiple_default_disclosures' },
        message: 'Single Accordion can open only one child by default',
      })
  }
  if (node.type === 'Switch' || node.type === 'Combobox') {
    const action = node.actions[0]
    if (action?.path === 'fast') validateTypedControlBindingWrite(node, action, ctx)
  }
}
