import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TriggerRef } from './agent-runner.ts'
import type { Origin } from './taint.ts'
import { canonicalAllowlistParams } from './trust-contracts.ts'
import { rowProvenance, TrustStore, type NewApprovalRow } from './trust-store.ts'

/**
 * Storage-level tests for the trust layer's durable state machine (Fix 7
 * split): schema DDL constraints, row codecs, and `TrustStore`'s repository
 * operations, exercised directly — no registry, no `ApprovalCardPort`, no
 * decision policy. `trust-layer.test.ts` covers the facade's business
 * behavior (decide/resolve/recovery orchestration) built on top of this.
 */

let rootDir: string
let store: TrustStore

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-trust-store-'))
  store = new TrustStore(rootDir)
})

afterEach(() => {
  store.dispose()
  rmSync(rootDir, { recursive: true, force: true })
})

function newRow(overrides: Partial<NewApprovalRow> = {}): NewApprovalRow {
  return {
    id: 'effect-1',
    toolName: 'send_message',
    level: 'L1',
    input: { to: 'alice@example.com', body: 'hi' },
    effectiveOrigin: 'trusted:user',
    originChain: ['trusted:user'],
    contextHash: 'hash-1',
    toolCallId: 'call-1',
    spaceId: 'spc-test',
    createdAt: '2026-07-10T12:00:00.000Z',
    expiresAt: '2026-07-10T12:30:00.000Z',
    ...overrides,
  }
}

describe('schema', () => {
  it('created_from_approval_id is NOT NULL on allowlist_rules', () => {
    const db = (
      store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }
    ).db
    expect(() =>
      db
        .prepare(
          `insert into allowlist_rules (tool_name, params_json, created_at) values (?, ?, ?)`,
        )
        .run('send_message', '{}', '2026-07-10T12:00:00.000Z'),
    ).toThrow()
  })

  it('audit_log is append-only: UPDATE and DELETE both raise', () => {
    store.insertAudit({ kind: 'action.decision', refId: 'effect-1' }, '2026-07-10T12:00:00.000Z')
    const db = (
      store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }
    ).db
    expect(() =>
      db.prepare(`update audit_log set detail = 'tampered' where id = 1`).run(),
    ).toThrow()
    expect(() => db.prepare(`delete from audit_log where id = 1`).run()).toThrow()
  })

  it('audit_log enforces at most one action.outcome row per ref_id', () => {
    store.insertAudit(
      { kind: 'action.outcome', refId: 'dup-1', outcome: 'executed' },
      '2026-07-10T12:00:00.000Z',
    )
    expect(() =>
      store.insertAudit(
        { kind: 'action.outcome', refId: 'dup-1', outcome: 'executed' },
        '2026-07-10T12:00:01.000Z',
      ),
    ).toThrow()
  })
})

describe('pending_approvals: insert + read', () => {
  it('insertApprovalRow("pending") leaves decision_at null and surface_id null', () => {
    store.insertApprovalRow(newRow(), 'pending')
    const row = store.getRawRow('effect-1')
    expect(row?.status).toBe('pending')
    expect(row?.decisionAt).toBeUndefined()
    expect(row?.surfaceId).toBeUndefined()
    expect(row?.outcomeEventAt).toBeUndefined()
  })

  it('insertApprovalRow("executing") stamps decision_at at createdAt', () => {
    store.insertApprovalRow(newRow({ id: 'effect-2' }), 'executing')
    const row = store.getRawRow('effect-2')
    expect(row?.status).toBe('executing')
    expect(row?.decisionAt).toBe('2026-07-10T12:00:00.000Z')
  })

  it('round-trips a trigger with a nested parent chain (Fix 8) through input/origin/trigger columns', () => {
    const twoHop: TriggerRef = {
      kind: 'automation',
      id: 'job-1',
      parent: { kind: 'external-event', source: 'gmail' },
    }
    store.insertApprovalRow(
      newRow({ trigger: twoHop, originChain: ['trusted:user', 'untrusted:gmail'] }),
      'pending',
    )
    const row = store.getRawRow('effect-1')
    expect(row?.triggerJson).toBeDefined()
    expect(JSON.parse(row?.triggerJson as string)).toEqual(twoHop)
  })

  it('setSurfaceId always overwrites; attachSurfaceIdIfMissing never clobbers an existing value', () => {
    store.insertApprovalRow(newRow(), 'pending')
    store.setSurfaceId('effect-1', 'srf-a')
    expect(store.getRawRow('effect-1')?.surfaceId).toBe('srf-a')
    store.setSurfaceId('effect-1', 'srf-b')
    expect(store.getRawRow('effect-1')?.surfaceId).toBe('srf-b')

    store.attachSurfaceIdIfMissing('effect-1', 'srf-c')
    expect(store.getRawRow('effect-1')?.surfaceId).toBe('srf-b') // unchanged: already set

    store.insertApprovalRow(newRow({ id: 'effect-3' }), 'pending')
    store.attachSurfaceIdIfMissing('effect-3', 'srf-d')
    expect(store.getRawRow('effect-3')?.surfaceId).toBe('srf-d')
  })
})

