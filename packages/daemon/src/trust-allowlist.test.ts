import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TriggerRef } from './agent-runner.ts'
import type { Origin } from './taint.ts'
import { TrustAllowlist } from './trust-allowlist.ts'
import { TrustStore } from './trust-store.ts'

/**
 * Direct unit tests for the trust layer's allowlist policy/operations (Fix
 * C split): rule matching, grant (upsert + provenance audit), revoke (+
 * audit), and listing, exercised against a real `TrustStore` — no registry,
 * no `ApprovalCardPort`, no decide()/resolve() machinery. `trust-layer.test
 * .ts`'s "decision matrix" and "allowlist management" suites cover how
 * `TrustLayer` itself wires into this (the matching gate at decide()-time,
 * the grant trigger on an approved checkbox) — moved here (Fix C) is
 * everything that needed no more than a `TrustStore` to prove.
 */

let rootDir: string
let store: TrustStore
let allowlist: TrustAllowlist

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-trust-allowlist-'))
  store = new TrustStore(rootDir)
  allowlist = new TrustAllowlist(store)
})

afterEach(() => {
  store.dispose()
  rmSync(rootDir, { recursive: true, force: true })
})

interface GrantParams {
  toolName: string
  allowlistParams: Record<string, string>
  approvalId: string
  nowIso: string
  finalInput: unknown
  level: 'L1'
  effectiveOrigin: Origin
  originChain: Origin[]
  trigger?: TriggerRef
  contextHash: string
  spaceId?: string
}

function grantParams(overrides: Partial<GrantParams> = {}): GrantParams {
  return {
    toolName: 'send_message',
    allowlistParams: { to: 'alice@example.com' },
    approvalId: 'effect-1',
    nowIso: '2026-07-10T12:00:00.000Z',
    finalInput: { to: 'alice@example.com', body: 'hi' },
    level: 'L1',
    effectiveOrigin: 'trusted:user',
    originChain: ['trusted:user'],
    contextHash: 'hash-1',
    spaceId: 'spc-test',
    ...overrides,
  }
}

describe('matchingRuleId', () => {
  it('is undefined with no rule, the rule id once granted, undefined again once revoked', () => {
    expect(allowlist.matchingRuleId('send_message', { to: 'alice@example.com' })).toBeUndefined()
    const id = allowlist.grant(grantParams())
    expect(allowlist.matchingRuleId('send_message', { to: 'alice@example.com' })).toBe(id)
    allowlist.revoke(id, '2026-07-10T12:05:00.000Z')
    expect(allowlist.matchingRuleId('send_message', { to: 'alice@example.com' })).toBeUndefined()
  })

  it('does not match a different tool name or different params', () => {
    allowlist.grant(grantParams())
    expect(allowlist.matchingRuleId('transfer_funds', { to: 'alice@example.com' })).toBeUndefined()
    expect(allowlist.matchingRuleId('send_message', { to: 'bob@example.com' })).toBeUndefined()
  })
})

describe('grant', () => {
  it('creates the rule and audits allowlist.created with full provenance and the approved input (Fix 5/Fix B)', () => {
    const trigger: TriggerRef = { kind: 'chat', summary: 'user asked to email alice' }
    const id = allowlist.grant(
      grantParams({ trigger, contextHash: 'hash-provenance', originChain: ['trusted:user'] }),
    )
    expect(typeof id).toBe('number')

    const [entry] = store.auditEntries(50)
    expect(entry?.kind).toBe('allowlist.created')
    expect(entry?.refId).toBe('effect-1')
    expect(entry?.allowlistRuleId).toBe(id)
    expect(entry?.toolName).toBe('send_message')
    expect(entry?.level).toBe('L1')
    expect(entry?.effectiveOrigin).toBe('trusted:user')
    expect(entry?.originChain).toEqual(['trusted:user'])
    expect(entry?.trigger).toEqual(trigger)
    expect(entry?.contextHash).toBe('hash-provenance')
    expect(entry?.spaceId).toBe('spc-test')
    // Fix B: the approved final input, not just the match params in `detail`.
    expect(entry?.input).toEqual({ to: 'alice@example.com', body: 'hi' })
    expect(entry?.detail).toBe(JSON.stringify({ to: 'alice@example.com' }))
  })

  it('is idempotent for an identical active rule: same id, no second allowlist.created row', () => {
    const first = allowlist.grant(grantParams())
    const second = allowlist.grant(grantParams({ approvalId: 'effect-2' }))
    expect(second).toBe(first)
    expect(store.auditEntries(50).filter((e) => e.kind === 'allowlist.created')).toHaveLength(1)
  })
})

describe('list', () => {
  it('returns every granted rule', () => {
    allowlist.grant(grantParams())
    allowlist.grant(grantParams({ toolName: 'transfer_funds', allowlistParams: { to: 'bob' } }))
    expect(allowlist.list()).toHaveLength(2)
  })
})

describe('revoke', () => {
  it('sets revoked_at, audits allowlist.revoked with the user actor and the given Space, and returns the revoked rule', () => {
    const id = allowlist.grant(grantParams())

    const revoked = allowlist.revoke(id, '2026-07-10T12:05:00.000Z')

    expect(revoked?.id).toBe(id)
    expect(revoked?.revokedAt).toBe('2026-07-10T12:05:00.000Z')
    const entry = store.auditEntries(50).find((e) => e.kind === 'allowlist.revoked')
    expect(entry?.allowlistRuleId).toBe(id)
    expect(entry?.toolName).toBe('send_message')
    expect(entry?.detail).toBe(JSON.stringify({ to: 'alice@example.com' }))
    expect(entry?.approvedBy).toBe('trusted:user')
    expect(entry?.spaceId).toBe('spc-system')
  })

  it('revoking an already-revoked or unknown rule id is a no-op: undefined, no additional audit row', () => {
    const id = allowlist.grant(grantParams())
    allowlist.revoke(id, '2026-07-10T12:05:00.000Z')

    expect(allowlist.revoke(id, '2026-07-10T12:06:00.000Z')).toBeUndefined()
    expect(allowlist.revoke(9999, '2026-07-10T12:06:00.000Z')).toBeUndefined()
    expect(store.auditEntries(50).filter((e) => e.kind === 'allowlist.revoked')).toHaveLength(1)
  })
})
