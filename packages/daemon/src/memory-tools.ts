import { z } from 'zod'
import { JsonObjectSchema } from '@veduta/protocol'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { SpacesEngine } from './spaces-engine.ts'

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
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const result = engine.writeFact(spaceId, input.fact)
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
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const event = engine.appendEvent(spaceId, {
          text: input.text,
          type: input.type ?? 'turn',
          origin: 'trusted:system',
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        })
        return { content: event.text, details: event }
      },
    }),
    defineTool({
      name: 'read_recent',
      description: 'Read recent entries from the active Space Event log.',
      schema: ReadRecentSchema,
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const events = engine.readRecent(spaceId, input.limit)
        return { content: formatEvents(events), details: { events } }
      },
    }),
    defineTool({
      name: 'search_log',
      description: 'Search the active Space Event log for matching text.',
      schema: SearchLogSchema,
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const events = engine.searchLog(spaceId, input.query, input.limit)
        return { content: formatEvents(events), details: { events } }
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

function formatEvents(events: { at: string; type: string; text: string }[]): string {
  if (events.length === 0) return 'No matching Event log entries.'
  return events.map((event) => `${event.at} [${event.type}] ${event.text}`).join('\n')
}