describe('pending_approvals: listing', () => {
  it('listPendingNotExpired excludes rows past their own expiry', () => {
    store.insertApprovalRow(
      newRow({ id: 'still-open', expiresAt: '2026-07-10T13:00:00.000Z' }),
      'pending',
    )
    store.insertApprovalRow(
      newRow({ id: 'overdue', expiresAt: '2026-07-10T11:00:00.000Z' }),
      'pending',
    )
    const rows = store.listPendingNotExpired('2026-07-10T12:00:00.000Z')
    expect(rows.map((row) => row.id)).toEqual(['still-open'])
  })

  it('listByStatus matches only the given status', () => {
    store.insertApprovalRow(newRow({ id: 'a' }), 'pending')
    store.insertApprovalRow(newRow({ id: 'b' }), 'executing')
    expect(store.listByStatus('pending').map((r) => r.id)).toEqual(['a'])
    expect(store.listByStatus('executing').map((r) => r.id)).toEqual(['b'])
  })

  it('listExpiredPending matches only pending rows whose expiry has passed', () => {
    store.insertApprovalRow(
      newRow({ id: 'overdue', expiresAt: '2026-07-10T11:00:00.000Z' }),
      'pending',
    )
    store.insertApprovalRow(
      newRow({ id: 'fresh', expiresAt: '2026-07-10T13:00:00.000Z' }),
      'pending',
    )
    const rows = store.listExpiredPending('2026-07-10T12:00:00.000Z')
    expect(rows.map((row) => row.id)).toEqual(['overdue'])
  })

  it('listTerminalMissingOutcomeEvent matches only terminal statuses with outcome_event_at still null', () => {
    store.insertApprovalRow(newRow({ id: 'approved-missing' }), 'pending')
    store.claimExecuting('approved-missing', '2026-07-10T12:01:00.000Z', JSON.stringify({}))
    store.markApproved('approved-missing')

    store.insertApprovalRow(newRow({ id: 'approved-done' }), 'pending')
    store.claimExecuting('approved-done', '2026-07-10T12:01:00.000Z', JSON.stringify({}))
    store.markApproved('approved-done')
    store.setOutcomeEventAt('approved-done', '2026-07-10T12:02:00.000Z')

    store.insertApprovalRow(newRow({ id: 'still-pending' }), 'pending')

    const rows = store.listTerminalMissingOutcomeEvent()
    expect(rows.map((row) => row.id)).toEqual(['approved-missing'])
  })
})

