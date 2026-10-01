import type { z } from 'zod'
import type { AtomNode } from './atom.ts'
import type { ActionScalarSpec, ActionValueSource } from './action-plan.ts'
import { owningActionInputs } from './action-inputs.ts'
import type { JsonObject, JsonValue } from './json.ts'

type BoundValueValidator = (tree: AtomNode, state: JsonObject, ctx: z.RefinementCtx) => void

/** Static shape witnesses inspect value sources; they never reduce or execute an Action plan. */
export function validateActionOperability(
  tree: AtomNode,
  state: JsonObject,
  ctx: z.RefinementCtx,
  validateBoundValues: BoundValueValidator,
): void {
  function inspect(node: AtomNode, path: (string | number)[]): void {
    node.actions?.forEach((action, index) => {
      if (action.path !== 'fast') return
      const plan = action.plan
      const inputs = owningActionInputs(node)
      function sourceShape(source: ActionValueSource): JsonValue | undefined {
        if (source.source === 'literal') return source.value
        if (source.source === 'metadata')
          return source.name === 'now'
            ? '2000-01-01T00:00:00.000Z'
            : '00000000-0000-4000-8000-000000000000'
        if (source.source === 'input')
          return scalarShape(inputs[source.name] ?? plan.inputs[source.name])
        const record: JsonObject = {}
        for (const [field, value] of Object.entries(source.fields)) {
          const shape = sourceShape(value)
          if (shape === undefined) return undefined
          record[field] = shape
        }
        return record
      }
      plan.steps.forEach((step, stepIndex) => {
        let value: JsonValue | undefined
        if (step.op === 'clear') value = step.value
        else if (step.op === 'set') value = sourceShape(step.value)
        else if (step.op === 'append') {
          const record = sourceShape(step.value)
          if (record !== undefined) value = [record]
        } else if (step.op === 'update') {
          const records = state[step.target]
          if (!Array.isArray(records) || records.length === 0) return
          const fields: JsonObject = {}
          for (const [field, source] of Object.entries(step.fields)) {
            const shape = sourceShape(source)
            if (shape === undefined) return
            fields[field] = shape
          }
          value = records.map((record) =>
            record !== null && !Array.isArray(record) && typeof record === 'object'
              ? { ...record, ...fields }
              : record,
          )
        } else return
        if (value === undefined) return
        const valuePath = [...path, 'actions', index, 'plan', 'steps', stepIndex, 'value']
        validateBoundValues(
          tree,
          { ...state, [step.target]: value },
          {
            path: [],
            addIssue: (issue) =>
              ctx.addIssue({
                code: 'custom',
                path: valuePath,
                params: { semanticCode: 'invalid_atom_action_value' },
                message: `${issue.path?.join('.') ?? step.target}: ${issue.message ?? 'invalid bound Atom value'}`,
              }),
          },
        )
      })
    })
    node.children?.forEach((child, index) => inspect(child, [...path, 'children', index]))
  }
  inspect(tree, ['tree'])
}

function scalarShape(spec: ActionScalarSpec | undefined): JsonValue | undefined {
  if (!spec) return undefined
  if (spec.enum !== undefined) return spec.enum[0]
  if (spec.type === 'string') return '2000-01-01'
  if (spec.type === 'number') return 0
  if (spec.type === 'boolean') return false
  return null
}
