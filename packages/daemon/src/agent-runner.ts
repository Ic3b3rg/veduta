import type { z } from 'zod'

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
    }
  | { type: 'error'; message: string }

export type AgentEventHandler = (event: AgentEvent) => Promise<void> | void

export interface AgentPromptOptions {
  model?: ModelRef
  tools?: ToolDef[]
  contextPolicy?: ContextPolicy
  /**
   * True when this prompt retries a turn that just failed (model
   * failover): the user message is already in the session and must
   * not be appended again.
   */
  retryOfFailedTurn?: boolean
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
}

export interface ToolContext {
  toolCallId: string
  signal?: AbortSignal
}

export interface ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  schema: TSchema
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
