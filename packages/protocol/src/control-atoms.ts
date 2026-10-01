import { z } from 'zod'
import type { ActionOwningNode } from './action-inputs.ts'
import type { FastAction } from './action.ts'
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
  validateTypedControlBindingWrite(node, action, ctx)
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

/** A bound fast control must commit its owning gesture after all writes to that binding. */
export function validateTypedControlBindingWrite(
  node: ActionOwningNode,
  action: FastAction,
  ctx: z.RefinementCtx,
): void {
  const finalBindingStep = action.plan.steps.filter((step) => step.target === node.binding).at(-1)
  if (
    finalBindingStep?.op !== 'set' ||
    finalBindingStep.value.source !== 'input' ||
    finalBindingStep.value.name !== 'value'
  )
    ctx.addIssue({
      code: 'custom',
      path: ['actions', 0, 'plan', 'steps'],
      params: { semanticCode: 'invalid_bound_control_write' },
      message: `${node.type} must set its binding from the typed value input`,
    })
}

export function validateSelectionControlState(
  node: ActionOwningNode,
  state: JsonObject,
  ctx: z.RefinementCtx,
): void {
  const binding = node.binding
  if (binding && Object.hasOwn(state, binding)) {
    const message = controlValueIssue(node, state[binding])
    if (message) ctx.addIssue({ code: 'custom', path: ['state', binding], message })
  }
  node.children?.forEach((child) => validateSelectionControlState(child, state, ctx))
}

function controlValueIssue(node: ActionOwningNode, value: unknown): string | undefined {
  if (node.type === 'Checkbox' && typeof value !== 'boolean')
    return 'Checkbox state must be a boolean'
  if (node.type === 'Select' || node.type === 'RadioGroup') {
    const props = SelectAtomPropsSchema.safeParse(node.props)
    if (!props.success || !props.data.options.some((option) => option.value === value))
      return `${node.type} state must match an offered option value`
  }
  if (node.type === 'DatePicker' && !isControlDate(value, node.props?.['allowEmpty'] === true))
    return 'DatePicker state must be a real YYYY-MM-DD date; empty requires allowEmpty: true'
  return undefined
}

/** Known constants must satisfy the same control semantics as each intermediate canonical write. */
export function validateSelectionControlPlanValues(
  tree: ActionOwningNode,
  ctx: z.RefinementCtx,
): void {
  const bindings = new Map<string, ActionOwningNode[]>()
  function collect(node: ActionOwningNode): void {
    if (node.binding && Object.hasOwn(controlSchemas, node.type))
      bindings.set(node.binding, [...(bindings.get(node.binding) ?? []), node])
    node.children?.forEach(collect)
  }
  function walk(node: ActionOwningNode, path: (string | number)[]): void {
    node.actions?.forEach((action, actionIndex) => {
      if (action.path !== 'fast') return
      action.plan.steps.forEach((step, stepIndex) => {
        const value =
          step.op === 'clear'
            ? step.value
            : step.op === 'set' && step.value.source === 'literal'
              ? step.value.value
              : undefined
        for (const control of bindings.get(step.target) ?? []) {
          const message =
            value !== undefined
              ? controlValueIssue(control, value)
              : step.op === 'set' &&
                  step.value.source === 'metadata' &&
                  control.type === 'DatePicker'
                ? 'Gateway metadata is not a calendar-only date'
                : undefined
          if (message)
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'actions', actionIndex, 'plan', 'steps', stepIndex, 'value'],
              message,
            })
        }
      })
    })
    node.children?.forEach((child, index) => walk(child, [...path, 'children', index]))
  }
  collect(tree)
  walk(tree, ['tree'])
}
