import { z } from 'zod'
import type { AtomNode } from './atom.ts'
import { AutomationRunHistorySchema } from './automation-outcome.ts'
import type { JsonObject } from './json.ts'
import { validateTypedControlBindingWrite } from './control-atoms.ts'
import { ValueFormatSchema } from './value-presentation.ts'
import { AutomationScheduleSchema } from './automation-schedule.ts'

const ShortText = z.string().trim().min(1).max(240)
const ContentText = z.string().max(64_000)
export const AtomToneSchema = z.enum([
  'neutral',
  'success',
  'warning',
  'danger',
  'enabled',
  'done',
  'pending',
  'error',
])
export const ContentValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
export const MetricValueSchema = z.union([z.string(), z.number().finite(), z.null()])
/** Values up to one are a fraction; larger values are percentages. Null means unknown. */
export const ProgressValueSchema = z.number().finite().min(0).max(100).nullable()

const TextProps = z.object({ text: ContentText.optional(), emptyText: ShortText.optional() })
const FormattedTextProps = TextProps.extend({ valueFormat: ValueFormatSchema.optional() })
export const TextAtomPropsSchema = FormattedTextProps.strict()
export const TitleAtomPropsSchema = TextProps.extend({
  level: z.number().int().min(1).max(6).optional(),
}).strict()
export const CaptionAtomPropsSchema = FormattedTextProps.strict()
export const LabelAtomPropsSchema = FormattedTextProps.strict()
export const MarkdownAtomPropsSchema = TextProps.strict()
export const BadgeAtomPropsSchema = z
  .object({ text: ShortText, tone: AtomToneSchema.optional() })
  .strict()
export const ListItemAtomPropsSchema = z
  .object({
    label: ShortText,
    detail: ContentText.optional(),
    status: ShortText.optional(),
    tone: AtomToneSchema.optional(),
  })
  .strict()
  .refine((props) => props.tone === undefined || props.status !== undefined, {
    message: 'ListItem tone requires a visible status',
    path: ['tone'],
  })
export const StatAtomPropsSchema = z
  .object({
    label: ShortText,
    value: MetricValueSchema.optional(),
    valueFormat: ValueFormatSchema.optional(),
    unit: ShortText.optional(),
    trend: ContentText.optional(),
    detail: ContentText.optional(),
    emptyText: ShortText.optional(),
  })
  .strict()
export const ProgressAtomPropsSchema = z
  .object({
    label: ShortText,
    value: ProgressValueSchema.optional(),
    emptyText: ShortText.optional(),
  })
  .strict()
export const TableRowsSchema = z.array(z.record(ContentValueSchema))
export const TableAtomPropsSchema = z
  .object({
    columns: z
      .array(ShortText)
      .min(1)
      .refine(
        (columns) => new Set(columns).size === columns.length,
        'Table columns must be unique',
      ),
    rows: TableRowsSchema.optional(),
    columnFormats: z.record(ValueFormatSchema).optional(),
    caption: ShortText.optional(),
    emptyText: ShortText.optional(),
  })
  .strict()
  .superRefine((props, ctx) => {
    for (const column of Object.keys(props.columnFormats ?? {}))
      if (!props.columns.includes(column))
        ctx.addIssue({
          code: 'custom',
          path: ['columnFormats', column],
          message: 'A Table format must name a declared column',
        })
  })
export const AutomationAtomPropsSchema = z
  .object({
    label: ShortText,
    schedule: ShortText,
    scheduleDetails: AutomationScheduleSchema.optional(),
    enabled: z.boolean().optional(),
    history: AutomationRunHistorySchema.optional(),
    historyBinding: z.string().min(1).max(160).optional(),
  })
  .strict()
  .refine((props) => props.history === undefined || props.historyBinding === undefined, {
    message: 'Automation history must use one source',
    path: ['historyBinding'],
  })
export type AutomationAtomProps = z.infer<typeof AutomationAtomPropsSchema>

const contentSchemas = {
  Title: TitleAtomPropsSchema,
  Text: TextAtomPropsSchema,
  Caption: CaptionAtomPropsSchema,
  Label: LabelAtomPropsSchema,
  Markdown: MarkdownAtomPropsSchema,
  Badge: BadgeAtomPropsSchema,
  ListItem: ListItemAtomPropsSchema,
  Table: TableAtomPropsSchema,
  Stat: StatAtomPropsSchema,
  Progress: ProgressAtomPropsSchema,
  Automation: AutomationAtomPropsSchema,
}
type ContentAtomType = keyof typeof contentSchemas
const textTypes = new Set(['Title', 'Text', 'Caption', 'Label', 'Markdown'])

