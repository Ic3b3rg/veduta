import { formatPendingDecisionId, SYSTEM_SPACE_ID, type PendingDecision } from '@veduta/protocol'
import type { ToolDef, ToolResult } from './agent-runner.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createGlobalChatTools, type GlobalChatTurnHooks } from './global-chat-tools.ts'
import type { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import type { Scheduler } from './scheduler.ts'
import type { PendingDecisionService } from './pending-decision-service.ts'
import type { Store } from './store.ts'
import { createSystemChatTools } from './system-chat-tools.ts'
import { templateTools, type TemplateEngine } from './template-engine.ts'
import { inheritTrustWrapper, isTrustWrapped } from './trust-layer.ts'

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
  pendingDecisions: Pick<PendingDecisionService, 'get'>
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
        focusedToolsFor: (targetSpaceId) =>
          observePendingDecisionResults(
            focusedToolsFor(targetSpaceId),
            hooks,
            deps.pendingDecisions,
          ),
        ...(hooks === undefined ? {} : { hooks }),
      })
    }
    if (spaceId === SYSTEM_SPACE_ID) {
      return createSystemChatTools({ store: deps.store, scheduler: deps.scheduler })
    }
    return observePendingDecisionResults(focusedToolsFor(spaceId), hooks, deps.pendingDecisions)
  }
}

function observePendingDecisionResults(
  tools: ToolDef[],
  hooks: GlobalChatTurnHooks | undefined,
  decisions: Pick<PendingDecisionService, 'get'>,
): ToolDef[] {
  if (hooks?.onPendingDecision === undefined && hooks?.onPendingDecisionObserved === undefined) {
    return tools
  }
  return tools.map((tool) => {
    if (!isTrustWrapped(tool) && tool.name !== 'patch_tree') return tool
    const observed: ToolDef = {
      ...tool,
      async handler(input, context) {
        const result = await tool.handler(input, context)
        const decisionId = pendingDecisionId(tool, result)
        if (decisionId !== undefined) {
          let decision: PendingDecision | undefined
          try {
            decision = await decisions.get(decisionId)
          } catch (error) {
            safelyReportObservedDecision(hooks, decisionId)
            console.error('Pending decision projection failed', error)
            return result
          }
          if (decision === undefined) {
            safelyReportObservedDecision(hooks, decisionId)
            console.error(
              'Pending decision projection failed',
              new Error(`Pending decision is unavailable: ${decisionId}`),
            )
          } else {
            try {
              hooks.onPendingDecision?.(decision)
            } catch (error) {
              safelyReportObservedDecision(hooks, decisionId)
              console.error('Pending decision observer failed', error)
            }
          }
        }
        return result
      },
    }
    return inheritTrustWrapper(tool, observed)
  })
}

function safelyReportObservedDecision(hooks: GlobalChatTurnHooks, decisionId: string): void {
  try {
    hooks.onPendingDecisionObserved?.(decisionId)
  } catch (error) {
    console.error('Pending decision observer failed', error)
  }
}

function pendingDecisionId(tool: ToolDef, result: ToolResult): string | undefined {
  if (typeof result.details !== 'object' || result.details === null) return undefined
  const details = result.details as Record<string, unknown>
  if (tool.name === 'patch_tree') {
    const proposalId = details['proposalId']
    return typeof proposalId === 'number' && Number.isSafeInteger(proposalId) && proposalId > 0
      ? formatPendingDecisionId('tree-proposal', proposalId)
      : undefined
  }
  if (
    isTrustWrapped(tool) &&
    typeof details['effectId'] === 'string' &&
    typeof details['surfaceId'] === 'string'
  ) {
    return formatPendingDecisionId('approval', details['effectId'])
  }
  return undefined
}
