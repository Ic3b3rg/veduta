import type { z } from 'zod'
import type { Action } from './action.ts'
import type { FastAction } from './action.ts'
import {
  actionValueMatches,
  isActionEmptyValue,
  type ActionScalarSpec,
  type ActionValueSpec,
  type ActionValueSource,
} from './action-plan.ts'
import { canonicalJson, JsonObjectSchema, type JsonObject } from './json.ts'

export interface ActionOwningNode {
  type: string
  props?: JsonObject | undefined
  binding?: string | undefined
  children?: readonly ActionOwningNode[] | undefined
  actions?: Action[] | undefined
}

/** The complete inputs owned by this interaction, independent of its mutation targets. */
export function owningActionInputs(node: ActionOwningNode): Record<string, ActionScalarSpec> {
  if (node.type === 'Form') {
    const fields: Record<string, ActionScalarSpec> = {}
    function walk(child: ActionOwningNode): void {
      if (child.type === 'Form') return
      if ((child.type === 'Input' || child.type === 'Textarea') && child.binding) {
        fields[child.binding] = {
          type: child.props?.['valueType'] === 'number' ? 'number' : 'string',
        }
      }
      child.children?.forEach(walk)
    }
    node.children?.forEach(walk)
    return fields
  }
  if (['Checkbox', 'Switch', 'Automation'].includes(node.type))
    return { value: { type: 'boolean' } }
  if (['Select', 'Combobox', 'RadioGroup'].includes(node.type)) {
    const options = node.props?.['options']
    const values = Array.isArray(options)
      ? options.flatMap((option) => {
          if (typeof option === 'string') return [option]
          if (
            option !== null &&
            typeof option === 'object' &&
            !Array.isArray(option) &&
            typeof option['value'] === 'string'
          )
            return [option['value']]
          return []
        })
      : []
    return { value: { type: 'string', ...(values.length ? { enum: values } : {}) } }
  }
  if (node.type === 'DatePicker') return { value: { type: 'string' } }
  return {}
}

export function validateOwningActionDeclarations(
  node: Parameters<typeof owningActionInputs>[0] & { actions?: Action[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>()
  node.actions?.forEach((action, index) => {
    if (names.has(action.name))
      ctx.addIssue({
        code: 'custom',
        path: ['actions', index, 'name'],
        message: 'Action names must be unique within their owning Atom',
      })
    names.add(action.name)
    if (action.path !== 'fast') return
    const owned = owningActionInputs(node)
    if (
      canonicalJson(
        Object.fromEntries(
          Object.entries(action.plan.inputs).map(([key, spec]) => [key, { type: spec.type }]),
        ),
      ) !==
      canonicalJson(
        Object.fromEntries(Object.entries(owned).map(([key, spec]) => [key, { type: spec.type }])),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['actions', index, 'plan', 'inputs'],
        message: 'inputs must exactly match the owning Atom interaction fields and types',
      })
    for (const [key, spec] of Object.entries(action.plan.inputs)) {
      if (
        spec.nullable === true ||
        (spec.enum !== undefined && canonicalJson(spec.enum) !== canonicalJson(owned[key]?.enum))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['actions', index, 'plan', 'inputs', key],
          message: 'input constraints cannot contradict the owning control',
        })
    }
  })
}

export function fastActionInputsSchema(node: ActionOwningNode, action: FastAction) {
  return JsonObjectSchema.superRefine((inputs, ctx) => {
    const expected = owningActionInputs(node)
    for (const key of new Set([...Object.keys(inputs), ...Object.keys(expected)])) {
      const spec = expected[key]
      if (!spec || !Object.hasOwn(inputs, key) || !actionValueMatches(spec, inputs[key]!)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'input must exactly match the owning interaction contract',
        })
      }
    }
    if (node.props?.['disabled'] === true)
      ctx.addIssue({ code: 'custom', message: 'this control is disabled' })
    if (node.type === 'DatePicker' && inputs['value'] !== '' && !isCalendarDate(inputs['value'])) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'date must be a real YYYY-MM-DD date or an empty string',
      })
    }
    for (const [key, spec] of Object.entries(action.plan.inputs)) {
      if (!Object.hasOwn(inputs, key) || !actionValueMatches(spec, inputs[key]!))
        ctx.addIssue({ code: 'custom', path: [key], message: 'invalid declared typed input' })
    }
  })
}

