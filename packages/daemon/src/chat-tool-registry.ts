import type { ToolDef } from './agent-runner.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import type { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import { templateTools, type TemplateEngine } from './template-engine.ts'

/**
 * Everything `chatToolRegistry` (issue #37) needs to build a Space's chat
 * tool set, narrowed to exactly what `server.ts` has in scope by the time it
 * constructs the chat loop — one instance per daemon, never per turn.
 */
export interface ChatToolRegistryDeps {
  store: Store
  wrappedOutboundTools: ToolDef[]
  memoryRetrieval: MemoryRetrieval
  templateEngine: TemplateEngine
  scheduler: Scheduler
  spawnWorkerTool: ToolDef
}

/**
 * Builds the chat tool registry (issue #37, exact set per the issue spec):
 * every Space chat turn gets the trust-wrapped outbound tools, Surface tools
 * (`create_surface` gated behind the Template-reuse justification check),
 * memory tools (`search_memory` included since a `MemoryRetrieval` is always
 * supplied), Template-reuse tools, Space-bound Automation tools, and `spawn_worker`. The
 * global chat (no active Space) gets none of them — issue #37 deliberately
 * scopes it to conversation only, since there is no Space to read or write.
 *
 * Extracted into its own module so `server.ts`'s construction and
 * `tool-parameters.test.ts`'s registry-shape assertions build the exact same
 * tool set through one function, instead of a hand-duplicated list in the
 * test drifting out of sync with what the daemon actually wires up.
 */
export function chatToolRegistry(
  deps: ChatToolRegistryDeps,
): (spaceId: string | undefined) => ToolDef[] {
  return (spaceId) => {
    if (spaceId === undefined) return []
    const surfaceTools = createFocusedSurfaceTools({
      store: deps.store,
      templateEngine: deps.templateEngine,
      spaceId,
    })
    return [
      ...deps.wrappedOutboundTools,
      ...surfaceTools,
      ...createMemoryTools(deps.store.spacesEngine, {
        activeSpaceId: spaceId,
        retrieval: deps.memoryRetrieval,
      }),
      ...templateTools(deps.templateEngine, { activeSpaceId: spaceId }),
      ...createFocusedAutomationTools({ scheduler: deps.scheduler, spaceId }),
      deps.spawnWorkerTool,
    ]
  }
}
