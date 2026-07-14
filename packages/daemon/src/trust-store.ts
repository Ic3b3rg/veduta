import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TriggerRef } from './agent-runner.ts'
import { defaultRedactor } from './redaction.ts'
import {
  optionalString,
  requiredNumber,
  requiredString,
  withImmediateTransaction,
} from './sqlite-rows.ts'
import type { Origin } from './taint.ts'
import type {
  AllowlistRule,
  ApprovalStatus,
  AuditEntry,
  AuditKind,
  AuditOutcome,
  PendingApproval,
} from './trust-contracts.ts'

/**
 * The trust layer's durable state machine (issue #14, ADR-0007): the
 * `trust.sqlite` schema (DDL + append-only triggers), row codecs (JSON
 * parse/serialize), and the repository operations `trust-layer.ts`'s policy
 * facade composes into transactions. Nothing here decides allow/card/deny —
 * that stays in `TrustLayer`; this module only durably records what the
 * facade decided.
 */

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** A `pending_approvals` row, decoded from the driver's loosely-typed record. */
export interface ApprovalRow {
  id: string
  toolName: string
  level: 'L1' | 'L2'
  inputJson: string
  effectiveOrigin: Origin
  originChainJson: string
  triggerJson?: string
  contextHash: string
  toolCallId: string
  spaceId?: string
  surfaceId?: string
  createdAt: string
  expiresAt: string
  status: ApprovalStatus
  decisionAt?: string
  outcomeEventAt?: string
}

/** The fields `insertApprovalRow` needs to create a new `pending_approvals` row. */
export interface NewApprovalRow {
  id: string
  toolName: string
  level: 'L1' | 'L2'
  input: unknown
  effectiveOrigin: Origin
  originChain: Origin[]
  trigger?: TriggerRef
  contextHash: string
  toolCallId: string
  spaceId?: string
  createdAt: string
  expiresAt: string
}

/**
 * A row's decision-time provenance, decoded once (Fix 7): every audit writer
 * that copies a row's origin chain, trigger, context hash, and original
 * input into a new audit entry used to reconstruct this by hand — five
 * separate `JSON.parse(row.originChainJson)` / `row.triggerJson ? JSON.parse
 * (...) : undefined` call sites, unchecked. This is the one place that does
 * it now.
 */
export interface RowProvenance {
  effectiveOrigin: Origin
  originChain: Origin[]
  trigger?: TriggerRef
  contextHash: string
  input: unknown
}

/** The shared provenance decoder (Fix 7): every audit writer reconstructs a row's decision-time snapshot through this, never by hand. */
export function rowProvenance(row: ApprovalRow): RowProvenance {
  return {
    effectiveOrigin: row.effectiveOrigin,
    originChain: JSON.parse(row.originChainJson) as Origin[],
    ...(row.triggerJson !== undefined
      ? { trigger: JSON.parse(row.triggerJson) as TriggerRef }
      : {}),
    contextHash: row.contextHash,
    input: JSON.parse(row.inputJson) as unknown,
  }
}

