import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import type { ToolDef } from './agent-runner.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createGlobalChatTools, type GlobalChatTurnHooks } from './global-chat-tools.ts'
import type { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import { createSystemChatTools } from './system-chat-tools.ts'
import { templateTools, type TemplateEngine } from './template-engine.ts'

/**
 * Everything `chatToolRegistry` needs to build focused and scoped-global
 * chat tool sets, narrowed to exactly what `server.ts` has in scope by the
 * time it constructs the chat loop — one instance per daemon, never per turn.
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
 * Builds the canonical focused registry, the Gateway-owned System registry,
 * plus issue #136's scoped global form:
 * every user life-area Space chat turn gets the trust-wrapped outbound tools, Surface tools
 * (`create_surface` gated behind the Template-reuse justification check),
 * memory tools (`search_memory` included since a `MemoryRetrieval` is always
 * supplied), Template-reuse tools, Space-bound Automation tools, and `spawn_worker`.
 * Global chat receives adapters over those same handlers, with an explicit
 * active-Space target and a successful `enter_space` required first. A
 * System-scoped turn receives only its explicitly assembled status registry.
 *
 * Extracted into its own module so `server.ts`'s construction and
 * `tool-parameters.test.ts`'s registry-shape assertions build the exact same
 * tool set through one function, instead of a hand-duplicated list in the
 * test drifting out of sync with what the daemon actually wires up.
 */
export function chatToolRegistry(
  deps: ChatToolRegistryDeps,
): (spaceId: string | undefined, hooks?: GlobalChatTurnHooks) => ToolDef[] {
  const focusedToolsFor = (spaceId: string): ToolDef[] => {
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

  return (spaceId, hooks) => {
    if (spaceId === undefined) {
      return createGlobalChatTools({
        store: deps.store,
        focusedToolsFor,
        ...(hooks === undefined ? {} : { hooks }),
      })
    }
    if (spaceId === SYSTEM_SPACE_ID) {
      return createSystemChatTools({ store: deps.store, scheduler: deps.scheduler })
    }
    return focusedToolsFor(spaceId)
  }
}