interface ContentAtomCandidate {
  type: AtomNode['type']
  props?: Readonly<Record<string, unknown>> | undefined
  binding?: string | undefined
  actions?: AtomNode['actions'] | undefined
  children?: AtomNode['children'] | undefined
}

export function validateContentAtom(node: ContentAtomCandidate, ctx: z.RefinementCtx): void {
  if (!isContentAtomType(node.type)) return
  const parsed = contentSchemas[node.type].safeParse(node.props ?? {})
  if (!parsed.success) {
    for (const problem of parsed.error.issues)
      ctx.addIssue({ ...problem, path: ['props', ...problem.path] })
  }
  if (node.children !== undefined) issue(ctx, ['children'], `${node.type} must be a leaf Atom`)
  if (node.type !== 'ListItem' && node.type !== 'Automation' && node.actions !== undefined) {
    issue(ctx, ['actions'], `${node.type} does not accept actions`)
  }
  if (textTypes.has(node.type)) requireSource(node, 'text', ctx)
  else if (node.type === 'Table') requireSource(node, 'rows', ctx)
  else if (node.type === 'Stat' || node.type === 'Progress') requireSource(node, 'value', ctx)
  else if (node.type === 'Automation') requireSource(node, 'enabled', ctx)
  else if (node.binding !== undefined)
    issue(ctx, ['binding'], `${node.type} does not accept a binding`)

  if (
    node.type === 'ListItem' &&
    node.actions !== undefined &&
    (node.actions.length !== 1 || node.actions[0]?.name !== 'click')
  ) {
    issue(ctx, ['actions'], 'ListItem accepts exactly one click action')
  }
  if (node.type === 'Automation') {
    const action = node.actions?.[0]
    if (node.binding !== undefined && (node.actions?.length !== 1 || action?.name !== 'toggle')) {
      issue(ctx, ['actions'], 'A bound Automation requires exactly one toggle action')
    } else if (node.binding === undefined && node.actions !== undefined) {
      issue(ctx, ['actions'], 'Display-only Automation does not accept actions')
    }
    if (action?.path === 'fast') validateTypedControlBindingWrite(node, action, ctx)
  }
  if (node.type === 'Table' && parsed.success && node.props?.['rows'] !== undefined) {
    validateTableRows(node.props['rows'], node.props['columns'], ['props', 'rows'], ctx)
  }
}

export function validateContentState(
  node: AtomNode,
  state: JsonObject,
  ctx: z.RefinementCtx,
): void {
  const key = node.binding
  if (key !== undefined && Object.hasOwn(state, key)) {
    const schema = textTypes.has(node.type)
      ? ContentText
      : node.type === 'Stat'
        ? MetricValueSchema
        : node.type === 'Progress'
          ? ProgressValueSchema
          : node.type === 'Automation'
            ? z.boolean()
            : undefined
    if (schema !== undefined && !schema.safeParse(state[key]).success) {
      issue(ctx, ['state', key], `${node.type} binding "${key}" has an incompatible value`)
    }
    if (node.type === 'Table')
      validateTableRows(state[key], node.props?.['columns'], ['state', key], ctx)
  }
  const historyKey = node.type === 'Automation' ? node.props?.['historyBinding'] : undefined
  if (
    typeof historyKey === 'string' &&
    !AutomationRunHistorySchema.safeParse(state[historyKey]).success
  ) {
    issue(
      ctx,
      ['state', historyKey],
      'Automation history binding requires a valid run-history array',
    )
  }
  node.children?.forEach((child) => validateContentState(child, state, ctx))
}

function isContentAtomType(type: string): type is ContentAtomType {
  return Object.hasOwn(contentSchemas, type)
}

function requireSource(node: ContentAtomCandidate, prop: string, ctx: z.RefinementCtx): void {
  const hasStatic = node.props?.[prop] !== undefined
  if (hasStatic === (node.binding !== undefined)) {
    issue(
      ctx,
      [hasStatic ? 'binding' : 'props', prop],
      `${node.type} requires exactly one ${prop} source: props or binding`,
    )
  }
}

function validateTableRows(
  value: unknown,
  columns: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const rows = TableRowsSchema.safeParse(value)
  if (!rows.success) {
    for (const problem of rows.error.issues)
      ctx.addIssue({ ...problem, path: [...path, ...problem.path] })
    return
  }
  if (!Array.isArray(columns)) return
  rows.data.forEach((row, index) => {
    for (const column of columns) {
      if (typeof column === 'string' && !Object.hasOwn(row, column)) {
        issue(
          ctx,
          [...path, index, column],
          `Table row is missing required column "${column}"; use null for an unknown cell`,
        )
      }
    }
  })
}

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
}