describe('pending_approvals: status transitions', () => {
  it('claimRejected only succeeds from pending and before expiry', () => {
    store.insertApprovalRow(newRow(), 'pending')
    expect(store.claimRejected('effect-1', '2026-07-10T12:31:00.000Z')).toBe(false) // past expires_at
    expect(store.claimRejected('effect-1', '2026-07-10T12:05:00.000Z')).toBe(true)
    expect(store.getRawRow('effect-1')?.status).toBe('rejected')
    expect(store.claimRejected('effect-1', '2026-07-10T12:06:00.000Z')).toBe(false) // already claimed
  })

  it('claimExecuting only succeeds from pending, and persists the (possibly edited) input', () => {
    store.insertApprovalRow(newRow(), 'pending')
    const claimed = store.claimExecuting(
      'effect-1',
      '2026-07-10T12:05:00.000Z',
      JSON.stringify({ to: 'edited' }),
    )
    expect(claimed).toBe(true)
    const row = store.getRawRow('effect-1')
    expect(row?.status).toBe('executing')
    expect(JSON.parse(row?.inputJson as string)).toEqual({ to: 'edited' })
    expect(store.claimExecuting('effect-1', '2026-07-10T12:06:00.000Z', '{}')).toBe(false)
  })

  it('claimExpired only succeeds from pending, regardless of the expiry column', () => {
    store.insertApprovalRow(newRow({ expiresAt: '2099-01-01T00:00:00.000Z' }), 'pending')
    expect(store.claimExpired('effect-1')).toBe(true)
    expect(store.getRawRow('effect-1')?.status).toBe('expired')
    expect(store.claimExpired('effect-1')).toBe(false)
  })

  it('claimIndeterminate only succeeds from executing', () => {
    store.insertApprovalRow(newRow(), 'pending')
    expect(store.claimIndeterminate('effect-1')).toBe(false) // wrong fromStatus
    store.claimExecuting('effect-1', '2026-07-10T12:05:00.000Z', '{}')
    expect(store.claimIndeterminate('effect-1')).toBe(true)
    expect(store.getRawRow('effect-1')?.status).toBe('indeterminate')
  })

  it('markApproved is unconditional', () => {
    store.insertApprovalRow(newRow(), 'executing')
    store.markApproved('effect-1')
    expect(store.getRawRow('effect-1')?.status).toBe('approved')
  })

  it('setOutcomeEventAt persists the timestamp column', () => {
    store.insertApprovalRow(newRow(), 'pending')
    expect(store.getRawRow('effect-1')?.outcomeEventAt).toBeUndefined()
    store.setOutcomeEventAt('effect-1', '2026-07-10T12:02:00.000Z')
    expect(store.getRawRow('effect-1')?.outcomeEventAt).toBe('2026-07-10T12:02:00.000Z')
  })
})

describe('allowlist_rules', () => {
  it('upsertAllowlistRule is idempotent for an identical active rule and keeps created_from_approval_id from the first grant', () => {
    const paramsJson = canonicalAllowlistParams({ to: 'alice@example.com' })
    const first = store.upsertAllowlistRule(
      'send_message',
      paramsJson,
      'approval-1',
      '2026-07-10T12:00:00.000Z',
    )
    const second = store.upsertAllowlistRule(
      'send_message',
      paramsJson,
      'approval-2',
      '2026-07-10T12:01:00.000Z',
    )
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
    expect(store.listAllowlistRules()).toHaveLength(1)
    expect(store.listAllowlistRules()[0]?.createdFromApprovalId).toBe('approval-1')
  })

  it('findActiveAllowlistRule matches an unrevoked rule by tool + canonical params only', () => {
    const paramsJson = canonicalAllowlistParams({ to: 'alice@example.com' })
    expect(store.findActiveAllowlistRule('send_message', paramsJson)).toBeUndefined()
    store.upsertAllowlistRule('send_message', paramsJson, 'approval-1', '2026-07-10T12:00:00.000Z')
    expect(store.findActiveAllowlistRule('send_message', paramsJson)?.toolName).toBe('send_message')
  })

  it('revokeAllowlistRuleRow sets revoked_at and stops findActiveAllowlistRule from matching; no-op for an unknown id', () => {
    const paramsJson = canonicalAllowlistParams({ to: 'alice@example.com' })
    const { id } = store.upsertAllowlistRule(
      'send_message',
      paramsJson,
      'approval-1',
      '2026-07-10T12:00:00.000Z',
    )

    expect(store.revokeAllowlistRuleRow(9999, '2026-07-10T12:05:00.000Z')).toBeUndefined()

    const revoked = store.revokeAllowlistRuleRow(id, '2026-07-10T12:05:00.000Z')
    expect(revoked?.revokedAt).toBe('2026-07-10T12:05:00.000Z')
    expect(store.findActiveAllowlistRule('send_message', paramsJson)).toBeUndefined()
    expect(store.revokeAllowlistRuleRow(id, '2026-07-10T12:06:00.000Z')).toBeUndefined() // already revoked
  })
})

