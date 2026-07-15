import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { Origin, TurnTaint } from './taint.ts'

export type ModelTier = 'triage' | 'reasoning'

export interface ModelRef {
  provider: string
  modelId: string
  tier: ModelTier
}

export function modelRefsEqual(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return (
    left?.provider === right?.provider &&
    left?.modelId === right?.modelId &&
    left?.tier === right?.tier
  )
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      content: string
      details: unknown
      isError: boolean
    }
  | {
      type: 'turn-end'
      sessionId: string
      model: ModelRef
      text: string
      /** Provider-reported cost when available; absent means unreported, not free. */
      costUsd?: number
      /** Provider-reported total token count when available; absent means unreported, not zero. */
      tokensUsed?: number
    }
  | { type: 'error'; message: string }

export type AgentEventHandler = (event: AgentEvent) => Promise<void> | void

/**
 * What caused this turn (D10/D12, issue #14): informational provenance for
 * the audit trail and approval cards. Never itself a trust-decision input —
 * only taint (`ToolContext.taint`) governs gating; a `trigger` just records
 * why the turn happened, for the humans and Surfaces reading the audit log.
 *
 * `parent` (immutable linked chain, SECURITY.md §5): the complete trigger
 * chain for the audit log. Today only single-hop triggers exist (a chat
 * message, an external event) so `parent` is always absent; the field
 * future-proofs a multi-hop chain (event -> automation -> turn) without a
 * schema change once the scheduler/automations can themselves trigger a
 * turn that triggers a tool call.
 */
export interface TriggerRef {
  kind: 'chat' | 'external-event' | 'automation' | 'agent-turn'
  id?: string
  source?: string
  summary?: string
  parent?: TriggerRef
}

export interface AgentPromptOptions {
  model?: ModelRef
  tools?: ToolDef[]
  contextPolicy?: ContextPolicy
  /**
   * True when this prompt retries a turn that just failed (model
   * failover): if the failed attempt already appended the user message
   * to the session, the runner must not append it again.
   */
  retryOfFailedTurn?: boolean
  /** Origin of the user input for this turn. Defaults to `'trusted:user'`. */
  origin?: Origin
  /**
   * Taint of out-of-band context assembled into this turn (e.g. the
   * Space log, from `SpacesEngine.contextOrigins`). Merged with `origin`
   * and session-message origins to compute the turn's effective origin
   * for tool gating (docs/SECURITY.md §3.2, ADR-0007).
   */
  contextOrigins?: Origin[]
  /** The Space this turn is scoped to, when known (threaded into `ToolContext.spaceId`). */
  spaceId?: string
  /** What caused this turn (threaded into `ToolContext.trigger`). */
  trigger?: TriggerRef
}

export interface AgentRunner {
  start(sessionId: string): Promise<void>
  /**
   * A failed turn always rejects — provider errors never resolve as
   * completed turns. Retries pass `retryOfFailedTurn` so the user
   * message is not appended to the session a second time.
   */
  prompt(input: string, options?: AgentPromptOptions): Promise<void>
  abort(): Promise<void> | void
  on(handler: AgentEventHandler): () => void
}

export interface ToolResult {
  content: string
  details?: unknown
  terminate?: boolean
  /**
   * Origins of stored content this result derives from (D10, issue #14):
   * read-side tools (`read_recent`, `search_log`) report the origin of
   * every event/fact they rendered. The runner folds these into the live
   * `ToolContext.taint` accumulator and persists them on the tool's
   * `SessionMessage.origins`, so a turn that starts trusted but reads
   * untrusted stored content is tainted for whatever it does next.
   */
  origins?: Origin[]
}

