import { z } from 'zod'
import { JsonObjectSchema } from '@veduta/protocol'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { MemoryRetrieval } from './memory-retrieval.ts'
import { renderEventForContext, type SpaceEvent, type SpacesEngine } from './spaces-engine.ts'
import { effectiveToolWriteOrigin, type Origin } from './taint.ts'

export interface MemoryToolOptions {
  activeSpaceId?: string
  /**
   * Enables `search_memory` (issues/021-advanced-memory.md,
   * issues/032-facts-hygiene-context-budget.md) when supplied. Optional so
   * existing callers that construct `createMemoryTools` with no retrieval
   * instance keep getting exactly the four tools they always have —
   * `search_memory` needs a live `MemoryIndex` behind it and must not become
   * a hard dependency of every caller of this module.
   */
  retrieval?: MemoryRetrieval
}

const SpaceScopedSchema = z.object({
  spaceId: z.string().min(1).optional(),
})

/**
 * Cap on one written fact, matching the cap the nightly Reflection already
 * applies to a distilled fact. Without it, a single write just under the `low`
 * watermark leaves the next Reflection no way to fit the projection except by
 * demoting everything else — the user's own facts go dormant first, because
 * demotion ranks oldest-noted first, and the injected set empties out. Nothing
 * is destroyed (the records stay in `## Dormant` and every demotion is logged)
 * but the Agent stops seeing them, and an injected turn can trigger it. The
 * `hard` watermark that would also refuse the write belongs to
 * issues/032-facts-hygiene-context-budget.md; this cap is what keeps the gap
 * from being exploitable in the meantime.
 */
export const MAX_WRITTEN_FACT_CHARS = 1000

/**
 * Event types the daemon reserves for its own bookkeeping. An Agent tool must
 * not be able to mint one, because the daemon reads several of these back as
 * state, and a forged entry would let untrusted content steer it through its
 * own log (docs/SECURITY.md §3.2) — the same reasoning that stops
 * `toolWriteOrigin` from ever stamping `trusted:user` on a tool write.
 *
 * The invariant to preserve when adding a reader: **any event type the daemon
 * interprets as its own state must be covered here.** Today that is
 * `reflection.done`/`reflection.skip` (whether the nightly Reflection ever runs
 * again), `worker.delivered` (whether a Worker's result was already handed
 * over — a forged one makes boot recovery drop a real result), `reader.summary`
 * /`reader.discard` (whether a quarantined event was handled),
 * `approval.outcome`, `outbound.delivery`, `heartbeat.sweep` (the metrics
 * the Heartbeat Surface shows), and `template.saved`/`template.reused`/
 * `template.regenerated` (issues/022-emergent-templates.md: the daemon reads
 * its own Template bookkeeping back — a forged `template.saved` could make a
 * harvest or a reuse look like it already happened). A denylist rather than
 * an allowlist because naming its own event types is the point of
 * `append_event`; what must be closed off is the daemon's own namespace.
 */
const RESERVED_EVENT_TYPE_PREFIXES = [
  'reflection.',
  'fact.',
  'reader.',
  'automation.',
  'outbound.',
  'approval.',
  'ingestion.',
  'surface.',
  'heartbeat.',
  'worker.',
  'import.',
  'template.',
]
const RESERVED_EVENT_TYPES = ['lifecycle']

