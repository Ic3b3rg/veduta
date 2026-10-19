const schemaMaps = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
])
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const singleSchemas = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
])
const referenceKeywords = new Set(['$ref', '$dynamicRef', '$id', '$anchor', '$dynamicAnchor'])

/** Losslessly share the expanded pi schemas in Claude's text context (issue #285). */
export function compactClaudeToolSchema(schema: unknown): unknown {
  // Moving a pre-existing reference or scoped identity could change its resolution.
  if (!isRecord(schema) || hasReferences(schema)) return schema
  const counts = new Map<string, number>()
  const count = (node: unknown): unknown => {
    if (!isRecord(node)) return node
    const key = JSON.stringify(node)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return mapSubschemas(node, count)
  }
  count(schema)

  const definitions: Record<string, unknown> = {}
  const existing = isRecord(schema['definitions']) ? schema['definitions'] : {}
  const shared = new Map<string, string>()
  let sequence = 0
  const compact = (node: unknown): unknown => {
    if (!isRecord(node)) return node
    const key = JSON.stringify(node)
    if (key.length < 160 || (counts.get(key) ?? 0) < 2) return mapSubschemas(node, compact)
    let name = shared.get(key)
    if (name === undefined) {
      do {
        name = `veduta${++sequence}`
      } while (Object.hasOwn(existing, name))
      shared.set(key, name)
      definitions[name] = mapSubschemas(node, compact)
    }
    return { $ref: `#/definitions/${name}` }
  }
  const result = mapSubschemas(schema, compact)
  if (Object.keys(definitions).length === 0) return schema
  const retained = isRecord(result['definitions']) ? result['definitions'] : {}
  return { ...result, definitions: { ...retained, ...definitions } }
}

function mapSubschemas(
  schema: Record<string, unknown>,
  visit: (node: unknown) => unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isRecord(value))
        return [
          key,
          Object.fromEntries(Object.entries(value).map(([name, node]) => [name, visit(node)])),
        ]
      if (schemaArrays.has(key) && Array.isArray(value)) return [key, value.map(visit)]
      if (singleSchemas.has(key))
        return [key, Array.isArray(value) ? value.map(visit) : visit(value)]
      return [key, value]
    }),
  )
}

function hasReferences(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReferences)
  return (
    isRecord(value) &&
    Object.entries(value).some(([key, entry]) => referenceKeywords.has(key) || hasReferences(entry))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