export interface ToolContext {
  toolCallId: string
  signal?: AbortSignal
  /**
   * The turn's effective origin (most-untrusted of the prompt's origin,
   * its context origins, and the session's message origins), fixed at
   * turn start. Tools that write Space state must stamp it onto whatever
   * they persist so taint cannot be laundered through a state write
   * (docs/SECURITY.md §3.2).
   */
  origin: Origin
  /** The origin chain the turn started with — the seed `origin` was derived from, before any mid-turn growth (D10). */
  origins: Origin[]
  /**
   * Live per-turn taint accumulator (D10/A1): starts seeded with `origins`
   * and grows as tool results report further provenance. Trust decisions
   * (issue #14) must read `taint.origins()` at execution time, never a
   * pre-turn snapshot — a trusted turn that reads untrusted content
   * partway through must still gate as tainted afterward.
   */
  taint: TurnTaint
  /** The Space this turn is scoped to, when known. */
  spaceId?: string
  /** What caused this turn — chat, an external event, an automation, or a follow-up agent turn. */
  trigger?: TriggerRef
  /**
   * sha256 of the canonical model-visible context envelope for the
   * immediately preceding model inference (BINDING amendment A3): proof of
   * exactly what crossed the runner's wrapper boundary before this tool
   * was called. See `computeContextHash`.
   */
  contextHash: string
  /** Set by the trust layer (issue #14) when this call executes as part of an approved/allowed effect; executors must be idempotent per `effectId`. */
  effectId?: string
}

export interface ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: TSchema
  /**
   * ADR-0007 trust level: `L0` runs free inside the daemon; `L1` requires
   * approval before an outbound effect; `L2` never runs automatically.
   * Required — `gateToolsForOrigins` fails closed on a missing level.
   */
  level: 'L0' | 'L1' | 'L2'
  /**
   * Network hosts this tool's handler may contact (ADR-0007, SECURITY.md
   * §3.4): declared here so the daemon can one day deny everything else at
   * the network layer — enforcement itself is issue #15, this field is
   * only the declaration. `L0` tools never leave the daemon and declare
   * `[]`.
   */
  egressDomains: readonly string[]
  handler(input: z.infer<TSchema>, context: ToolContext): Promise<ToolResult> | ToolResult
}

export function defineTool<TSchema extends z.ZodTypeAny>(tool: ToolDef<TSchema>): ToolDef<TSchema> {
  return tool
}

export type SessionMessageRole = 'user' | 'assistant' | 'tool'

export interface SessionMessage {
  role: SessionMessageRole
  content: string
  at: string
  model?: ModelRef
  toolCallId?: string
  toolName?: string
  details?: unknown
  isError?: boolean
  /** Absent means trusted (the pre-taint-tracking default). */
  origin?: Origin
  /**
   * Full provenance of a tool result (BINDING amendment A1): every origin
   * the tool's `ToolResult` reported, not only the most-untrusted mark
   * kept in `origin`. Absent for messages with no reported origins.
   */
  origins?: Origin[]
}

export type SessionEntry =
  | {
      id: string
      parentId: string | null
      at: string
      type: 'message'
      message: SessionMessage
    }
  | {
      id: string
      parentId: string | null
      at: string
      type: 'model-change'
      model: ModelRef
    }
  | {
      id: string
      parentId: string | null
      at: string
      type: 'compaction'
      summary: string
      firstKeptEntryId?: string
      details?: unknown
    }

export type SessionAppend =
  | {
      parentId?: string | null
      at?: string
      type: 'message'
      message: Omit<SessionMessage, 'at'> & { at?: string }
    }
  | {
      parentId?: string | null
      at?: string
      type: 'model-change'
      model: ModelRef
    }
  | {
      parentId?: string | null
      at?: string
      type: 'compaction'
      summary: string
      firstKeptEntryId?: string
      details?: unknown
    }

export interface SessionBranch {
  sessionId: string
  entries: SessionEntry[]
  messages: SessionMessage[]
  model?: ModelRef
}

export interface SessionStore {
  append(sessionId: string, entry: SessionAppend): Promise<SessionEntry>
  load(sessionId: string): Promise<SessionBranch>
  branch(
    sessionId: string,
    options?: { fromEntryId?: string; newSessionId?: string },
  ): Promise<SessionBranch>
}

export interface ContextPolicy {
  enabled: boolean
  transform(
    messages: SessionMessage[],
    context: ContextPolicyContext,
  ): Promise<SessionMessage[]> | SessionMessage[]
}

