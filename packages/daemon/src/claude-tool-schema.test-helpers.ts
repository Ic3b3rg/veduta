/** Independent JSON Pointer expansion checks the schema contract, rather than its encoding. */
export function expandClaudeToolSchema(value: unknown): unknown {
  if (!isRecord(value)) throw new Error('Expected an object schema')
  const definitions = value['definitions']
  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand)
    if (!isRecord(node)) return node
    const ref = node['$ref']
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/definitions/') || !isRecord(definitions))
        throw new Error('Unexpected schema reference')
      const target = definitions[ref.slice('#/definitions/'.length)]
      if (target === undefined) throw new Error('Unresolved schema reference')
      return expand(target)
    }
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, expand(entry)]))
  }
  const { definitions: _definitions, ...body } = value
  return expand(body)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
