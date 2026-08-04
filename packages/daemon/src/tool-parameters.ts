import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolDef } from './agent-runner.ts'
import type { PiToolParameters } from './pi-agent-runner.ts'

/**
 * Derives the pi-facing parameter schema for every offered `ToolDef`
 * (issue #37, the tool registry the Agent loop offers): `PiAgentRunner.toPiTools`
 * throws for any offered tool with no
 * entry in its `toolParameters` map, so this is the single place that map
 * gets built from the daemon's own zod `ToolDef.schema`s. The zod
 * `safeParse` inside `toPiAgentTool` (`pi-agent-runner.ts`) remains the true
 * validation gate at call time — what this module produces is only the
 * provider-facing shape a model reads to know what arguments to send.
 *
 * Throws on a duplicate tool name in `tools`: a caller assembling the
 * registry (trust-wrapped outbound tools, Surface tools, memory tools,
 * Template tools, scheduler tools, `spawn_worker`) must not offer the same
 * name twice, and a silently-overwritten map entry would hide that bug
 * instead of failing the build.
 */
export function piToolParameters(tools: ToolDef[]): Record<string, PiToolParameters> {
  const parameters: Record<string, PiToolParameters> = {}
  for (const tool of tools) {
    if (Object.prototype.hasOwnProperty.call(parameters, tool.name)) {
      throw new Error(`duplicate tool name in registry: "${tool.name}"`)
    }
    parameters[tool.name] = toolParameters(tool)
  }
  return parameters
}

function toolParameters(tool: ToolDef): PiToolParameters {
  // Providers don't resolve `$ref`: inline everything. A recursive schema
  // (the Surface Atom tree, `create_surface`'s `tree` field) cannot be
  // inlined infinitely, so zod-to-json-schema degrades the recursive branch
  // to an unconstrained `{}` instead of emitting a `$ref` — an accepted
  // widening, since the zod `safeParse` in `toPiAgentTool` is the real gate.
  const derived = zodToJsonSchema(tool.schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>
  // `$schema` is a JSON-Schema-the-document marker, meaningless as one field
  // among a tool call's parameters; drop it before it reaches the provider.
  const { $schema: _schemaMarker, ...schema } = derived
  const objectSchema = asObjectSchema(schema, tool.name)
  // TypeBox's `TSchema` is a JSON-Schema-shaped object at runtime; this cast
  // is the deliberate seam between zod-derived JSON Schema and pi's TypeBox
  // typing (issue #37) — the single point where that seam is crossed.
  return objectSchema as PiToolParameters
}

/**
 * Providers require a top-level object schema for tool parameters. Most
 * `ToolDef.schema`s are already `z.object(...)` (optionally `.extend(...)`),
 * which zod-to-json-schema renders directly as `{ type: 'object', ... }`.
 * The one exception in the real registry is `gateCreateSurfaceTool`
 * (`template-engine.ts`), which wraps `create_surface` with
 * `tool.schema.and(...).and(...)` — a zod intersection that renders as a
 * top-level `allOf` of otherwise-plain object schemas. `mergeAllOfObjects`
 * flattens that trivial case into one object schema; anything else (a
 * non-object top-level schema, an `allOf` member that isn't itself a plain
 * object schema) is a shape pi cannot use and fails loudly here rather than
 * reaching the provider as a broken parameter schema.
 */
function asObjectSchema(
  schema: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (schema['type'] === 'object') return schema
  if (Array.isArray(schema['allOf'])) return mergeAllOfObjects(schema['allOf'], toolName)
  throw new Error(
    `tool "${toolName}" derives a non-object top-level parameter schema ` +
      `(${JSON.stringify(schema)}); pi requires an object schema for tool parameters`,
  )
}

/**
 * Merges an `allOf` of plain object schemas into one `{ type: 'object' }`
 * schema: properties union (later members win on a key collision, though
 * the real registry's only intersection — `gateCreateSurfaceTool` — never
 * collides), required keys union (deduplicated). Throws if any member is
 * not itself a plain object schema — this is deliberately not a general
 * JSON Schema `allOf` merger, only the trivial case the real tool registry
 * produces.
 */
function mergeAllOfObjects(members: unknown[], toolName: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const member of members) {
    if (!isRecord(member) || member['type'] !== 'object') {
      throw new Error(
        `tool "${toolName}"'s parameter schema is an allOf with a non-object member ` +
          `(${JSON.stringify(member)}); cannot merge into a single object schema for pi`,
      )
    }
    const memberProperties = member['properties']
    if (isRecord(memberProperties)) Object.assign(properties, memberProperties)
    const memberRequired = member['required']
    if (Array.isArray(memberRequired)) {
      for (const key of memberRequired) if (typeof key === 'string') required.add(key)
    }
  }
  return {
    type: 'object',
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