describe('audit_log: insertAudit / auditEntries round trip', () => {
  it('round-trips every field, including a two-hop trigger chain (Fix 8) through a decision audit row', () => {
    const twoHop: TriggerRef = {
      kind: 'automation',
      id: 'job-1',
      summary: 'scheduled digest run',
      parent: { kind: 'external-event', source: 'gmail', summary: 'new message arrived' },
    }
    store.insertAudit(
      {
        kind: 'action.decision',
        refId: 'effect-1',
        toolName: 'send_message',
        level: 'L1',
        decision: 'card',
        effectiveOrigin: 'untrusted:gmail',
        originChain: ['trusted:user', 'untrusted:gmail'],
        trigger: twoHop,
        contextHash: 'hash-1',
        input: { to: 'alice@example.com' },
        spaceId: 'spc-test',
      },
      '2026-07-10T12:00:00.000Z',
    )

    const [entry] = store.auditEntries(1)
    expect(entry?.kind).toBe('action.decision')
    expect(entry?.trigger).toEqual(twoHop)
    expect(entry?.trigger?.parent).toEqual(twoHop.parent)
    expect(entry?.originChain).toEqual(['trusted:user', 'untrusted:gmail'])
    expect(entry?.input).toEqual({ to: 'alice@example.com' })
    expect(entry?.spaceId).toBe('spc-test')
  })

  it('auditEntries orders newest first and respects limit', () => {
    store.insertAudit({ kind: 'action.decision', refId: 'a' }, '2026-07-10T12:00:00.000Z')
    store.insertAudit({ kind: 'action.decision', refId: 'b' }, '2026-07-10T12:00:01.000Z')
    store.insertAudit({ kind: 'action.decision', refId: 'c' }, '2026-07-10T12:00:02.000Z')
    expect(store.auditEntries(2).map((e) => e.refId)).toEqual(['c', 'b'])
  })

  it('terminalOutcomeFor reads back the one action.outcome row for a refId, or undefined if none exists', () => {
    expect(store.terminalOutcomeFor('effect-1')).toBeUndefined()
    store.insertAudit(
      { kind: 'action.outcome', refId: 'effect-1', outcome: 'executed' },
      '2026-07-10T12:00:00.000Z',
    )
    expect(store.terminalOutcomeFor('effect-1')).toBe('executed')
  })
})

describe('rowProvenance', () => {
  it('decodes a row into its decision-time provenance, including a nested trigger.parent (Fix 8)', () => {
    const twoHop: TriggerRef = {
      kind: 'automation',
      parent: { kind: 'chat' },
    }
    store.insertApprovalRow(
      newRow({ trigger: twoHop, originChain: ['trusted:user', 'untrusted:gmail' as Origin] }),
      'pending',
    )
    const row = store.getRawRow('effect-1')
    if (!row) throw new Error('expected row to exist')
    const provenance = rowProvenance(row)
    expect(provenance.effectiveOrigin).toBe('trusted:user')
    expect(provenance.originChain).toEqual(['trusted:user', 'untrusted:gmail'])
    expect(provenance.trigger).toEqual(twoHop)
    expect(provenance.trigger?.parent).toEqual({ kind: 'chat' })
    expect(provenance.contextHash).toBe('hash-1')
    expect(provenance.input).toEqual({ to: 'alice@example.com', body: 'hi' })
  })

  it('omits trigger entirely when the row carries none', () => {
    store.insertApprovalRow(newRow(), 'pending')
    const row = store.getRawRow('effect-1')
    if (!row) throw new Error('expected row to exist')
    expect(rowProvenance(row).trigger).toBeUndefined()
  })
})

describe('runInTransaction', () => {
  it('commits all statements together', () => {
    store.runInTransaction(() => {
      store.insertApprovalRow(newRow({ id: 'tx-1' }), 'pending')
      store.insertApprovalRow(newRow({ id: 'tx-2' }), 'pending')
    })
    expect(store.getRawRow('tx-1')).toBeDefined()
    expect(store.getRawRow('tx-2')).toBeDefined()
  })

  it('rolls back every statement when the work throws', () => {
    expect(() =>
      store.runInTransaction(() => {
        store.insertApprovalRow(newRow({ id: 'tx-3' }), 'pending')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.getRawRow('tx-3')).toBeUndefined()
  })
})
