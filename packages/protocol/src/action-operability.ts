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
      function sourceShape(
        source: ActionValueSource,
        valueWitness: JsonValue | undefined,
      ): JsonValue | undefined {
        if (source.source === 'literal') return source.value
        if (source.source === 'metadata')
          return source.name === 'now'
            ? '2000-01-01T00:00:00.000Z'
            : '00000000-0000-4000-8000-000000000000'
        if (source.source === 'input')
          return source.name === 'value' && valueWitness !== undefined
            ? valueWitness
            : scalarShape(inputs[source.name] ?? plan.inputs[source.name])
        const record: JsonObject = {}
        for (const [field, value] of Object.entries(source.fields)) {
          const shape = sourceShape(value, valueWitness)
          if (shape === undefined) return undefined
          record[field] = shape
        }
        return record
      }
      plan.steps.forEach((step, stepIndex) => {
        for (const valueWitness of actionInputWitnesses(node, inputs['value'])) {
          let value: JsonValue | undefined
          if (step.op === 'clear') value = step.value
          else if (step.op === 'set') value = sourceShape(step.value, valueWitness)
          else if (step.op === 'append') {
            const record = sourceShape(step.value, valueWitness)
            if (record !== undefined) value = [record]
          } else if (step.op === 'update') {
            const records = state[step.target]
            if (!Array.isArray(records) || records.length === 0) break
            const fields: JsonObject = {}
            for (const [field, source] of Object.entries(step.fields)) {
              const shape = sourceShape(source, valueWitness)
              if (shape === undefined) return
              fields[field] = shape
            }
            value = records.map((record) =>
              record !== null && !Array.isArray(record) && typeof record === 'object'
                ? { ...record, ...fields }
                : record,
            )
          } else break
          if (value === undefined) break
          const valuePath = [...path, 'actions', index, 'plan', 'steps', stepIndex, 'value']
          let invalidWitness = false
          validateBoundValues(
            tree,
            { ...state, [step.target]: value },
            {
              path: [],
              addIssue: (issue) => {
                invalidWitness = true
                ctx.addIssue({
                  code: 'custom',
                  path: valuePath,
                  params: { semanticCode: 'invalid_atom_action_value' },
                  message: `${issue.path?.join('.') ?? step.target}: ${issue.message ?? 'invalid bound Atom value'}`,
                })
              },
            },
          )
          if (invalidWitness) break
        }
      })
    })
    node.children?.forEach((child, index) => inspect(child, [...path, 'children', index]))
  }
  inspect(tree, ['tree'])
}

/** Every offered discrete interaction must preserve all bound Atom contracts. */
function actionInputWitnesses(
  node: AtomNode,
  valueSpec: ActionScalarSpec | undefined,
): (JsonValue | undefined)[] {
  if (valueSpec?.enum !== undefined) return valueSpec.enum
  if (valueSpec?.type === 'boolean') return [false, true]
  if (node.type === 'DatePicker' && node.props.allowEmpty === true) return ['2000-01-01', '']
  return [undefined]
}

function scalarShape(spec: ActionScalarSpec | undefined): JsonValue | undefined {
  if (!spec) return undefined
  if (spec.enum !== undefined) return spec.enum[0]
  if (spec.type === 'string') return '2000-01-01'
  if (spec.type === 'number') return 0
  if (spec.type === 'boolean') return false
  return null
}
