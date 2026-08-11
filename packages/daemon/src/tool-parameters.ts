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
  // Let the converter represent recursion with `$ref`, then inline every
  // resolvable reference below. A reference that would close a cycle or whose
  // target the converter omitted is widened to `{}`; providers receive no
  // `$ref`, while repeated non-recursive schemas keep their full shape.
  const derived = zodToJsonSchema(tool.schema, {
    target: 'jsonSchema7',
    $refStrategy: 'root',
  }) as Record<string, unknown>
  // `$schema` is a JSON-Schema-the-document marker, meaningless as one field
  // among a tool call's parameters; drop it before it reaches the provider.
  const { $schema: _schemaMarker, ...schema } = derived
  const inlined = inlineJsonSchemaRefs(schema)
  const objectSchema = asObjectSchema(preserveJsonValueTypes(inlined), tool.name)
  // TypeBox's `TSchema` is a JSON-Schema-shaped object at runtime; this cast
  // is the deliberate seam between zod-derived JSON Schema and pi's TypeBox
  // typing (issue #37) — the single point where that seam is crossed.
  return objectSchema as PiToolParameters
}

/**
 * A recursive `JsonValue` becomes an `anyOf` whose first member is a string.
 * The provider runtime coerces unions while validating tool arguments, so a
 * valid number can otherwise become a string before the authoritative Zod
 * schema sees it. An unconstrained JSON-Schema node is the exact safe
 * provider contract for "any JSON value" and leaves the original primitive
 * type intact; the ToolDef schema still validates it in `toPiAgentTool`.
 */
function preserveJsonValueTypes(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!isRecord(value)) return value
    if (isJsonValueUnion(value)) {
      const description = value['description']
      return typeof description === 'string' ? { description } : {}
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]))
  }

  return visit(schema) as Record<string, unknown>
}

function isJsonValueUnion(schema: Record<string, unknown>): boolean {
  const members = schema['anyOf']
  if (!Array.isArray(members) || members.length !== 6) return false
  const types = members.flatMap((member) =>
    isRecord(member) && typeof member['type'] === 'string' ? [member['type']] : [],
  )
  return (
    types.length === 6 &&
    ['string', 'number', 'boolean', 'null', 'array', 'object'].every((type) => types.includes(type))
  )
}

function inlineJsonSchemaRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const inline = (value: unknown, activeRefs: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map((entry) => inline(entry, activeRefs))
    if (!isRecord(value)) return value

    const ref = value['$ref']
    if (typeof ref === 'string') {
      if (activeRefs.has(ref)) return {}
      const target = resolveJsonPointer(schema, ref)
      if (target === undefined) return {}
      return inline(target, new Set(activeRefs).add(ref))
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, inline(entry, activeRefs)]),
    )
  }

  return inline(schema, new Set()) as Record<string, unknown>
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '#') return root
  if (!pointer.startsWith('#/')) return undefined
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), root)
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
