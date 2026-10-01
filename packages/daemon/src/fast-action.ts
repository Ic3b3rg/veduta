import { randomUUID } from 'node:crypto'
import {
  SurfaceSchema,
  canonicalJson,
  findAtom,
  fastActionInputsSchema,
  type AtomNode,
  type FastAction,
  type FastActionInvocation,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Surface,
  type ActionValueSource,
} from '@veduta/protocol'

export type SurfaceActionErrorCode =
  | 'unknown_surface'
  | 'undeclared_action'
  | 'invalid_payload'
  | 'stale_action'
  | 'missing_target'
  | 'preflight_rejected'
  | 'intent_conflict'
export class SurfaceActionError extends Error {
  constructor(
    readonly code: SurfaceActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SurfaceActionError'
  }
}

/** Precondition callbacks may inspect a proposed batch but cannot edit its canonical write. */
export function freezeFastActionPreflight<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeFastActionPreflight(child)
    Object.freeze(value)
  }
  return value
}

function signature(node: AtomNode, action: FastAction): string {
  const { revision: _revision, ...contract } = action
  const fields: unknown[] = []
  function walk(child: AtomNode): void {
    if (child.type === 'Form') return
    if (child.type === 'Input' || child.type === 'Textarea')
      fields.push({ id: child.id, type: child.type, binding: child.binding, props: child.props })
    child.children?.forEach(walk)
  }
  if (node.type === 'Form') node.children?.forEach(walk)
  return canonicalJson({
    type: node.type,
    props: node.props,
    binding: node.binding,
    contract,
    fields,
  })
}

/** Author-supplied revisions never authorize a write; the Gateway seals semantic declarations. */
export function stampFastActionRevisions(tree: AtomNode, previous?: AtomNode): AtomNode {
  function walk(node: AtomNode): AtomNode {
    const oldNode = previous ? findAtom(previous, node.id) : undefined
    return {
      ...node,
      ...(node.actions === undefined
        ? {}
        : {
            actions: node.actions.map((action) => {
              if (action.path !== 'fast') return action
              const old = oldNode?.actions?.find((candidate) => candidate.name === action.name)
              const revision =
                old?.path === 'fast' &&
                old.revision &&
                signature(node, action) === signature(oldNode!, old)
                  ? old.revision
                  : `acr-${randomUUID()}`
              return { ...action, revision }
            }),
          }),
      ...(node.children === undefined ? {} : { children: node.children.map(walk) }),
    }
  }
  return walk(tree)
}

export function reduceFastAction(
  surface: Surface,
  node: AtomNode,
  action: FastAction,
  invocation: FastActionInvocation,
  metadata: { recordId: string; now: string },
): { surface: Surface; operations: PatchOperation[]; reason: 'unchanged' | 'missing_target' } {
  const parsed = fastActionInputsSchema(node, action).safeParse(invocation.inputs)
  if (!parsed.success)
    throw new SurfaceActionError(
      'invalid_payload',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  const inputs = parsed.data
  function value(source: ActionValueSource): JsonValue {
    if (source.source === 'literal') return structuredClone(source.value)
    if (source.source === 'metadata') return metadata[source.name]
    if (source.source === 'input') return inputs[source.name]!
    return Object.fromEntries(
      Object.entries(source.fields).map(([key, field]) => [key, value(field)]),
    )
  }
  let current = surface
  let reason: 'unchanged' | 'missing_target' = 'unchanged'
  const operations: PatchOperation[] = []
  for (const step of action.plan.steps) {
    const before = current.state[step.target]!
    let next: JsonValue
    if (step.op === 'set') next = value(step.value)
    else if (step.op === 'clear') next = structuredClone(step.value)
    else {
      if (!Array.isArray(before))
        throw new SurfaceActionError('invalid_payload', 'collection target is not an array')
      if (step.op === 'append') next = [...before, value(step.value)]
      else {
        const spec = action.plan.targets[step.target]
        if (spec?.type !== 'array' || spec.items.type !== 'object')
          throw new SurfaceActionError(
            'invalid_payload',
            'record operation requires stable identity',
          )
        const identityKey = spec.items.identityKey
        const selector = value(step.selector)
        const matches = before.flatMap((item, index) =>
          item !== null &&
          !Array.isArray(item) &&
          typeof item === 'object' &&
          item[identityKey] === selector
            ? [index]
            : [],
        )
        if (matches.length > 1)
          throw new SurfaceActionError('invalid_payload', 'record identity is ambiguous')
        const index = matches[0]
        if (index === undefined) {
          if (step.missing === 'reject')
            throw new SurfaceActionError('missing_target', 'the selected record no longer exists')
          reason = 'missing_target'
          continue
        }
        if (step.op === 'remove') next = before.filter((_, position) => position !== index)
        else
          next = before.map((record, position) =>
            position === index
              ? {
                  ...(record as JsonObject),
                  ...Object.fromEntries(
                    Object.entries(step.fields).map(([key, source]) => [key, value(source)]),
                  ),
                }
              : record,
          )
      }
    }
    const state = { ...current.state, [step.target]: next }
    const validated = SurfaceSchema.safeParse({ ...current, state })
    if (!validated.success)
      throw new SurfaceActionError(
        'invalid_payload',
        validated.error.issues.map((issue) => issue.message).join('; '),
      )
    current = validated.data
    operations.push({
      target: 'state',
      op: 'replace',
      path: `/${step.target.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      value: next,
    })
  }
  return {
    surface: current,
    operations: canonicalJson(current.state) === canonicalJson(surface.state) ? [] : operations,
    reason,
  }
}
