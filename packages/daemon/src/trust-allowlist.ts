import type { TriggerRef } from './agent-runner.ts'
import type { Origin } from './taint.ts'
import { canonicalAllowlistParams, type AllowlistRule } from './trust-contracts.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import type { TrustStore } from './trust-store.ts'

/**
 * The trust layer's allowlist policy/operations (issue #14 review Fix C):
 * rule matching, grant (upsert + provenance audit), revoke (+ audit), and
 * listing — split out of the `TrustLayer` facade because these are
 * self-contained. Unlike the claim/resolve/recovery state machine `TrustLayer`
 * keeps (deliberately: see its own comment), nothing here needs to interleave
 * with that machine's control flow — `grant` is the one exception, and it is
 * written to compose into a caller's existing transaction exactly as
 * `TrustStore.upsertAllowlistRule` already supports (nested transactions,
 * Fix 7), so `TrustLayer.claimAndApprove` can call it from inside its own
 * `runInTransaction` without this module knowing anything about approvals,
 * cards, or claims.
 *
 * `TrustLayer.decide()` still owns *whether* an allowlist rule may even be
 * consulted (A1: untainted snapshot, `trusted:user` prompt origin, L1 level,
 * `allowlistParams` declared) and *whether* a grant is eligible on approve
 * (the same checks, re-verified against the decision-time snapshot, A4) —
 * this module only owns the mechanics once that policy decision is made.
 */
export class TrustAllowlist {
  private readonly store: TrustStore

  constructor(store: TrustStore) {
    this.store = store
  }

  /**
   * The id of the active rule covering this exact call shape, `undefined`
   * when none does. The caller decides whether it is even eligible to ask
   * (A1); the id lets the `allowed` decision audit row name the exact rule
   * that authorized it (SECURITY.md §5 trigger chain).
   */
  matchingRuleId(toolName: string, params: Record<string, string>): number | undefined {
    return this.store.findActiveAllowlistRule(toolName, canonicalAllowlistParams(params))?.id
  }

  list(): AllowlistRule[] {
    return this.store.listAllowlistRules()
  }

  /**
   * Upserts the rule and, only when newly created, audits its full
   * provenance (Fix 5): the same origin chain, trigger, context hash, Space,
   * and approval ref the accompanying `approval.decided` row carries, plus
   * the approved final input (Fix B) — a standing allowlist grant is exactly
   * as auditable as the single decision that authorized it. Must be called
   * from inside the caller's own transaction: the claim and this grant
   * commit atomically together (A4).
   */
  grant(params: {
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
  }): number {
    const paramsJson = canonicalAllowlistParams(params.allowlistParams)
    const { id, created } = this.store.upsertAllowlistRule(
      params.toolName,
      paramsJson,
      params.approvalId,
      params.nowIso,
    )
    if (created) {
      this.store.insertAudit(
        {
          kind: 'allowlist.created',
          refId: params.approvalId,
          allowlistRuleId: id,
          toolName: params.toolName,
          level: params.level,
          effectiveOrigin: params.effectiveOrigin,
          originChain: params.originChain,
          ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
          contextHash: params.contextHash,
          input: params.finalInput,
          detail: paramsJson,
          ...(params.spaceId !== undefined ? { spaceId: params.spaceId } : {}),
        },
        params.nowIso,
      )
    }
    return id
  }

  /**
   * Revocation always comes from the user's own fast action on the
   * allowlist Surface (never the Agent), so the audit row's actor is always
   * `trusted:user`, and its Space is always the System Space the allowlist
   * Surface itself lives in (`system-space.ts`) — this is not the rule's
   * originating Space, which the `allowlist.created` row already carries.
   * Transactional (Fix 5): the UPDATE and the audit insert commit together.
   * Returns the just-revoked rule, or `undefined` if `id` was unknown or
   * already revoked (the caller then skips notifying listeners).
   */
  revoke(id: number, nowIso: string): AllowlistRule | undefined {
    let revoked: AllowlistRule | undefined
    this.store.runInTransaction(() => {
      revoked = this.store.revokeAllowlistRuleRow(id, nowIso)
      if (!revoked) return
      this.store.insertAudit(
        {
          kind: 'allowlist.revoked',
          allowlistRuleId: id,
          toolName: revoked.toolName,
          detail: revoked.paramsJson,
          approvedBy: 'trusted:user',
          spaceId: SYSTEM_SPACE_ID,
        },
        nowIso,
      )
    })
    return revoked
  }
}
