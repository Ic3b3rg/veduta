import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ChatMessageSchema,
  PendingDecisionSchema,
  PENDING_DECISION_FALLBACK_FEEDBACK,
  pendingDecisionFeedback,
  type ChatAcceptance,
  type ChatMessage,
  type ChatScope,
  type ChatTimelineEntry,
  type ChatTimelinePage,
  type ChatTurnState,
  type PendingDecision,
} from '@veduta/protocol'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'

export type ChatTimelineKind = 'user' | 'assistant' | 'error' | 'decision' | 'connection'

export class ChatTimelineError extends Error {
  constructor(
    readonly code: 'submission_conflict' | 'scope_capacity' | 'invalid_retry' | 'invalid_cursor',
    message: string,
  ) {
    super(message)
  }
}

/** Durable user-visible Chat state, separate from Agent sessions and Space Events. */
export class ChatTimeline {
  private readonly db: DatabaseSync
  private readonly now: () => Date

  constructor(rootDir: string, now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(join(rootDir, 'chat.sqlite'))
    this.now = now
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = full;
      pragma foreign_keys = on;
      create table if not exists chat_scope_positions (
        scope_key text primary key,
        next_position integer not null
      );
      create table if not exists chat_turns (
        id text primary key,
        submission_id text not null unique,
        scope_key text not null,
        text text not null,
        state text not null check (state in ('accepted', 'running', 'waiting_connection', 'completed', 'failed', 'interrupted')),
        retry_of text,
        user_entry_id text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists chat_turns_by_scope_state
        on chat_turns (scope_key, state, created_at);
      create table if not exists chat_entries (
        id text primary key,
        scope_key text not null,
        position integer not null,
        turn_id text not null references chat_turns(id),
        kind text not null check (kind in ('user', 'assistant', 'error', 'decision', 'connection')),
        decision_id text unique,
        connection_attempt_id text,
        revision integer not null default 1,
        message_json text not null,
        created_at text not null,
        updated_at text not null,
        unique (scope_key, position)
      );
      create index if not exists chat_entries_page
        on chat_entries (scope_key, position desc);
      create unique index if not exists chat_entries_terminal
        on chat_entries (turn_id, kind) where kind in ('assistant', 'error');
      create table if not exists chat_service_requests (
        turn_id text primary key references chat_turns(id),
        resolution_json text not null
      );
      create table if not exists chat_decision_revisions (
        decision_id text primary key references chat_entries(decision_id),
        source_revision integer not null
      );
    `)
  }

  serviceRequest(turnId: string): unknown {
    const row = this.db
      .prepare('select resolution_json from chat_service_requests where turn_id = ?')
      .get(turnId)
    return row ? JSON.parse(requiredString(row, 'resolution_json')) : undefined
  }

  recordServiceRequest(turnId: string, resolution: unknown): void {
    this.db
      .prepare(
        'insert into chat_service_requests (turn_id, resolution_json) values (?, ?) on conflict(turn_id) do nothing',
      )
      .run(turnId, JSON.stringify(resolution))
  }

  close(): void {
    this.db.close()
  }

  accept(input: {
    submissionId: string
    scope: ChatScope
    text: string
    retryOf?: string
  }): ChatAcceptance {
    const key = scopeKey(input.scope)
    if (!input.submissionId || !input.text.trim()) throw new Error('invalid Chat submission')
    return withImmediateTransaction(this.db, () => {
      const existing = this.db
        .prepare('select * from chat_turns where submission_id = ?')
        .get(input.submissionId)
      if (existing) {
        if (
          requiredString(existing, 'scope_key') !== key ||
          requiredString(existing, 'text') !== input.text ||
          optionalString(existing, 'retry_of') !== input.retryOf
        )
          throw new ChatTimelineError('submission_conflict', 'Chat submission identity was reused')
        return acceptanceFromRow(existing)
      }
      if (input.retryOf !== undefined) {
        const source = this.db.prepare('select * from chat_turns where id = ?').get(input.retryOf)
        if (
          !source ||
          requiredString(source, 'scope_key') !== key ||
          requiredString(source, 'state') !== 'interrupted' ||
          requiredString(source, 'text') !== input.text
        )
          throw new ChatTimelineError(
            'invalid_retry',
            'Only an interrupted Chat turn can be retried',
          )
      }
      const inFlight = this.db
        .prepare(
          "select count(*) as count from chat_turns where scope_key = ? and state in ('accepted', 'running', 'waiting_connection')",
        )
        .get(key)
      if (inFlight && requiredNumber(inFlight, 'count') >= 8)
        throw new ChatTimelineError('scope_capacity', 'This Chat scope has eight pending turns')
      const id = `cht-${randomUUID()}`
      const entryId = `cte-${randomUUID()}`
      const at = this.now().toISOString()
      this.db
        .prepare(
          `insert into chat_turns
             (id, submission_id, scope_key, text, state, retry_of, user_entry_id, created_at, updated_at)
           values (?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
        )
        .run(id, input.submissionId, key, input.text, input.retryOf ?? null, entryId, at, at)
      this.insertEntry({
        id: entryId,
        scopeKey: key,
        turnId: id,
        kind: 'user',
        message: { role: 'user', text: input.text },
        at,
      })
      return {
        submissionId: input.submissionId,
        turnId: id,
        entryId,
        scope: input.scope,
        state: 'accepted',
        ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
      }
    })
  }

  begin(turnId: string): boolean {
    return withImmediateTransaction(this.db, () => {
      const at = this.now().toISOString()
      const result = this.db
        .prepare(
          "update chat_turns set state = 'running', updated_at = ? where id = ? and state = 'accepted'",
        )
        .run(at, turnId)
      if (Number(result.changes) !== 1) return false
      this.bumpUserEntry(turnId, at)
      return true
    })
  }

  waitForConnection(
    turnId: string,
    attemptId: string,
    text: string,
  ): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const turn = this.db.prepare('select scope_key from chat_turns where id = ?').get(turnId)
      if (!turn) return undefined
      const at = this.now().toISOString()
      const changed = this.db
        .prepare(
          "update chat_turns set state = 'waiting_connection', updated_at = ? where id = ? and state = 'accepted'",
        )
        .run(at, turnId)
      if (Number(changed.changes) !== 1) return undefined
      this.bumpUserEntry(turnId, at)
      const existing = this.db
        .prepare("select id from chat_entries where turn_id = ? and kind = 'connection'")
        .get(turnId)
      if (existing) {
        const id = requiredString(existing, 'id')
        this.db
          .prepare(
            'update chat_entries set revision = revision + 1, message_json = ?, updated_at = ? where id = ?',
          )
          .run(JSON.stringify(ChatMessageSchema.parse({ role: 'assistant', text })), at, id)
        const updated = this.db.prepare('select * from chat_entries where id = ?').get(id)
        return updated ? this.entryFromRow(updated) : undefined
      }
      const id = `cte-${randomUUID()}`
      this.insertEntry({
        id,
        scopeKey: requiredString(turn, 'scope_key'),
        turnId,
        kind: 'connection',
        connectionAttemptId: attemptId,
        message: { role: 'assistant', text },
        at,
      })
      const row = this.db.prepare('select * from chat_entries where id = ?').get(id)
      return row ? this.entryFromRow(row) : undefined
    })
  }

  updateConnectionStatus(turnId: string, text: string): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare("select id from chat_entries where turn_id = ? and kind = 'connection'")
        .get(turnId)
      if (!row) return undefined
      const id = requiredString(row, 'id')
      this.db
        .prepare(
          'update chat_entries set revision = revision + 1, message_json = ?, updated_at = ? where id = ?',
        )
        .run(
          JSON.stringify(ChatMessageSchema.parse({ role: 'assistant', text })),
          this.now().toISOString(),
          id,
        )
      const updated = this.db.prepare('select * from chat_entries where id = ?').get(id)
      return updated ? this.entryFromRow(updated) : undefined
    })
  }

  resumeConnection(turnId: string): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const at = this.now().toISOString()
      const result = this.db
        .prepare(
          "update chat_turns set state = 'accepted', updated_at = ? where id = ? and state = 'waiting_connection'",
        )
        .run(at, turnId)
      if (Number(result.changes) !== 1) return undefined
      this.bumpUserEntry(turnId, at)
      return this.userEntry(turnId)
    })
  }

  waitingConnections(): ChatAcceptance[] {
    return this.db
      .prepare(
        "select * from chat_turns where state = 'waiting_connection' order by created_at, rowid",
      )
      .all()
      .map(acceptanceFromRow)
  }

  userEntry(turnId: string): ChatTimelineEntry | undefined {
    const row = this.db
      .prepare("select * from chat_entries where turn_id = ? and kind = 'user'")
      .get(turnId)
    return row ? this.entryFromRow(row) : undefined
  }

  complete(turnId: string, message: ChatMessage): ChatTimelineEntry | undefined {
    const parsed = ChatMessageSchema.parse(message)
    if (parsed.role !== 'assistant') throw new Error('final Chat entry must be an Agent reply')
    return this.finish(turnId, 'completed', 'assistant', parsed)
  }

  completeWithDecisions(turnId: string): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const at = this.now().toISOString()
      const result = this.db
        .prepare(
          "update chat_turns set state = 'completed', updated_at = ? where id = ? and state in ('accepted', 'running', 'waiting_connection')",
        )
        .run(at, turnId)
      if (Number(result.changes) !== 1) return undefined
      this.bumpUserEntry(turnId, at)
      return this.userEntry(turnId)
    })
  }

  addDecision(turnId: string, input: PendingDecision): ChatTimelineEntry | undefined {
    const decision = PendingDecisionSchema.parse(input)
    return withImmediateTransaction(this.db, () => {
      const existing = this.db
        .prepare('select * from chat_entries where decision_id = ?')
        .get(decision.id)
      if (existing) {
        const current = this.entryFromRow(existing)
        if (current.message.pendingDecisions?.some((item) => item.id === decision.id))
          return current
        const at = this.now().toISOString()
        this.db
          .prepare(
            'update chat_entries set revision = revision + 1, message_json = ?, updated_at = ? where decision_id = ?',
          )
          .run(JSON.stringify(decisionMessage(decision)), at, decision.id)
        const replaced = this.db
          .prepare('select * from chat_entries where decision_id = ?')
          .get(decision.id)
        return replaced ? this.entryFromRow(replaced) : undefined
      }
      const turn = this.db.prepare('select scope_key from chat_turns where id = ?').get(turnId)
      if (!turn) return undefined
      const id = `cte-${randomUUID()}`
      const at = this.now().toISOString()
      this.insertEntry({
        id,
        scopeKey: requiredString(turn, 'scope_key'),
        turnId,
        kind: 'decision',
        decisionId: decision.id,
        message: decisionMessage(decision),
        at,
      })
      this.db
        .prepare('insert into chat_decision_revisions (decision_id, source_revision) values (?, 0)')
        .run(decision.id)
      const row = this.db.prepare('select * from chat_entries where id = ?').get(id)
      return row ? this.entryFromRow(row) : undefined
    })
  }

  addUnprojectedDecision(turnId: string, decisionId: string): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const existing = this.db
        .prepare('select * from chat_entries where decision_id = ?')
        .get(decisionId)
      if (existing) return this.entryFromRow(existing)
      const turn = this.db.prepare('select scope_key from chat_turns where id = ?').get(turnId)
      if (!turn) return undefined
      const id = `cte-${randomUUID()}`
      const at = this.now().toISOString()
      this.insertEntry({
        id,
        scopeKey: requiredString(turn, 'scope_key'),
        turnId,
        kind: 'decision',
        decisionId,
        message: {
          role: 'assistant',
          text: PENDING_DECISION_FALLBACK_FEEDBACK,
          pendingDecisionIds: [decisionId],
        },
        at,
      })
      this.db
        .prepare('insert into chat_decision_revisions (decision_id, source_revision) values (?, 0)')
        .run(decisionId)
      const row = this.db.prepare('select * from chat_entries where id = ?').get(id)
      return row ? this.entryFromRow(row) : undefined
    })
  }

  updateDecision(
    decisionId: string,
    sourceRevision: number,
    input: PendingDecision,
  ): ChatTimelineEntry | undefined {
    const decision = PendingDecisionSchema.parse(input)
    if (decision.id !== decisionId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1)
      throw new Error('Invalid Chat decision revision')
    return withImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare('select * from chat_entries where decision_id = ?')
        .get(decisionId)
      if (!row) return undefined
      const source = this.db
        .prepare('select source_revision from chat_decision_revisions where decision_id = ?')
        .get(decisionId)
      if (source && sourceRevision <= requiredNumber(source, 'source_revision')) return undefined
      this.db
        .prepare(
          'update chat_entries set revision = revision + 1, message_json = ?, updated_at = ? where decision_id = ?',
        )
        .run(JSON.stringify(decisionMessage(decision)), this.now().toISOString(), decisionId)
      this.db
        .prepare(
          'insert into chat_decision_revisions (decision_id, source_revision) values (?, ?) on conflict (decision_id) do update set source_revision = excluded.source_revision',
        )
        .run(decisionId, sourceRevision)
      const updated = this.db
        .prepare('select * from chat_entries where decision_id = ?')
        .get(decisionId)
      return updated ? this.entryFromRow(updated) : undefined
    })
  }

  fail(turnId: string, text: string, interrupted = false): ChatTimelineEntry | undefined {
    const safeText = text.trim().slice(0, 700) || 'The Chat turn failed.'
    return this.finish(turnId, interrupted ? 'interrupted' : 'failed', 'error', {
      role: 'assistant',
      text: safeText,
    })
  }

  page(scope: ChatScope, before?: string, limit = 40): ChatTimelinePage {
    const key = scopeKey(scope)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid page size')
    const position = before === undefined ? undefined : decodeCursor(key, before)
    const rows =
      position === undefined
        ? this.db
            .prepare(
              'select * from chat_entries where scope_key = ? order by position desc limit ?',
            )
            .all(key, limit + 1)
        : this.db
            .prepare(
              'select * from chat_entries where scope_key = ? and position < ? order by position desc limit ?',
            )
            .all(key, position, limit + 1)
    const hasOlder = rows.length > limit
    const entries = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.entryFromRow(row))
    const oldest = entries[0]
    return {
      entries,
      ...(hasOlder && oldest ? { nextBefore: oldest.cursor } : {}),
    }
  }

  accepted(): ChatAcceptance[] {
    return this.db
      .prepare("select * from chat_turns where state = 'accepted' order by created_at, rowid")
      .all()
      .map(acceptanceFromRow)
  }

  recoverInterrupted(): ChatTimelineEntry[] {
    const running = this.db.prepare("select id from chat_turns where state = 'running'").all()
    return running.flatMap((row) => {
      const entry = this.fail(
        requiredString(row, 'id'),
        'Interrupted. Completion is unknown. Choose Retry to run this request again.',
        true,
      )
      return entry ? [entry] : []
    })
  }

  private finish(
    turnId: string,
    state: 'completed' | 'failed' | 'interrupted',
    kind: 'assistant' | 'error',
    message: ChatMessage,
  ): ChatTimelineEntry | undefined {
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare('select * from chat_turns where id = ?').get(turnId)
      if (
        !row ||
        !['accepted', 'running', 'waiting_connection'].includes(requiredString(row, 'state'))
      )
        return undefined
      const key = requiredString(row, 'scope_key')
      const at = this.now().toISOString()
      this.db
        .prepare('update chat_turns set state = ?, updated_at = ? where id = ?')
        .run(state, at, turnId)
      this.bumpUserEntry(turnId, at)
      const id = `cte-${randomUUID()}`
      this.insertEntry({ id, scopeKey: key, turnId, kind, message, at })
      const entry = this.db.prepare('select * from chat_entries where id = ?').get(id)
      if (!entry) throw new Error('Chat terminal entry was not committed')
      return this.entryFromRow(entry)
    })
  }

  private bumpUserEntry(turnId: string, at: string): void {
    this.db
      .prepare(
        "update chat_entries set revision = revision + 1, updated_at = ? where turn_id = ? and kind = 'user'",
      )
      .run(at, turnId)
  }

  private insertEntry(input: {
    id: string
    scopeKey: string
    turnId: string
    kind: ChatTimelineKind
    message: ChatMessage
    at: string
    decisionId?: string
    connectionAttemptId?: string
  }): void {
    this.db
      .prepare(
        'insert into chat_scope_positions (scope_key, next_position) values (?, 1) on conflict (scope_key) do nothing',
      )
      .run(input.scopeKey)
    const row = this.db
      .prepare('select next_position from chat_scope_positions where scope_key = ?')
      .get(input.scopeKey)
    if (!row) throw new Error('Chat scope position unavailable')
    const position = requiredNumber(row, 'next_position')
    this.db
      .prepare('update chat_scope_positions set next_position = ? where scope_key = ?')
      .run(position + 1, input.scopeKey)
    this.db
      .prepare(
        `insert into chat_entries
         (id, scope_key, position, turn_id, kind, decision_id, connection_attempt_id, message_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.scopeKey,
        position,
        input.turnId,
        input.kind,
        input.decisionId ?? null,
        input.connectionAttemptId ?? null,
        JSON.stringify(ChatMessageSchema.parse(input.message)),
        input.at,
        input.at,
      )
  }

  private entryFromRow(row: Record<string, unknown>): ChatTimelineEntry {
    const turnId = requiredString(row, 'turn_id')
    const kind = requiredString(row, 'kind') as ChatTimelineKind
    const key = requiredString(row, 'scope_key')
    const entry: ChatTimelineEntry = {
      id: requiredString(row, 'id'),
      turnId,
      scope: scopeFromKey(key),
      cursor: encodeCursor(key, requiredNumber(row, 'position')),
      position: requiredNumber(row, 'position'),
      revision: requiredNumber(row, 'revision'),
      kind,
      message: ChatMessageSchema.parse(JSON.parse(requiredString(row, 'message_json'))),
      createdAt: requiredString(row, 'created_at'),
      updatedAt: requiredString(row, 'updated_at'),
    }
    if (kind === 'user') {
      const turn = this.db
        .prepare('select state, retry_of from chat_turns where id = ?')
        .get(turnId)
      if (!turn) throw new Error('Chat entry has no owning turn')
      entry.turnState = requiredString(turn, 'state') as ChatTurnState
      const retryOf = optionalString(turn, 'retry_of')
      if (retryOf !== undefined) entry.retryOf = retryOf
    }
    const connectionAttemptId = optionalString(row, 'connection_attempt_id')
    if (connectionAttemptId !== undefined) entry.connectionAttemptId = connectionAttemptId
    return entry
  }
}

function scopeKey(scope: ChatScope): string {
  return scope.type === 'global' ? 'global' : `space:${scope.spaceId}`
}

function scopeFromKey(key: string): ChatScope {
  return key === 'global' ? { type: 'global' } : { type: 'space', spaceId: key.slice(6) }
}

function encodeCursor(key: string, position: number): string {
  return Buffer.from(JSON.stringify([key, position])).toString('base64url')
}

function decodeCursor(key: string, cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(parsed) &&
      parsed[0] === key &&
      typeof parsed[1] === 'number' &&
      Number.isSafeInteger(parsed[1]) &&
      parsed[1] > 0
    )
      return parsed[1]
  } catch {
    // Report one safe public error for malformed or foreign-scope cursors.
  }
  throw new ChatTimelineError('invalid_cursor', 'Invalid Chat timeline cursor')
}

function acceptanceFromRow(row: Record<string, unknown>): ChatAcceptance {
  const retryOf = optionalString(row, 'retry_of')
  return {
    submissionId: requiredString(row, 'submission_id'),
    turnId: requiredString(row, 'id'),
    entryId: requiredString(row, 'user_entry_id'),
    scope: scopeFromKey(requiredString(row, 'scope_key')),
    state: requiredString(row, 'state') as ChatTurnState,
    ...(retryOf === undefined ? {} : { retryOf }),
  }
}

function decisionMessage(decision: PendingDecision): ChatMessage {
  return ChatMessageSchema.parse({
    role: 'assistant',
    text: pendingDecisionFeedback(decision),
    pendingDecisions: [decision],
    ...(decision.state === 'pending' ? {} : { decisionFeedbackId: decision.id }),
  })
}
