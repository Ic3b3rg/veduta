import { z } from 'zod'
import { JsonObjectSchema } from '@veduta/protocol'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { renderEventForContext, type SpaceEvent, type SpacesEngine } from './spaces-engine.ts'
import { toolWriteOrigin, type Origin } from './taint.ts'

export interface MemoryToolOptions {
  activeSpaceId?: string
}

const SpaceScopedSchema = z.object({
  spaceId: z.string().min(1).optional(),
})

const WriteFactSchema = SpaceScopedSchema.extend({
  fact: z.string().trim().min(1),
})

const AppendEventSchema = SpaceScopedSchema.extend({
  text: z.string().trim().min(1),
  type: z.string().trim().min(1).optional(),
  payload: JsonObjectSchema.optional(),
})

const ReadRecentSchema = SpaceScopedSchema.extend({
  limit: z.number().int().positive().max(100).default(20),
})

const SearchLogSchema = SpaceScopedSchema.extend({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(100).default(20),
})

export function createMemoryTools(
  engine: SpacesEngine,
  options: MemoryToolOptions = {},
): ToolDef[] {
  return [
    defineTool({
      name: 'write_fact',
      description:
        'Write one durable FACTS entry for the active Space. The Curator decides Add, Update, Supersede, or Noop.',
      schema: WriteFactSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const result = engine.writeFact(spaceId, input.fact, toolWriteOrigin(context.origin))
        return {
          content: `FACTS ${result.operation}: ${result.fact.text}`,
          details: result,
        }
      },
    }),
    defineTool({
      name: 'append_event',
      description: 'Append one event to the active Space Event log.',
      schema: AppendEventSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const event = engine.appendEvent(spaceId, {
          text: input.text,
          type: input.type ?? 'turn',
          // Never `trusted:user`: an agent tool write must not be able to
          // satisfy scheduler conditions reserved for genuine user events.
          origin: toolWriteOrigin(context.origin),
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        })
        return { content: event.text, details: event }
      },
    }),
    defineTool({
      name: 'read_recent',
      description: 'Read recent entries from the active Space Event log.',
      schema: ReadRecentSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const events = engine.readRecent(spaceId, input.limit)
        return { content: formatEvents(events), details: { events }, origins: eventOrigins(events) }
      },
    }),
    defineTool({
      name: 'search_log',
      description: 'Search the active Space Event log for matching text.',
      schema: SearchLogSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const events = engine.searchLog(spaceId, input.query, input.limit)
        return { content: formatEvents(events), details: { events }, origins: eventOrigins(events) }
      },
    }),
  ]
}

function resolveSpaceId(
  inputSpaceId: string | undefined,
  activeSpaceId: string | undefined,
): string {
  const spaceId = inputSpaceId ?? activeSpaceId
  if (!spaceId) throw new Error('active Space is required for this memory tool')
  return spaceId
}

/**
 * Tool results enter the turn's context too: read-side tools render events
 * through the same taint-aware renderer as `assembleContext`, so untrusted
 * text pulled up via `read_recent`/`search_log` still arrives origin-marked
 * and inside delimiters — and, since `ToolResult.origins` reports the origin
 * of every event rendered (D10), the runner folds them into the turn's live
 * `taint` accumulator too. That closes what used to be a runtime re-gating
 * gap here: a turn that starts trusted but reads an untrusted event through
 * one of these tools is tainted, from that point on, for whatever it does
 * next — read at execution time via `ToolContext.taint`, not a pre-turn
 * snapshot.
 */
function formatEvents(events: SpaceEvent[]): string {
  if (events.length === 0) return 'No matching Event log entries.'
  return events.map(renderEventForContext).join('\n')
}

/** Every origin of the rendered events (D10), for `ToolResult.origins`. */
function eventOrigins(events: SpaceEvent[]): Origin[] {
  return events.map((event) => event.origin)
}
