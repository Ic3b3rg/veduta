import { z } from 'zod'
import {
  formatPendingDecisionId,
  type ChatResultTarget,
  type PendingDecision,
  type Space,
} from '@veduta/protocol'
import { defineTool, type ToolContext, type ToolDef, type ToolResult } from './agent-runner.ts'
import { SpacePendingDecisionAdapter } from './space-pending-decision.ts'
import type { Store } from './store.ts'
import { effectiveToolWriteOrigin } from './taint.ts'
import { inheritTrustWrapper } from './trust-layer.ts'

const GlobalSpaceTargetSchema = z.object({
  /** An active Space id or slug from the bounded roster in the global prompt. */
  spaceId: z.string().trim().min(1),
})

const EnterSpaceSchema = GlobalSpaceTargetSchema
const ProposeSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
})

const SCHEMA_SPACE_ID = '__global-chat-schema__'

export interface GlobalChatTurnHooks {
  onSpaceEntered?: (space: Space) => void
  onResultTarget?: (target: ChatResultTarget) => void
  onPendingDecision?: (decision: PendingDecision) => void
}

export interface GlobalChatToolsOptions {
  store: Store
  focusedToolsFor: (spaceId: string) => ToolDef[]
  hooks?: GlobalChatTurnHooks
}

/**
 * Builds one per-turn global registry over the canonical focused handlers.
 * Tool names are identical to the focused registry; only their schemas add a
 * required target and their handlers resolve that target into ToolContext.
 */
export function createGlobalChatTools(options: GlobalChatToolsOptions): ToolDef[] {
  const enteredSpaceIds = new Set<string>()
  const schemaTools = options.focusedToolsFor(SCHEMA_SPACE_ID)

  return [
    defineTool({
      name: 'enter_space',
      description:
        "Enter one active Space by id or slug for this turn. Returns that Space's normal bounded assembled context and all of its origins. Call this before any other tool targeting the Space.",
      schema: EnterSpaceSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        const space = resolveActiveSpace(options.store, input.spaceId)
        const content = options.store.assembleSpaceContext(space.id)
        const origins = options.store.spacesEngine.contextOrigins(space.id)
        if (!enteredSpaceIds.has(space.id)) {
          options.hooks?.onSpaceEntered?.(space)
          enteredSpaceIds.add(space.id)
        }
        options.hooks?.onResultTarget?.(spaceTarget(space))
        recordToolOutcome(options.store, space.id, 'enter_space', context, 'completed', false)
        return { content, details: { space }, origins }
      },
    }),
    defineTool({
      name: 'propose_space',
      description:
        'Create a pending one-tap Space proposal when no active Space fits. This never creates the Space or any Surface; only the user can accept it.',
      schema: ProposeSpaceSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const proposal = options.store.spacesEngine.proposeSpace(input)
        const decision = new SpacePendingDecisionAdapter(options.store.spacesEngine).get(
          formatPendingDecisionId('space-proposal', proposal.id),
        )
        if (!decision) throw new Error(`pending Space proposal is unavailable: ${proposal.id}`)
        options.hooks?.onPendingDecision?.(decision)
        return {
          content: `proposed Space "${proposal.name}" for user confirmation (${proposal.id})`,
          details: { proposal, decision },
        }
      },
    }),
    ...schemaTools.map((tool) => scopeFocusedTool(tool, options, enteredSpaceIds)),
  ]
}

function scopeFocusedTool(
  schemaTool: ToolDef,
  options: GlobalChatToolsOptions,
  enteredSpaceIds: Set<string>,
): ToolDef {
  const scoped = defineTool({
    name: schemaTool.name,
    description: `${schemaTool.description} In global chat, spaceId is a required active Space id or slug and enter_space must succeed first.`,
    schema: schemaTool.schema.and(GlobalSpaceTargetSchema),
    level: schemaTool.level,
    egressDomains: schemaTool.egressDomains,
    async handler(input, context) {
      const space = resolveActiveSpace(options.store, input.spaceId)
      if (!enteredSpaceIds.has(space.id)) {
        throw new Error(
          `Space "${space.slug}" has not been entered during this turn; call enter_space first`,
        )
      }

      const targetTool = toolNamed(options.focusedToolsFor(space.id), schemaTool.name)
      const correlationId = requireCorrelationId(context)
      try {
        const result = await options.store.spacesEngine.withEventCorrelation(correlationId, () =>
          targetTool.handler(withoutSpaceTarget(input), {
            ...context,
            spaceId: space.id,
          }),
        )
        const target = resultTarget(options.store, space, schemaTool.name, input, result)
        options.hooks?.onResultTarget?.(target)
        recordToolOutcome(
          options.store,
          space.id,
          schemaTool.name,
          context,
          'completed',
          MUTATING_TOOL_NAMES.has(schemaTool.name),
          target.surfaceId,
        )
        return result
      } catch (error) {
        recordToolOutcome(
          options.store,
          space.id,
          schemaTool.name,
          context,
          'failed',
          MUTATING_TOOL_NAMES.has(schemaTool.name),
        )
        throw error
      }
    },
  })
  return inheritTrustWrapper(schemaTool, scoped)
}

