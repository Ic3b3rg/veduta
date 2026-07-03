import { z } from 'zod'
import { AtomNodeSchema } from './atom.ts'
import { JsonObjectSchema, JsonValueSchema } from './json.ts'

const JsonPointerSchema = z.string().regex(/^\/.*$/, {
  message: 'JSON pointer paths must start with "/"',
})

const StateSetOperationSchema = z
  .object({
    target: z.literal('state'),
    op: z.enum(['add', 'replace']),
    path: JsonPointerSchema,
    value: JsonValueSchema,
  })
  .strict()

const StateRemoveOperationSchema = z
  .object({
    target: z.literal('state'),
    op: z.literal('remove'),
    path: JsonPointerSchema,
  })
  .strict()

const TreeSetOperationSchema = z
  .object({
    target: z.literal('tree'),
    op: z.enum(['add', 'replace']),
    path: JsonPointerSchema,
    value: AtomNodeSchema,
  })
  .strict()

const TreeRemoveOperationSchema = z
  .object({
    target: z.literal('tree'),
    op: z.literal('remove'),
    path: JsonPointerSchema,
  })
  .strict()

const TreeMoveOperationSchema = z
  .object({
    target: z.literal('tree'),
    op: z.literal('move'),
    from: JsonPointerSchema,
    path: JsonPointerSchema,
  })
  .strict()

export const PatchOperationSchema = z.union([
  StateSetOperationSchema,
  StateRemoveOperationSchema,
  TreeSetOperationSchema,
  TreeRemoveOperationSchema,
  TreeMoveOperationSchema,
])

/**
 * JSON-Patch-like Surface patch. Paths are scoped to either the Surface
 * state or tree so the Gateway can route fast state updates separately
 * from Agent-authored tree changes.
 */
export const PatchSchema = z.object({
  surfaceId: z.string().min(1),
  operations: z.array(PatchOperationSchema).min(1),
})

export type PatchOperation = z.infer<typeof PatchOperationSchema>
export type Patch = z.infer<typeof PatchSchema>

/** A fast-path action invocation sent by a client to the daemon. */
export const ActionInvocationSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  payload: JsonObjectSchema.optional(),
})

export type ActionInvocation = z.infer<typeof ActionInvocationSchema>
