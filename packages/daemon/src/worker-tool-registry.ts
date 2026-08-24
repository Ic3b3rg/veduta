import type { ToolDef } from './agent-runner.ts'
import type { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import type { SpacesEngine } from './spaces-engine.ts'

const WORKER_TOOL_NAMES = new Set(['read_recent', 'search_log', 'search_memory'])

export interface WorkerToolRegistryOptions {
  spacesEngine: SpacesEngine
  memoryRetrieval: MemoryRetrieval
}

/**
 * The Worker's complete capability ceiling (issue #39): read-only access to
 * the owning Space's recent Event log and hybrid memory index. The returned
 * definitions stay ordinary `ToolDef`s so `WorkerPool` can assert the L0 /
 * zero-egress invariant and `piToolParameters` can derive the provider-facing
 * schemas from the same Zod contracts used at execution time.
 */
export function workerToolRegistry(options: WorkerToolRegistryOptions): ToolDef[] {
  return createMemoryTools(options.spacesEngine, { retrieval: options.memoryRetrieval })
    .filter((tool) => WORKER_TOOL_NAMES.has(tool.name))
    .map(bindToWorkerSpace)
}

/**
 * A Worker may omit `spaceId`, but it may never select a Space other than
 * the one carried by its live `ToolContext`. Keep this policy here instead
 * of changing the shared memory-tool semantics used by ordinary chat turns.
 */
function bindToWorkerSpace(tool: ToolDef): ToolDef {
  return {
    ...tool,
    handler(input, context) {
      const spaceId = context.spaceId
      if (!spaceId) throw new Error('Worker memory tool requires an active Space')
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('Worker memory tool input must be an object')
      }
      if ('spaceId' in input && input.spaceId !== undefined && input.spaceId !== spaceId) {
        throw new Error('Worker memory tool cannot access a different Space')
      }
      return tool.handler({ ...input, spaceId }, context)
    },
  }
}
