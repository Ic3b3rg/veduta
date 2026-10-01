import type { ActionScalarSpec, FastActionPlan } from './action-plan.ts'
import type { JsonValue } from './json.ts'

/** A bounded value-changing control remains a one-step instance of the same plan. */
export function inputSetPlan(target: string, spec: ActionScalarSpec): FastActionPlan {
  return {
    inputs: { value: spec },
    targets: {
      [target]: {
        type: spec.type,
        ...(spec.nullable === undefined ? {} : { nullable: spec.nullable }),
      },
    },
    steps: [{ op: 'set', target, value: { source: 'input', name: 'value' } }],
  }
}
export function literalSetPlan(target: string, value: JsonValue): FastActionPlan {
  const type = value === null ? 'null' : typeof value
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'null')
    throw new Error('literal control value must be a scalar')
  return {
    inputs: {},
    targets: { [target]: { type } },
    steps: [{ op: 'set', target, value: { source: 'literal', value } }],
  }
}
export function formSetPlan(fields: readonly string[]): FastActionPlan {
  return {
    inputs: Object.fromEntries(fields.map((key) => [key, { type: 'string' }])),
    targets: Object.fromEntries(fields.map((key) => [key, { type: 'string' }])),
    steps: fields.map((target) => ({
      op: 'set',
      target,
      value: { source: 'input', name: target },
    })),
  }
}