/** `spaceId` is a required param (not read off `row`) so callers narrow the optional column exactly once, at the call site. */
export function pendingApprovalFromRow(row: ApprovalRow, spaceId: string): PendingApproval {
  return {
    id: row.id,
    toolName: row.toolName,
    level: row.level,
    input: JSON.parse(row.inputJson) as unknown,
    effectiveOrigin: row.effectiveOrigin,
    originChain: JSON.parse(row.originChainJson) as Origin[],
    ...(row.triggerJson !== undefined
      ? { trigger: JSON.parse(row.triggerJson) as TriggerRef }
      : {}),
    contextHash: row.contextHash,
    toolCallId: row.toolCallId,
    spaceId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

function approvalRowFromRow(row: Record<string, unknown>): ApprovalRow {
  const level = requiredString(row, 'level')
  if (level !== 'L1' && level !== 'L2') throw new Error(`unexpected approval level: ${level}`)
  const status = requiredString(row, 'status')
  if (
    status !== 'pending' &&
    status !== 'executing' &&
    status !== 'approved' &&
    status !== 'rejected' &&
    status !== 'expired' &&
    status !== 'indeterminate'
  ) {
    throw new Error(`unexpected approval status: ${status}`)
  }
  const triggerJson = optionalString(row, 'trigger_json')
  const spaceId = optionalString(row, 'space_id')
  const surfaceId = optionalString(row, 'surface_id')
  const decisionAt = optionalString(row, 'decision_at')
  const outcomeEventAt = optionalString(row, 'outcome_event_at')
  return {
    id: requiredString(row, 'id'),
    toolName: requiredString(row, 'tool_name'),
    level,
    inputJson: requiredString(row, 'input_json'),
    effectiveOrigin: requiredString(row, 'effective_origin') as Origin,
    originChainJson: requiredString(row, 'origin_chain_json'),
    ...(triggerJson === undefined ? {} : { triggerJson }),
    contextHash: requiredString(row, 'context_hash'),
    toolCallId: requiredString(row, 'tool_call_id'),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(surfaceId === undefined ? {} : { surfaceId }),
    createdAt: requiredString(row, 'created_at'),
    expiresAt: requiredString(row, 'expires_at'),
    status,
    ...(decisionAt === undefined ? {} : { decisionAt }),
    ...(outcomeEventAt === undefined ? {} : { outcomeEventAt }),
  }
}

function allowlistRuleFromRow(row: Record<string, unknown>): AllowlistRule {
  const paramsJson = requiredString(row, 'params_json')
  const revokedAt = optionalString(row, 'revoked_at')
  return {
    id: requiredNumber(row, 'id'),
    toolName: requiredString(row, 'tool_name'),
    params: JSON.parse(paramsJson) as Record<string, string>,
    paramsJson,
    createdAt: requiredString(row, 'created_at'),
    createdFromApprovalId: requiredString(row, 'created_from_approval_id'),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

function auditEntryFromRow(row: Record<string, unknown>): AuditEntry {
  const kind = requiredString(row, 'kind') as AuditKind
  const refId = optionalString(row, 'ref_id')
  const toolName = optionalString(row, 'tool_name')
  const level = optionalString(row, 'level')
  const decision = optionalString(row, 'decision')
  const effectiveOrigin = optionalString(row, 'effective_origin')
  const originChainJson = optionalString(row, 'origin_chain_json')
  const triggerJson = optionalString(row, 'trigger_json')
  const contextHash = optionalString(row, 'context_hash')
  const inputJson = optionalString(row, 'input_json')
  const outcome = optionalString(row, 'outcome')
  const detail = optionalString(row, 'detail')
  const approvedBy = optionalString(row, 'approved_by')
  const allowlistRuleId = row['allowlist_rule_id']
  const spaceId = optionalString(row, 'space_id')
  return {
    id: requiredNumber(row, 'id'),
    at: requiredString(row, 'at'),
    kind,
    ...(refId === undefined ? {} : { refId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(level === undefined ? {} : { level: level as 'L1' | 'L2' }),
    ...(decision === undefined ? {} : { decision }),
    ...(effectiveOrigin === undefined ? {} : { effectiveOrigin: effectiveOrigin as Origin }),
    ...(originChainJson === undefined
      ? {}
      : { originChain: JSON.parse(originChainJson) as Origin[] }),
    ...(triggerJson === undefined ? {} : { trigger: JSON.parse(triggerJson) as TriggerRef }),
    ...(contextHash === undefined ? {} : { contextHash }),
    ...(inputJson === undefined ? {} : { input: JSON.parse(inputJson) as unknown }),
    ...(outcome === undefined ? {} : { outcome: outcome as AuditOutcome }),
    ...(detail === undefined ? {} : { detail }),
    ...(approvedBy === undefined ? {} : { approvedBy: approvedBy as Origin }),
    ...(allowlistRuleId === null || allowlistRuleId === undefined
      ? {}
      : { allowlistRuleId: Number(allowlistRuleId) }),
    ...(spaceId === undefined ? {} : { spaceId }),
  }
}

/** The shape `insertAudit` accepts — identical to the facade's pre-split private method. */
export interface AuditInsertParams {
  kind: AuditKind
  refId?: string
  toolName?: string
  level?: 'L1' | 'L2'
  decision?: string
  effectiveOrigin?: Origin
  originChain?: Origin[]
  trigger?: TriggerRef
  contextHash?: string
  input?: unknown
  outcome?: AuditOutcome
  detail?: string
  approvedBy?: Origin
  allowlistRuleId?: number
  spaceId?: string
}

// ---------------------------------------------------------------------------
// TrustStore
// ---------------------------------------------------------------------------

export class TrustStore {
  private readonly db: DatabaseSync

  constructor(rootDir: string) {
    this.db = new DatabaseSync(join(rootDir, 'trust.sqlite'))
    this.initializeSchema()
  }

  dispose(): void {
    this.db.close()
  }

  /** Exposes atomicity to the facade: `TrustLayer` composes several store calls into one transaction (resolve/claim flow, recovery). */
  runInTransaction<T>(work: () => T): T {
    return withImmediateTransaction(this.db, work)
  }

  // -- pending_approvals: insert/attach --------------------------------

  /** `status` selects the two shapes `executeAllowed`/`createCard` need: `'executing'` stamps `decision_at` at `row.createdAt`, `'pending'` leaves it null. `surface_id` always starts null either way. */
  insertApprovalRow(row: NewApprovalRow, status: 'pending' | 'executing'): void {
    const triggerJson = row.trigger ? JSON.stringify(row.trigger) : null
    const spaceId = row.spaceId ?? null
    if (status === 'executing') {
      this.db
        .prepare(
          `insert into pending_approvals
             (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
              context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, 'executing', ?)`,
        )
        .run(
          row.id,
          row.toolName,
          row.level,
          JSON.stringify(row.input),
          row.effectiveOrigin,
          JSON.stringify(row.originChain),
          triggerJson,
          row.contextHash,
          row.toolCallId,
          spaceId,
          row.createdAt,
          row.expiresAt,
          row.createdAt,
        )
      return
    }
    this.db
      .prepare(
        `insert into pending_approvals
           (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
            context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, 'pending', null)`,
      )
      .run(
        row.id,
        row.toolName,
        row.level,
        JSON.stringify(row.input),
        row.effectiveOrigin,
        JSON.stringify(row.originChain),
        triggerJson,
        row.contextHash,
        row.toolCallId,
        spaceId,
        row.createdAt,
        row.expiresAt,
      )
  }

  /** Unconditional (used right after `insertApprovalRow('pending', ...)`, before any concurrent claim is possible). */
  setSurfaceId(id: string, surfaceId: string): void {
    this.db.prepare(`update pending_approvals set surface_id = ? where id = ?`).run(surfaceId, id)
  }

  /** Recovery-only: guarded by `surface_id is null` so it can never clobber a value already recorded. */
  attachSurfaceIdIfMissing(id: string, surfaceId: string): void {
    this.runInTransaction(() => {
      this.db
        .prepare(`update pending_approvals set surface_id = ? where id = ? and surface_id is null`)
        .run(surfaceId, id)
    })
  }

  // -- pending_approvals: reads -----------------------------------------

  getRawRow(id: string): ApprovalRow | undefined {
    const row = this.db.prepare('select * from pending_approvals where id = ?').get(id)
    return row ? approvalRowFromRow(row) : undefined
  }

  listPendingNotExpired(nowIso: string): ApprovalRow[] {
    return this.db
      .prepare(`select * from pending_approvals where status = 'pending' and expires_at > ?`)
      .all(nowIso)
      .map(approvalRowFromRow)
  }

  listByStatus(status: ApprovalStatus): ApprovalRow[] {
    return this.db
      .prepare(`select * from pending_approvals where status = ?`)
      .all(status)
      .map(approvalRowFromRow)
  }

  listExpiredPending(nowIso: string): ApprovalRow[] {
    return this.db
      .prepare(`select * from pending_approvals where status = 'pending' and expires_at <= ?`)
      .all(nowIso)
      .map(approvalRowFromRow)
  }

  /** Fix 10: terminal rows whose Space outcome event never landed (crash between the status transaction and the append). */
  listTerminalMissingOutcomeEvent(): ApprovalRow[] {
    return this.db
      .prepare(
        `select * from pending_approvals
         where status in ('approved', 'rejected', 'expired', 'indeterminate')
           and outcome_event_at is null`,
      )
      .all()
      .map(approvalRowFromRow)
  }

  // -- pending_approvals: status transitions ----------------------------
  // Each returns whether it actually claimed the row (its own `WHERE
  // status = <from>` matched); the facade decides what to do on a miss.

  claimRejected(id: string, nowIso: string): boolean {
    const result = this.db
      .prepare(
        `update pending_approvals set status = 'rejected', decision_at = ?
         where id = ? and status = 'pending' and expires_at > ?`,
      )
      .run(nowIso, id, nowIso)
    return Number(result.changes) === 1
  }

  claimExecuting(id: string, nowIso: string, inputJson: string): boolean {
    const result = this.db
      .prepare(
        `update pending_approvals set status = 'executing', decision_at = ?, input_json = ?
         where id = ? and status = 'pending' and expires_at > ?`,
      )
      .run(nowIso, inputJson, id, nowIso)
    return Number(result.changes) === 1
  }

  claimExpired(id: string): boolean {
    const result = this.db
      .prepare(
        `update pending_approvals set status = 'expired' where id = ? and status = 'pending'`,
      )
      .run(id)
    return Number(result.changes) === 1
  }

  claimIndeterminate(id: string): boolean {
    const result = this.db
      .prepare(
        `update pending_approvals set status = 'indeterminate' where id = ? and status = 'executing'`,
      )
      .run(id)
    return Number(result.changes) === 1
  }

  /** Unconditional: the decision to run was already made (auto-allowed or human-approved); this only marks the row done. */
  markApproved(id: string): void {
    this.db.prepare(`update pending_approvals set status = 'approved' where id = ?`).run(id)
  }

  setOutcomeEventAt(id: string, atIso: string): void {
    this.db.prepare(`update pending_approvals set outcome_event_at = ? where id = ?`).run(atIso, id)
  }

  // -- allowlist_rules ----------------------------------------------------

  findActiveAllowlistRule(toolName: string, paramsJson: string): AllowlistRule | undefined {
    const row = this.db
      .prepare(
        `select * from allowlist_rules where tool_name = ? and params_json = ? and revoked_at is null`,
      )
      .get(toolName, paramsJson)
    return row ? allowlistRuleFromRow(row) : undefined
  }

  /** Idempotent upsert (A5): an identical active rule is never duplicated. Safe standalone or nested in a caller's transaction. */
  upsertAllowlistRule(
    toolName: string,
    paramsJson: string,
    createdFromApprovalId: string,
    nowIso: string,
  ): { id: number; created: boolean } {
    const insertResult = this.db
      .prepare(
        `insert into allowlist_rules (tool_name, params_json, created_at, created_from_approval_id)
         values (?, ?, ?, ?)
         on conflict (tool_name, params_json) where revoked_at is null do nothing`,
      )
      .run(toolName, paramsJson, nowIso, createdFromApprovalId)
    if (Number(insertResult.changes) === 1) {
      return { id: Number(insertResult.lastInsertRowid), created: true }
    }
    const existing = this.db
      .prepare(
        `select id from allowlist_rules where tool_name = ? and params_json = ? and revoked_at is null`,
      )
      .get(toolName, paramsJson)
    if (!existing)
      throw new Error('trust store: allowlist upsert conflict but no active rule found')
    return { id: requiredNumber(existing, 'id'), created: false }
  }

  listAllowlistRules(): AllowlistRule[] {
    return this.db
      .prepare('select * from allowlist_rules order by id')
      .all()
      .map(allowlistRuleFromRow)
  }

  /** Sets `revoked_at` and returns the just-revoked rule, or `undefined` if `id` was unknown or already revoked. Caller (facade) audits the actor/Space policy and owns the enclosing transaction. */
  revokeAllowlistRuleRow(id: number, nowIso: string): AllowlistRule | undefined {
    const upd = this.db
      .prepare(`update allowlist_rules set revoked_at = ? where id = ? and revoked_at is null`)
      .run(nowIso, id)
    if (Number(upd.changes) !== 1) return undefined
    const rule = this.db.prepare('select * from allowlist_rules where id = ?').get(id)
    return rule ? allowlistRuleFromRow(rule) : undefined
  }

  // -- audit_log ------------------------------------------------------------

  insertAudit(entry: AuditInsertParams, atIso: string): void {
    this.db
      .prepare(
        `insert into audit_log
           (at, kind, ref_id, tool_name, level, decision, effective_origin, origin_chain_json,
            trigger_json, context_hash, input_json, outcome, detail, approved_by, allowlist_rule_id, space_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        atIso,
        entry.kind,
        entry.refId ?? null,
        entry.toolName ?? null,
        entry.level ?? null,
        entry.decision ?? null,
        entry.effectiveOrigin ?? null,
        entry.originChain ? JSON.stringify(entry.originChain) : null,
        entry.trigger ? JSON.stringify(entry.trigger) : null,
        entry.contextHash ?? null,
        // Redacted at the insert boundary (issue #15 D3, SECURITY.md §4): a
        // tool's recorded input can carry a secret verbatim (an echoed key,
        // a token), and this append-only table is never rewritten.
        entry.input === undefined ? null : JSON.stringify(defaultRedactor.redactDeep(entry.input)),
        entry.outcome ?? null,
        entry.detail === undefined ? null : defaultRedactor.redactText(entry.detail),
        entry.approvedBy ?? null,
        entry.allowlistRuleId ?? null,
        entry.spaceId ?? null,
      )
  }

  /** The `action.outcome` audit row's `outcome` for one effectId — at most one exists (schema's unique index). */
  terminalOutcomeFor(effectId: string): AuditOutcome | undefined {
    const row = this.db
      .prepare(`select outcome from audit_log where kind = 'action.outcome' and ref_id = ?`)
      .get(effectId)
    if (!row) return undefined
    return optionalString(row as Record<string, unknown>, 'outcome') as AuditOutcome | undefined
  }

  auditEntries(limit: number): AuditEntry[] {
    return this.db
      .prepare('select * from audit_log order by id desc limit ?')
      .all(limit)
      .map(auditEntryFromRow)
  }

  // -- Schema ---------------------------------------------------------------

  private initializeSchema(): void {
    this.db.exec(`
      pragma journal_mode = wal;

      create table if not exists pending_approvals (
        id text primary key,
        tool_name text not null,
        level text not null check (level in ('L1', 'L2')),
        input_json text not null,
        effective_origin text not null,
        origin_chain_json text not null,
        trigger_json text,
        context_hash text not null,
        tool_call_id text not null,
        space_id text,
        surface_id text,
        created_at text not null,
        expires_at text not null,
        status text not null
          check (status in ('pending', 'executing', 'approved', 'rejected', 'expired', 'indeterminate')),
        decision_at text,
        outcome_event_at text
      );
      create index if not exists pending_approvals_status on pending_approvals (status);

      create table if not exists allowlist_rules (
        id integer primary key autoincrement,
        tool_name text not null,
        params_json text not null,
        created_at text not null,
        created_from_approval_id text not null,
        revoked_at text
      );
      create unique index if not exists allowlist_rules_active_unique
        on allowlist_rules (tool_name, params_json) where revoked_at is null;

      create table if not exists audit_log (
        id integer primary key autoincrement,
        at text not null,
        kind text not null check (kind in (
          'action.decision', 'approval.decided', 'action.outcome',
          'approval.edit_rejected', 'allowlist.created', 'allowlist.revoked'
        )),
        ref_id text,
        tool_name text,
        level text,
        decision text,
        effective_origin text,
        origin_chain_json text,
        trigger_json text,
        context_hash text,
        input_json text,
        outcome text,
        detail text,
        approved_by text,
        allowlist_rule_id integer,
        space_id text
      );
      create unique index if not exists audit_log_outcome_once
        on audit_log (ref_id) where kind = 'action.outcome';

      create trigger if not exists audit_log_no_update
      before update on audit_log
      begin
        select raise(abort, 'audit_log is append-only: update is forbidden');
      end;

      create trigger if not exists audit_log_no_delete
      before delete on audit_log
      begin
        select raise(abort, 'audit_log is append-only: delete is forbidden');
      end;
    `)
  }
}