function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** One shared validation hook for canonical writes, Template reuse, and catalog rendering. */
export function validateActionPlansState(
  tree: ActionOwningNode & { actions?: Action[] | undefined },
  state: JsonObject,
  ctx: z.RefinementCtx,
): void {
  const declarations = new Map<string, string>()
  function walk(
    node: ActionOwningNode & { actions?: Action[] | undefined },
    path: (string | number)[],
  ): void {
    node.actions?.forEach((action, index) => {
      if (action.path !== 'fast') return
      const plan = action.plan
      const base = [...path, 'actions', index, 'plan']
      const issue = (at: (string | number)[], message: string) =>
        ctx.addIssue({ code: 'custom', path: [...base, ...at], message })
      if (
        canonicalJson(
          Object.fromEntries(
            Object.entries(action.plan.inputs).map(([key, spec]) => [key, { type: spec.type }]),
          ),
        ) !==
        canonicalJson(
          Object.fromEntries(
            Object.entries(owningActionInputs(node)).map(([key, spec]) => [
              key,
              { type: spec.type },
            ]),
          ),
        )
      )
        issue(['inputs'], 'inputs must exactly match the owning Atom interaction fields and types')
      for (const [key, spec] of Object.entries(action.plan.targets)) {
        if (!Object.hasOwn(state, key) || !actionValueMatches(spec, state[key]!))
          issue(['targets', key], 'target must exist with its declared value shape')
        const signature = canonicalJson(spec)
        const previous = declarations.get(key)
        if (previous !== undefined && previous !== signature)
          issue(
            ['targets', key],
            'all Actions targeting one state key must declare the same value shape',
          )
        declarations.set(key, signature)
        if (spec.type === 'array' && spec.items.type === 'object' && Array.isArray(state[key])) {
          const seen = new Set<string>()
          for (const record of state[key]) {
            const id =
              record !== null && !Array.isArray(record) && typeof record === 'object'
                ? record[spec.items.identityKey]
                : undefined
            const identity = canonicalJson(id)
            if (id === undefined || id === null || id === '' || seen.has(identity))
              issue(
                ['targets', key],
                'collection records require unique non-empty stable identities',
              )
            seen.add(identity)
          }
        }
      }
      function source(
        source: ActionValueSource,
        spec: ActionValueSpec | Extract<ActionValueSpec, { type: 'array' }>['items'],
        at: (string | number)[],
      ): void {
        if (source.source === 'literal') {
          if (!actionValueMatches(spec, source.value))
            issue(at, 'literal must match the declared value shape')
        } else if (source.source === 'object') {
          if (
            spec.type !== 'object' ||
            canonicalJson(Object.keys(source.fields).sort()) !==
              canonicalJson(Object.keys(spec.fields).sort())
          ) {
            issue(at, 'object mapping must supply exactly the declared record fields')
            return
          }
          for (const [key, value] of Object.entries(source.fields))
            sourceCheck(value, spec.fields[key]!, [...at, 'fields', key])
        } else sourceCheck(source, spec, at)
      }
      function sourceCheck(
        value: Exclude<ActionValueSource, { source: 'object' }>,
        spec: Parameters<typeof source>[1],
        at: (string | number)[],
      ): void {
        if (value.source === 'literal') {
          source(value, spec, at)
          return
        }
        const input: ActionScalarSpec | undefined =
          value.source === 'input' ? plan.inputs[value.name] : { type: 'string' }
        if (
          !input ||
          spec.type === 'array' ||
          spec.type === 'object' ||
          input.type !== spec.type ||
          (input.nullable === true && spec.nullable !== true) ||
          (spec.enum !== undefined &&
            (input.enum === undefined || input.enum.some((item) => !spec.enum!.includes(item))))
        )
          issue(at, 'source must name a declared input or compatible Gateway metadata field')
      }
      action.plan.steps.forEach((step, stepIndex) => {
        const spec = action.plan.targets[step.target]
        const at = ['steps', stepIndex]
        if (!spec) return
        if (step.op === 'set') source(step.value, spec, [...at, 'value'])
        else if (step.op === 'clear') {
          if (!isActionEmptyValue(step.value) || !actionValueMatches(spec, step.value))
            issue([...at, 'value'], 'clear requires the exact schema-approved empty value')
        } else if (step.op === 'append') {
          if (spec.type !== 'array') issue(at, 'append requires an array target')
          else source(step.value, spec.items, [...at, 'value'])
        } else {
          if (spec.type !== 'array' || spec.items.type !== 'object') {
            issue(at, 'update/remove require a record collection with stable identity')
            return
          }
          sourceCheck(step.selector, spec.items.fields[spec.items.identityKey]!, [
            ...at,
            'selector',
          ])
          if (step.op === 'update')
            for (const [field, value] of Object.entries(step.fields)) {
              const fieldSpec = spec.items.fields[field]
              if (!fieldSpec || field === spec.items.identityKey)
                issue([...at, 'fields', field], 'update must name a declared non-identity field')
              else sourceCheck(value, fieldSpec, [...at, 'fields', field])
            }
        }
      })
    })
    node.children?.forEach((child, index) => walk(child, [...path, 'children', index]))
  }
  walk(tree, ['tree'])
}