function isReservedEventType(type: string): boolean {
  const normalized = type.trim().toLowerCase()
  return (
    RESERVED_EVENT_TYPES.includes(normalized) ||
    RESERVED_EVENT_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}

const WriteFactSchema = SpaceScopedSchema.extend({
  fact: z.string().trim().min(1).max(MAX_WRITTEN_FACT_CHARS),
  supersedes: z.string().trim().min(1).max(MAX_WRITTEN_FACT_CHARS).optional(),
})

const AppendEventSchema = SpaceScopedSchema.extend({
  text: z.string().trim().min(1),
  type: z
    .string()
    .trim()
    .min(1)
    .max(64)
    // The renderer reduces a type to this shape anyway
    // (`renderEventForContext`, `spaces-engine.ts`), because it is the one
    // attacker-reachable field that renders outside the untrusted block.
    // Rejecting the write is better than silently rewriting it.
    .regex(
      /^[A-Za-z0-9._-]+$/,
      'event type may contain only letters, digits, dot, underscore, dash',
    )
    .refine((type) => !isReservedEventType(type), {
      message: 'event type is reserved for the daemon',
    })
    .optional(),
  payload: JsonObjectSchema.optional(),
})

const ReadRecentSchema = SpaceScopedSchema.extend({
  limit: z.number().int().positive().max(100).default(20),
})

const SearchLogSchema = SpaceScopedSchema.extend({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(100).default(20),
})

/**
 * `search_memory`'s inputs (issues/021-advanced-memory.md's retrieval
 * interface, issues/032-facts-hygiene-context-budget.md's `search_facts`
 * criterion): one tool over one index rather than two. A separate
 * `search_facts` tool would either duplicate this schema and handler or
 * re-implement the same dereference-and-taint pipeline against the same
 * `MemoryIndex` — `kind: 'event' | 'fact'` is the one filter both specs
 * actually need, so it lives here instead of forking the tool surface.
 */
const SearchMemorySchema = SpaceScopedSchema.extend({
  // Bounded because temporal extraction is linear in the query's length and
  // resolves each month name it finds through several timezone conversions,
  // all synchronously on the daemon's single thread: an unbounded query is a
  // cheap way to stall the whole Gateway.
  query: z.string().trim().min(1).max(500),
  kind: z.enum(['event', 'fact']).optional(),
  limit: z.number().int().positive().max(50).default(10),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  order: z.enum(['relevance', 'recency']).optional(),
  /**
   * Which clock to filter and sort on: `effective` (the default) prefers an
   * event's `occurredAt` — when the thing happened — and falls back to when it
   * was recorded; `recorded` always uses the recording time. Exposed because
   * the distinction is one of this issue's requirements, and a caller asking
   * "what did I weigh in June" means the weighing, not the logging.
   */
  timeBasis: z.enum(['effective', 'recorded']).optional(),
})

export function createMemoryTools(
  engine: SpacesEngine,
  options: MemoryToolOptions = {},
): ToolDef[] {
  const retrieval = options.retrieval
  return [
    defineTool({
      name: 'write_fact',
      description:
        'Write one durable FACTS entry for the active Space. The Curator supersedes only established contradictions. For a refinement, pass supersedes with the exact active fact text this write replaces.',
      schema: WriteFactSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const result = engine.writeFact(
          spaceId,
          input.fact,
          effectiveToolWriteOrigin(context.taint.origins(), context.origin),
          input.supersedes === undefined ? undefined : { supersedes: input.supersedes },
        )
        return {
          content: `FACTS ${result.operation}: ${result.fact.text}`,
          details: result,
        }
      },
    }),
    defineTool({
      name: 'append_event',
      description:
        'Append one event to the active Space Event log only. This does not change any Surface or visible Surface state; use the Surface tools for that.',
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
          origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        })
        return {
          content: `Event appended to the Event log only; no Surface was changed: ${event.text}`,
          details: event,
        }
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
    ...(retrieval === undefined
      ? []
      : [
          defineTool({
            name: 'search_memory',
            description:
              "Search this Space's indexed Event log and FACTS (active, dormant, and superseded) by keyword, with time-aware date-range extraction from the query (e.g. 'start of June'). Use kind to scope to events or facts only.",
            schema: SearchMemorySchema,
            level: 'L0',
            egressDomains: [],
            handler(input) {
              const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
              const outcome = retrieval.search({
                spaceId,
                query: input.query,
                limit: input.limit,
                ...(input.kind === undefined ? {} : { kind: input.kind }),
                ...(input.from === undefined ? {} : { from: input.from }),
                ...(input.to === undefined ? {} : { to: input.to }),
                ...(input.order === undefined ? {} : { order: input.order }),
                ...(input.timeBasis === undefined ? {} : { timeBasis: input.timeBasis }),
              })
              return {
                content: retrieval.renderOutcome(outcome),
                details: outcome,
                // Every hit's own origin (never the query's), so a turn that
                // starts trusted but retrieves an untrusted fact or event
                // through this tool is tainted for whatever it does next —
                // the same mechanism `read_recent`/`search_log` already use
                // (see `eventOrigins` below), just fed from `MemoryHit.origins`
                // instead of a list of `SpaceEvent`s.
                origins: outcome.hits.flatMap((hit) => hit.origins),
              }
            },
          }),
        ]),
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
 * of every event rendered, the runner folds them into the turn's live
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

/** Every origin of the rendered events, for `ToolResult.origins`. */
function eventOrigins(events: SpaceEvent[]): Origin[] {
  return events.map((event) => event.origin)
}