export interface ContextPolicyContext {
  sessionId: string
  signal?: AbortSignal
}

export const disabledContextPolicy: ContextPolicy = {
  enabled: false,
  transform: (messages) => messages,
}

/**
 * Canonical envelope hash (BINDING amendment A3, docs/SECURITY.md §5): sha256
 * over a key-sorted JSON encoding of `envelope`, so the hash depends only on
 * the envelope's content, never on incidental object-key insertion order.
 * Runners build `envelope` from exactly what crossed their wrapper boundary
 * into the model for one inference (system prompt, transformed messages,
 * user input) and store the result as `ToolContext.contextHash`.
 */
export function computeContextHash(envelope: unknown): string {
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    )
  }
  return value
}

export class AgentEventBus {
  private readonly handlers = new Set<AgentEventHandler>()

  on(handler: AgentEventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event)
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>()

  async append(sessionId: string, append: SessionAppend): Promise<SessionEntry> {
    const session = this.ensureSession(sessionId)
    const at = append.at ?? new Date().toISOString()
    const parentId = append.parentId === undefined ? session.leafId : append.parentId
    const entry = createSessionEntry(createSessionEntryId(), parentId, at, append)
    session.entries.push(entry)
    session.leafId = entry.id
    return entry
  }

  async load(sessionId: string): Promise<SessionBranch> {
    const session = this.sessions.get(sessionId)
    return session
      ? buildSessionBranch(sessionId, session.entries)
      : buildSessionBranch(sessionId, [])
  }

  async branch(
    sessionId: string,
    options: { fromEntryId?: string; newSessionId?: string } = {},
  ): Promise<SessionBranch> {
    const source = await this.load(sessionId)
    const entries = options.fromEntryId
      ? entriesThrough(source.entries, options.fromEntryId)
      : source.entries
    const newSessionId = options.newSessionId ?? createSessionBranchId(sessionId)
    this.sessions.set(newSessionId, {
      entries: entries.map((entry) => structuredClone(entry)),
      leafId: entries.at(-1)?.id ?? null,
    })
    return this.load(newSessionId)
  }

  private ensureSession(sessionId: string): StoredSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const created = { entries: [], leafId: null }
    this.sessions.set(sessionId, created)
    return created
  }
}

interface StoredSession {
  entries: SessionEntry[]
  leafId: string | null
}

function createSessionEntry(
  id: string,
  parentId: string | null,
  at: string,
  append: SessionAppend,
): SessionEntry {
  if (append.type === 'message') {
    return {
      id,
      parentId,
      at,
      type: 'message',
      message: { ...append.message, at: append.message.at ?? at },
    }
  }
  if (append.type === 'model-change') {
    return { id, parentId, at, type: 'model-change', model: append.model }
  }
  const entry: SessionEntry = {
    id,
    parentId,
    at,
    type: 'compaction',
    summary: append.summary,
  }
  return {
    ...entry,
    ...(append.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: append.firstKeptEntryId }),
    ...(append.details === undefined ? {} : { details: append.details }),
  }
}

export function buildSessionBranch(sessionId: string, entries: SessionEntry[]): SessionBranch {
  const messages = entries.flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
  const model = findLastModel(entries)
  const branch = {
    sessionId,
    entries: entries.map((entry) => structuredClone(entry)),
    messages,
  }
  return model ? { ...branch, model } : branch
}

function entriesThrough(entries: SessionEntry[], entryId: string): SessionEntry[] {
  const index = entries.findIndex((entry) => entry.id === entryId)
  if (index === -1) throw new Error(`unknown session entry: ${entryId}`)
  return entries.slice(0, index + 1)
}

let nextEntryId = 0

function createSessionEntryId(): string {
  nextEntryId += 1
  return `entry-${nextEntryId}`
}

function createSessionBranchId(sessionId: string): string {
  return `${sessionId}-branch-${Date.now()}`
}

function findLastModel(entries: SessionEntry[]): ModelRef | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type === 'model-change') return entry.model
  }
  return undefined
}
