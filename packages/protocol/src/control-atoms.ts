import { z } from 'zod'
import type { ActionOwningNode } from './action-inputs.ts'
import { canonicalJson, type JsonObject } from './json.ts'

const sharedProps = {
  label: z.string().trim().min(1).max(120),
  disabled: z.boolean().optional(),
}

const optionsSchema = z
  .array(z.object({ label: sharedProps.label, value: z.string().min(1).max(160) }).strict())
  .min(1)
  .superRefine((options, ctx) => {
    const seen = new Set<string>()
    options.forEach((option, index) => {
      if (seen.has(option.value))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'value'],
          message: 'option values must be unique',
        })
      seen.add(option.value)
    })
  })

export const ButtonAtomPropsSchema = z
  .object({ ...sharedProps, variant: z.enum(['default', 'secondary', 'ghost']).optional() })
  .strict()
export const CheckboxAtomPropsSchema = z.object(sharedProps).strict()
export const SelectAtomPropsSchema = z.object({ ...sharedProps, options: optionsSchema }).strict()
export const RadioGroupAtomPropsSchema = SelectAtomPropsSchema
export const DatePickerAtomPropsSchema = z
  .object({ ...sharedProps, allowEmpty: z.boolean().optional() })
  .strict()

export type ButtonAtomProps = z.infer<typeof ButtonAtomPropsSchema>
export type CheckboxAtomProps = z.infer<typeof CheckboxAtomPropsSchema>
export type SelectAtomProps = z.infer<typeof SelectAtomPropsSchema>
export type RadioGroupAtomProps = z.infer<typeof RadioGroupAtomPropsSchema>
export type DatePickerAtomProps = z.infer<typeof DatePickerAtomPropsSchema>

const controlSchemas = {
  Button: ButtonAtomPropsSchema,
  Checkbox: CheckboxAtomPropsSchema,
  Select: SelectAtomPropsSchema,
  RadioGroup: RadioGroupAtomPropsSchema,
  DatePicker: DatePickerAtomPropsSchema,
}

/** The wire value is calendar-only; empty dates require an explicit authoring choice. */
export function isControlDate(value: unknown, allowEmpty = false): boolean {
  if (value === '') return allowEmpty
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validateSelectionControl(node: ActionOwningNode, ctx: z.RefinementCtx): void {
  if (!Object.hasOwn(controlSchemas, node.type)) return
  const schema = controlSchemas[node.type as keyof typeof controlSchemas]
  const props = schema.safeParse(node.props)
  if (!props.success)
    props.error.issues.forEach((issue) =>
      ctx.addIssue({ ...issue, path: ['props', ...issue.path] }),
    )
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message })
  if (node.children !== undefined) issue(['children'], `${node.type} must be a leaf Atom`)
  if (node.type === 'Button') {
    if (node.binding !== undefined) issue(['binding'], 'Button has no bound value')
    if (node.actions?.length !== 1)
      issue(['actions'], 'Button requires exactly one declared Action')
    return
  }
  if (!node.binding) issue(['binding'], `${node.type} requires a binding`)
  const name = node.type === 'Checkbox' ? 'toggle' : 'change'
  const action = node.actions?.[0]
  if (node.actions?.length !== 1 || action?.name !== name || action.path !== 'fast') {
    issue(['actions'], `${node.type} requires exactly one ${name} fast Action`)
    return
  }
  if (
    !action.plan.steps.some(
      (step) =>
        step.op === 'set' &&
        step.target === node.binding &&
        step.value.source === 'input' &&
        step.value.name === 'value',
    )
  )
    issue(
      ['actions', 0, 'plan', 'steps'],
      `${node.type} must set its binding from the typed value input`,
    )
  if (node.type === 'Select' || node.type === 'RadioGroup') {
    const offered = SelectAtomPropsSchema.safeParse(node.props)
    if (
      offered.success &&
      canonicalJson(action.plan.inputs['value']?.enum) !==
        canonicalJson(offered.data.options.map((option) => option.value))
    )
      issue(
        ['actions', 0, 'plan', 'inputs', 'value'],
        'value must declare exactly the offered option values',
      )
  }
}

export function validateSelectionControlState(
  node: ActionOwningNode,
  state: JsonObject,
  ctx: z.RefinementCtx,
): void {
  const binding = node.binding
  if (binding && Object.hasOwn(state, binding)) {
    const value = state[binding]
    let valid = true
    let message = ''
    if (node.type === 'Checkbox') {
      valid = typeof value === 'boolean'
      message = 'Checkbox state must be a boolean'
    } else if (node.type === 'Select' || node.type === 'RadioGroup') {
      const props = SelectAtomPropsSchema.safeParse(node.props)
      valid = props.success && props.data.options.some((option) => option.value === value)
      message = `${node.type} state must match an offered option value`
    } else if (node.type === 'DatePicker') {
      valid = isControlDate(value, node.props?.['allowEmpty'] === true)
      message = 'DatePicker state must be a real YYYY-MM-DD date; empty requires allowEmpty: true'
    }
    if (!valid) ctx.addIssue({ code: 'custom', path: ['state', binding], message })
  }
  node.children?.forEach((child) => validateSelectionControlState(child, state, ctx))
}