const MUTATING_TOOL_NAMES = new Set([
  'send_message',
  'transfer_funds',
  'create_surface',
  'patch_state',
  'patch_tree',
  'archive_surface',
  'write_fact',
  'append_event',
  'create_surface_from_template',
  'pin_surface',
  'arm_timer',
  'create_job',
  'set_automation_enabled',
  'cancel',
  'spawn_worker',
])

function recordToolOutcome(
  store: Store,
  spaceId: string,
  toolName: string,
  context: ToolContext,
  outcome: 'completed' | 'failed',
  mutation: boolean,
  surfaceId?: string,
): void {
  const correlationId = requireCorrelationId(context)
  store.spacesEngine.appendEvent(spaceId, {
    type: 'turn.tool',
    text: `Global turn tool ${toolName} ${outcome}`,
    origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
    payload: {
      correlationId,
      toolCallId: context.toolCallId,
      toolName,
      outcome,
      mutation,
      ...(surfaceId === undefined ? {} : { surfaceId }),
    },
  })
}

function requireCorrelationId(context: ToolContext): string {
  const correlationId = context.initiatingTurn?.turnId
  if (!correlationId) throw new Error('global chat tool requires a turn correlation id')
  return correlationId
}

function resolveActiveSpace(store: Store, target: string): Space {
  const space = store.spacesEngine
    .listAllSpaces()
    .find((candidate) => candidate.id === target || candidate.slug === target)
  if (!space) throw new Error(`unknown Space id or slug: ${target}`)
  if (space.archived) throw new Error(`archived Space cannot be entered: ${target}`)
  return space
}

function withoutSpaceTarget(input: Record<string, unknown>): Record<string, unknown> {
  const { spaceId: _spaceId, ...rest } = input
  return rest
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`global chat registry is missing focused tool "${name}"`)
  return tool
}

function spaceTarget(space: Space): ChatResultTarget {
  return { spaceId: space.id, spaceSlug: space.slug, spaceName: space.name }
}

function resultTarget(
  store: Store,
  space: Space,
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ChatResultTarget {
  const surfaceId = surfaceIdFrom(toolName, input, result.details)
  const surface = surfaceId === undefined ? undefined : store.getSurface(surfaceId)
  return surface === undefined || surface.spaceId !== space.id
    ? spaceTarget(space)
    : {
        ...spaceTarget(space),
        surfaceId: surface.id,
        surfaceTitle: surface.title,
      }
}

function surfaceIdFrom(
  toolName: string,
  input: Record<string, unknown>,
  details: unknown,
): string | undefined {
  const surface = surfaceFromResult(details)
  if (surface) return surface.id
  if (!SURFACE_TARGET_TOOL_NAMES.has(toolName)) return undefined
  const surfaceId = input['surfaceId'] ?? input['id']
  return typeof surfaceId === 'string' ? surfaceId : undefined
}

const SURFACE_TARGET_TOOL_NAMES = new Set([
  'read_surface',
  'create_surface',
  'patch_state',
  'patch_tree',
  'archive_surface',
  'create_surface_from_template',
  'pin_surface',
])

function surfaceFromResult(value: unknown): { id: string; title: string } | undefined {
  if (!isRecord(value)) return undefined
  const candidate = isRecord(value['surface']) ? value['surface'] : undefined
  return candidate && typeof candidate['id'] === 'string' && typeof candidate['title'] === 'string'
    ? { id: candidate['id'], title: candidate['title'] }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
