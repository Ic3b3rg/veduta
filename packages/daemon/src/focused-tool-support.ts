import type { ZodTypeAny } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { isUntrusted, untrustedDataBlock, untrustedSource, type Origin } from './taint.ts'

/** Injects trusted turn scope after parsing, so caller input cannot redirect a focused write. */
export function bindToolToSpace(tool: ToolDef, schema: ZodTypeAny, spaceId: string): ToolDef {
  return defineTool({
    name: tool.name,
    description: tool.description,
    schema,
    level: tool.level,
    egressDomains: tool.egressDomains,
    handler(input, context) {
      return tool.handler({ ...input, spaceId }, context)
    },
  })
}

/** Marks model-visible stored JSON as data when any source origin is Untrusted. */
export function renderFocusedStoredJson(value: unknown, origins: Origin[], field: string): string {
  const json = JSON.stringify(value)
  const untrusted = origins.find(isUntrusted)
  if (!untrusted) return json
  return untrustedDataBlock(untrustedSource(untrusted) ?? 'external', [[field, json]])
}
