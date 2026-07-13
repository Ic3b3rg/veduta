import { randomUUID } from 'node:crypto'
import { type ApprovalCard, ApprovalCardSchema } from '@veduta/protocol'
import type { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult, TriggerRef } from './agent-runner.ts'
import { effectiveOrigin, hasUntrusted, type Origin, TurnTaintAccumulator } from './taint.ts'
import { TrustAllowlist } from './trust-allowlist.ts'
import {
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  fieldStateKey,
  RESERVED_DECISION_KEYS,
  type AllowlistRule,
  type ApprovalCardModel,
  type ApprovalCardPort,
  type AuditEntry,
  type AuditOutcome,
  type OutcomeEventPayload,
  type PendingApproval,
  type PendingApprovalRecord,
  type ToolMeta,
  type TrustDecision,
  type TrustLayerOptions,
} from './trust-contracts.ts'
import {
  pendingApprovalFromRow,
  rowProvenance,
  TrustStore,
  type ApprovalRow,
} from './trust-store.ts'

/**
 * The trust layer (issue #14, ADR-0007, docs/SECURITY.md §2/§3.2/§5): the
 * code-level decision authority for every L1/L2 tool call. `decide()` is the
 * single place that turns a tool call into `allowed | card | denied` — never
 * the prompt. This module is the policy facade: the tool registry,
 * `decide()`, wrapping (D5), the resolve/claim flow (D6/A4), and boot/TTL
 * recovery orchestration (D7/A2). The durable state machine itself
 * (`trust.sqlite`'s schema, row codecs, and repository operations) lives in
 * `trust-store.ts` (`TrustStore`) — this module owns *what* gets decided and
 * *when* a transaction runs; `TrustStore` owns *how* it is persisted.
 *
 * Every public type this module's callers depend on (`ToolMeta`,
 * `PendingApproval`, `ApprovalCardModel`, `AllowlistRule`, `AuditEntry`,
 * `TrustDecision`, the reserved state-key constants, `fieldStateKey`,
 * `canonicalAllowlistParams`, ...) is defined in `trust-contracts.ts` and
 * re-exported here, so `approval-surface.ts` / `allowlist-surface.ts` /
 * `audit-surface.ts` / `server.ts` / tests need no import-path changes.
 *
 * Persistence is the single source of truth for provenance: every row that
 * can lead to an effect stores the decision-time taint snapshot, trigger,
 * and context hash (BINDING amendment A1) so a crash, a slow human, or a
 * boot recovery all see exactly what the model saw when the call was made.
 */

export type {
  AllowlistRule,
  ApprovalCardModel,
  ApprovalCardPort,
  ApprovalStatus,
  AuditEntry,
  AuditKind,
  AuditOutcome,
  OutcomeEventPayload,
  PendingApproval,
  PendingApprovalRecord,
  ToolMeta,
  TrustDecision,
  TrustLayerOptions,
} from './trust-contracts.ts'
export {
  canonicalAllowlistParams,
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  DECISION_APPROVE_KEY,
  DECISION_REJECT_KEY,
  fieldStateKey,
} from './trust-contracts.ts'

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

// ---------------------------------------------------------------------------
// Wrap marker (D5) — module-private so a hand-built `{...tool, trustWrapped:
// true}` object can never forge admission through `gateToolsForOrigins`.
// ---------------------------------------------------------------------------

const wrappedTools = new WeakSet<ToolDef>()

export function isTrustWrapped(tool: ToolDef): boolean {
  return wrappedTools.has(tool)
}

interface RegistryEntry {
  tool: ToolDef
  meta: ToolMeta<unknown>
}

export class TrustLayer {
  private readonly store: TrustStore
  /** Allowlist policy/operations (Fix C) — the claim/resolve/recovery state machine below stays here deliberately (see the module doc comment). */
  private readonly allowlist: TrustAllowlist
  private readonly now: () => Date
  private readonly ttlMs: number
  private readonly sweepIntervalMs: number
  private readonly port: ApprovalCardPort
  private readonly onApprovalCardCallback: (card: ApprovalCard) => void
  private readonly appendOutcomeEventCallback: (
    spaceId: string,
    payload: OutcomeEventPayload,
  ) => void
  private readonly hasOutcomeEventCallback:
    ((spaceId: string, effectId: string) => boolean) | undefined
  private readonly onSystemNotice: ((text: string) => void) | undefined
  private readonly registry = new Map<string, RegistryEntry>()
  private readonly changeListeners = new Set<() => void>()
  private sweepTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(options: TrustLayerOptions) {
    this.store = new TrustStore(options.rootDir)
    this.allowlist = new TrustAllowlist(this.store)
    this.now = options.now ?? (() => new Date())
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.port = options.approvalCardPort
    this.onApprovalCardCallback = options.onApprovalCard
    this.appendOutcomeEventCallback = options.appendOutcomeEvent
    this.hasOutcomeEventCallback = options.hasOutcomeEvent
    this.onSystemNotice = options.onSystemNotice
  }

  // -- Registry (D2) ---------------------------------------------------

  /**
   * Registers the durable, canonical `ToolDef` for one L1/L2 tool. This is
   * the handler that always runs — for the immediate `allowed` path, for a
   * later `resolve()` approval, and on crash recovery — so `register` must
   * be called with the tool's real, long-lived implementation, not a
   * per-turn closure. `wrapTools` looks the tool up by name and wraps it;
   * the wrapped handler always executes `registry.get(name).tool.handler`.
   *
   * Throws on: duplicate name; an `L0` tool declaring non-empty
   * `egressDomains` (ADR-0007: everything that leaves the daemon defaults
   * to L1); an `editableKeys` entry that is not a simple identifier or
   * that collides with a reserved decision key.
   */
  register<TSchema extends z.ZodTypeAny>(
    tool: ToolDef<TSchema>,
    meta: ToolMeta<z.infer<TSchema>>,
  ): void {
    if (this.registry.has(tool.name)) {
      throw new Error(`trust layer: duplicate tool registration "${tool.name}"`)
    }
    if (tool.level === 'L0' && tool.egressDomains.length > 0) {
      throw new Error(
        `trust layer: L0 tool "${tool.name}" declares egress domains — everything that leaves ` +
          'the daemon defaults to L1 (ADR-0007)',
      )
    }
    for (const key of meta.editableKeys ?? []) {
      if (!IDENTIFIER_RE.test(key)) {
        throw new Error(
          `trust layer: editable key "${key}" on "${tool.name}" is not a simple identifier`,
        )
      }
      if (RESERVED_DECISION_KEYS.has(key)) {
        throw new Error(
          `trust layer: editable key "${key}" on "${tool.name}" collides with a reserved decision key`,
        )
      }
    }
    this.registry.set(tool.name, { tool: tool as ToolDef, meta: meta as ToolMeta<unknown> })
  }

  // -- Wrapping (D5) ----------------------------------------------------

  /**
   * Returns `tools` with every registered L1/L2 tool replaced by a wrapped
   * `ToolDef` whose handler runs `decide()` before any effect. `L0` tools
   * and unregistered L1/L2 tools pass through unchanged — the latter are
   * then stripped by `gateToolsForOrigins`'s wrapped regime, since
   * `isTrustWrapped` is false for them: nothing reaches the model without
   * either `L0` or a trust wrapper.
   */
  wrapTools(tools: ToolDef[]): ToolDef[] {
    return tools.map((tool) => {
      if (tool.level === 'L0') return tool
      if (!this.registry.has(tool.name)) return tool
      return this.wrapOne(tool)
    })
  }

  private wrapOne(tool: ToolDef): ToolDef {
    const toolName = tool.name
    const wrapped: ToolDef = {
      ...tool,
      handler: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
        const decision = this.decide(toolName, input, context)
        const entry = this.registry.get(toolName)
        if (decision.outcome === 'denied' || !entry) {
          return this.denyResult(decision.reason ?? 'tool is not registered with the trust layer')
        }
        if (decision.outcome === 'allowed') {
          return this.executeAllowed(entry, input, context, decision)
        }
        return this.createCard(entry, input, context, decision)
      },
    }
    wrappedTools.add(wrapped)
    return wrapped
  }

  private denyResult(reason: string): ToolResult {
    return { content: `This action was denied: ${reason}.` }
  }

  // -- Decision (D3, A1) -------------------------------------------------

  /**
   * The single decision authority (code, not prompt — SECURITY.md §3.2).
   * Always snapshots `context.taint.origins()` at this moment (A1): that
   * snapshot, not any pre-turn chain, is what gets persisted, audited, and
   * checked for allowlist eligibility everywhere downstream. Always appends
   * an `action.decision` audit row before returning — including for
   * `denied`, so every call the model attempts is on the record.
   */
  decide(toolName: string, input: unknown, context: ToolContext): TrustDecision {
    const effectId = randomUUID()
    const entry = this.registry.get(toolName)
    const snapshot = context.taint.origins()
    const effOrigin = effectiveOrigin(snapshot, context.origin)

    if (!entry) {
      return this.recordDecision({
        outcome: 'denied',
        effectId,
        toolName,
        level: undefined,
        input,
        effectiveOrigin: effOrigin,
        snapshot,
        context,
        reason: 'tool is not registered with the trust layer',
      })
    }

    const level = entry.tool.level
    if (level !== 'L1' && level !== 'L2') {
      return this.recordDecision({
        outcome: 'denied',
        effectId,
        toolName,
        level: undefined,
        input,
        effectiveOrigin: effOrigin,
        snapshot,
        context,
        reason: 'trust layer only decides on L1/L2 tools',
      })
    }

    const untainted = !hasUntrusted(snapshot)
    // A1: when the snapshot carries no untrusted origin, `context.origin`
    // (fixed at turn start as the most-untrusted of prompt/context/session
    // origins — agent-runner.ts) degenerates to exactly the prompt's own
    // origin. So this doubles as the "prompt-origin trusted:user" check
    // without needing a separate field on ToolContext.
    const promptWasUser = context.origin === 'trusted:user'
    const allowlistParams = entry.meta.allowlistParams
    const canConsultAllowlist =
      level === 'L1' && untainted && promptWasUser && allowlistParams !== undefined
    const matchedRuleId =
      canConsultAllowlist && allowlistParams
        ? this.allowlist.matchingRuleId(toolName, allowlistParams(input))
        : undefined
    const wouldAllow = canConsultAllowlist && matchedRuleId !== undefined

    if (!wouldAllow && context.spaceId === undefined) {
      return this.recordDecision({
        outcome: 'denied',
        effectId,
        toolName,
        level,
        input,
        effectiveOrigin: effOrigin,
        snapshot,
        context,
        reason: 'a Space is required to create an approval card',
      })
    }

    return this.recordDecision({
      outcome: wouldAllow ? 'allowed' : 'card',
      effectId,
      toolName,
      level,
      input,
      effectiveOrigin: effOrigin,
      snapshot,
      context,
      ...(wouldAllow ? { allowlistRuleId: matchedRuleId } : {}),
    })
  }

  private recordDecision(params: {
    outcome: 'allowed' | 'card' | 'denied'
    effectId: string
    toolName: string
    level: 'L1' | 'L2' | undefined
    input: unknown
    effectiveOrigin: Origin
    snapshot: Origin[]
    context: ToolContext
    reason?: string
    allowlistRuleId?: number
  }): TrustDecision {
    this.store.insertAudit(
      {
        kind: 'action.decision',
        refId: params.effectId,
        toolName: params.toolName,
        ...(params.level !== undefined ? { level: params.level } : {}),
        decision: params.outcome,
        effectiveOrigin: params.effectiveOrigin,
        originChain: params.snapshot,
        ...(params.context.trigger !== undefined ? { trigger: params.context.trigger } : {}),
        contextHash: params.context.contextHash,
        input: params.input,
        ...(params.reason !== undefined ? { detail: params.reason } : {}),
        ...(params.context.spaceId !== undefined ? { spaceId: params.context.spaceId } : {}),
        ...(params.allowlistRuleId !== undefined
          ? { allowlistRuleId: params.allowlistRuleId }
          : {}),
      },
      this.nowIso(),
    )
    this.notifyChange()
    return {
      outcome: params.outcome,
      effectId: params.effectId,
      toolName: params.toolName,
      ...(params.level !== undefined ? { level: params.level } : {}),
      effectiveOrigin: params.effectiveOrigin,
      snapshot: params.snapshot,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    }
  }

  // -- Allow path (A2: durable execution row, same state machine) -------

  private async executeAllowed(
    entry: RegistryEntry,
    input: unknown,
    context: ToolContext,
    decision: TrustDecision,
  ): Promise<ToolResult> {
    const effectId = decision.effectId
    const nowIso = this.nowIso()
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString()
    this.store.insertApprovalRow(
      {
        id: effectId,
        toolName: entry.tool.name,
        level: entry.tool.level as 'L1' | 'L2', // wrapOne never wraps L0 tools
        input,
        effectiveOrigin: decision.effectiveOrigin,
        originChain: decision.snapshot,
        ...(context.trigger !== undefined ? { trigger: context.trigger } : {}),
        contextHash: context.contextHash,
        toolCallId: context.toolCallId,
        ...(context.spaceId !== undefined ? { spaceId: context.spaceId } : {}),
        createdAt: nowIso,
        expiresAt,
      },
      'executing',
    )
    this.notifyChange()

    const contextWithEffect: ToolContext = { ...context, effectId }
    const finalized = await this.executeAndFinalize(
      effectId,
      entry,
      input,
      contextWithEffect,
      context.spaceId,
    )
    if (finalized.outcome === 'error') throw new Error(finalized.detail ?? 'tool execution failed')
    return finalized.result as ToolResult
  }

  // -- Card path (D4/D8) -------------------------------------------------

  private createCard(
    entry: RegistryEntry,
    input: unknown,
    context: ToolContext,
    decision: TrustDecision,
  ): ToolResult {
    const spaceId = context.spaceId
    if (spaceId === undefined) {
      // decide() already denies before this branch when spaceId is missing.
      throw new Error('trust layer: createCard requires a spaceId')
    }
    const level = entry.tool.level as 'L1' | 'L2' // wrapOne never wraps L0 tools
    const effectId = decision.effectId
    const nowIso = this.nowIso()
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString()

    this.store.insertApprovalRow(
      {
        id: effectId,
        toolName: entry.tool.name,
        level,
        input,
        effectiveOrigin: decision.effectiveOrigin,
        originChain: decision.snapshot,
        ...(context.trigger !== undefined ? { trigger: context.trigger } : {}),
        contextHash: context.contextHash,
        toolCallId: context.toolCallId,
        spaceId,
        createdAt: nowIso,
        expiresAt,
      },
      'pending',
    )
    this.notifyChange()

    const pending: PendingApproval = {
      id: effectId,
      toolName: entry.tool.name,
      level,
      input,
      effectiveOrigin: decision.effectiveOrigin,
      originChain: decision.snapshot,
      ...(context.trigger !== undefined ? { trigger: context.trigger } : {}),
      contextHash: context.contextHash,
      toolCallId: context.toolCallId,
      spaceId,
      createdAt: nowIso,
      expiresAt,
    }
    const cardModel = this.buildCardModel(
      entry,
      input,
      level,
      decision.effectiveOrigin,
      decision.snapshot,
      context.trigger,
      expiresAt,
    )
    const { surfaceId } = this.port.create(pending, cardModel)
    this.store.setSurfaceId(effectId, surfaceId)
    this.notifyChange()

    const card = ApprovalCardSchema.parse({
      id: effectId,
      level,
      title: cardModel.title,
      body: cardModel.summary,
      actionLabel: 'Review',
      createdAt: nowIso,
      surfaceId,
      expiresAt,
    })
    this.onApprovalCardCallback(card)

    return {
      content: 'This action needs your approval; the outcome will arrive as a Space event.',
      details: { effectId, surfaceId },
    }
  }

  /**
   * The `ApprovalCardModel` for one call, given only the decision-time
   * facts a persisted row itself carries (D4/D7): shared by `createCard()`
   * (the live decision) and `listPending()` (recomputed on boot for
   * rehydration), so both ever derive `showAllowlistCheckbox` the exact
   * same way. `effectiveOrigin === 'trusted:user'` stands in for the live
   * `context.origin === 'trusted:user'` check the original decision made —
   * equivalent because `effectiveOrigin` only ever equals a non-untrusted
   * `context.origin` when `originChain` itself is untainted (taint.ts's
   * `effectiveOrigin`), which is exactly the other half of this AND.
   */
  private buildCardModel(
    entry: RegistryEntry,
    input: unknown,
    level: 'L1' | 'L2',
    effectiveOrigin: Origin,
    originChain: Origin[],
    trigger: TriggerRef | undefined,
    expiresAt: string,
  ): ApprovalCardModel {
    const editableKeys = entry.meta.editableKeys ?? []
    const inputRecord = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >
    const editableFields = editableKeys.map((key) => ({ key, value: inputRecord[key] }))
    const showAllowlistCheckbox =
      level === 'L1' &&
      entry.meta.allowlistParams !== undefined &&
      !hasUntrusted(originChain) &&
      effectiveOrigin === 'trusted:user'
    return {
      title: entry.meta.title(input),
      summary: entry.meta.summary(input),
      level,
      effectiveOrigin,
      ...(trigger !== undefined ? { trigger } : {}),
      expiresAt,
      editableFields,
      showAllowlistCheckbox,
    }
  }

  /**
   * Every still-pending, not-yet-expired approval (D7): what
   * `ApprovalSurfaceManager.start()` walks to repair any card Surface that
   * didn't survive a restart (`hasPendingCardSurface` is what makes a
   * click resolve correctly regardless of whether `start()` has run — see
   * Fix A). Must be consulted only after `start()`'s own `recoverAtBoot()`
   * — a row whose tool vanished or whose TTL had already passed is expired
   * there first, so this never has to re-decide that; a row whose tool is
   * no longer registered here (a caller that skipped that ordering) is
   * defensively excluded rather than surfaced with a card model it cannot
   * compute.
   */
  listPending(): PendingApprovalRecord[] {
    const nowIso = this.nowIso()
    return this.store.listPendingNotExpired(nowIso).flatMap((row) => {
      const entry = this.registry.get(row.toolName)
      if (!entry || row.spaceId === undefined) return []
      const approval = pendingApprovalFromRow(row, row.spaceId)
      const card = this.buildCardModel(
        entry,
        approval.input,
        row.level,
        row.effectiveOrigin,
        approval.originChain,
        approval.trigger,
        row.expiresAt,
      )
      return [
        { approval, card, ...(row.surfaceId !== undefined ? { surfaceId: row.surfaceId } : {}) },
      ]
    })
  }

  /**
   * Recovery-only (D7): persists the `surface_id` `ApprovalSurfaceManager
   * .start()` just recreated for a still-pending row whose original
   * `createCard()` crashed between inserting the row and recording one.
   * Guarded by `surface_id is null` so it can never clobber a value that
   * was, in fact, already recorded.
   */
  attachSurfaceId(id: string, surfaceId: string): void {
    this.store.attachSurfaceIdIfMissing(id, surfaceId)
    this.notifyChange()
  }

  /**
   * The source of truth `ApprovalSurfaceManager.handleFastMutation` checks
   * before resolving a click (Fix A, boot-rehydration race; narrowed by the
   * issue #14 review fix): true only if `approvalId` is still pending AND
   * its row's own `surface_id` is already recorded AND matches `surfaceId`
   * exactly. A row whose `surface_id` is still `null` (D7: `createCard()`
   * crashed before recording one) never accepts a click — accepting it
   * regardless of `surfaceId` would let a forged canonical-looking Surface
   * (any Surface at `srf-approval-<id>`, daemon-owned or not) drive a
   * decision for an approval whose real card was never attached. Such a row
   * only becomes clickable once `ApprovalSurfaceManager.start()`'s repair
   * pass recreates the canonical card and calls `attachSurfaceId` — after
   * which this check is a plain equality, independent of whether `start()`
   * has run (the original Fix A guarantee is preserved for the normal case:
   * a row whose `surface_id` was already set synchronously by `createCard()`
   * resolves correctly the instant the daemon can reach the store).
   */
  hasPendingCardSurface(approvalId: string, surfaceId: string): boolean {
    const row = this.store.getRawRow(approvalId)
    if (!row || row.status !== 'pending') return false
    return row.surfaceId === surfaceId
  }

  // -- Resolution (D6, A4) -----------------------------------------------

  /**
   * Called by T6's fast-mutation observer when a human clicks Approve/Reject
   * on a card Surface. Exactly-once by construction: everything up to and
   * including the claim transaction is synchronous JS (no `await`), so two
   * concurrent calls cannot interleave before the first reaches its atomic
   * `UPDATE ... WHERE status = 'pending'` — the loser's claim affects zero
   * rows and it returns without any side effect.
   */
  async resolve(approvalId: string, decision: 'approve' | 'reject'): Promise<void> {
    const row = this.store.getRawRow(approvalId)
    if (!row) throw new Error(`trust layer: unknown approval "${approvalId}"`)
    if (row.status !== 'pending') return // already decided/claimed — exactly-once no-op

    if (decision === 'reject') {
      this.claimAndReject(row)
      return
    }
    await this.claimAndApprove(row)
  }

  private claimAndReject(row: ApprovalRow): void {
    const nowIso = this.nowIso()
    let claimed = false
    this.store.runInTransaction(() => {
      claimed = this.store.claimRejected(row.id, nowIso)
      if (!claimed) return
      const provenance = rowProvenance(row)
      this.store.insertAudit(
        {
          kind: 'action.outcome',
          refId: row.id,
          toolName: row.toolName,
          level: row.level,
          outcome: 'rejected',
          approvedBy: 'trusted:user',
          effectiveOrigin: provenance.effectiveOrigin,
          originChain: provenance.originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          input: provenance.input,
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        },
        nowIso,
      )
    })
    if (!claimed) {
      this.handleLostClaim(row, nowIso)
      return
    }
    if (row.surfaceId !== undefined) this.port.archive(row.surfaceId)
    this.appendOutcomeEventIfNeeded(row.id, row.toolName, 'rejected', row.spaceId)
    this.notifyChange()
  }

  private async claimAndApprove(row: ApprovalRow): Promise<void> {
    const entry = this.registry.get(row.toolName)
    if (!entry)
      throw new Error(
        `trust layer: cannot approve — tool "${row.toolName}" is no longer registered`,
      )
    if (row.surfaceId === undefined)
      throw new Error(`trust layer: approval "${row.id}" has no card surface`)

    const provenance = rowProvenance(row)
    const editedState = this.port.readEditedFields(row.surfaceId)
    const originalInput = provenance.input as Record<string, unknown>
    const editableKeys = entry.meta.editableKeys ?? []
    const mergedInput = { ...originalInput, ...extractEditedInput(editedState, editableKeys) }
    const validated = entry.tool.schema.safeParse(mergedInput)

    if (!validated.success) {
      const message = validated.error.message
      this.port.patchValidationError(row.surfaceId, message)
      this.store.insertAudit(
        {
          kind: 'approval.edit_rejected',
          refId: row.id,
          toolName: row.toolName,
          level: row.level,
          detail: message,
          effectiveOrigin: provenance.effectiveOrigin,
          originChain: provenance.originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          input: mergedInput,
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        },
        this.nowIso(),
      )
      this.notifyChange()
      return
    }

    const finalInput: unknown = validated.data
    const nowIso = this.nowIso()
    const originChain = provenance.originChain
    // Re-checked against the decision-time snapshot (A1/A4), not recomputed
    // from any live state: the grant is only as trustworthy as what the
    // model actually saw when the call was made.
    const eligible = !hasUntrusted(originChain) && row.effectiveOrigin === 'trusted:user'
    const wantsAllowlist = editedState[DECISION_ALLOWLIST_CHECKBOX_KEY] === true
    const allowlistParams = entry.meta.allowlistParams
    const grantAllowlist =
      wantsAllowlist && eligible && row.level === 'L1' && allowlistParams !== undefined

    let claimed = false
    let allowlistRuleId: number | undefined
    this.store.runInTransaction(() => {
      claimed = this.store.claimExecuting(row.id, nowIso, JSON.stringify(finalInput))
      if (!claimed) return

      if (grantAllowlist && allowlistParams && row.level === 'L1') {
        allowlistRuleId = this.allowlist.grant({
          toolName: row.toolName,
          allowlistParams: allowlistParams(finalInput),
          approvalId: row.id,
          nowIso,
          finalInput,
          level: row.level,
          effectiveOrigin: provenance.effectiveOrigin,
          originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        })
      }

      this.store.insertAudit(
        {
          kind: 'approval.decided',
          refId: row.id,
          toolName: row.toolName,
          level: row.level,
          decision: 'approved',
          effectiveOrigin: provenance.effectiveOrigin,
          originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          input: finalInput,
          approvedBy: 'trusted:user',
          ...(allowlistRuleId !== undefined ? { allowlistRuleId } : {}),
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        },
        nowIso,
      )
    })

    if (!claimed) {
      this.handleLostClaim(row, nowIso)
      return
    }
    this.notifyChange()
    if (row.surfaceId !== undefined) this.port.archive(row.surfaceId)

    const context = this.rebuildContext({ ...row, inputJson: JSON.stringify(finalInput) })
    await this.executeAndFinalize(row.id, entry, finalInput, context, row.spaceId)
  }

  /** Claim failed: either a concurrent resolve won (no-op), or the card expired first-hand. */
  private handleLostClaim(row: ApprovalRow, nowIso: string): void {
    const current = this.store.getRawRow(row.id)
    if (current && current.status === 'pending' && current.expiresAt <= nowIso) {
      this.expirePending(current)
    }
    // Otherwise: another resolve already claimed it — exactly-once, no-op.
  }

  // -- Shared execution/finalization (A2) --------------------------------

  /**
   * Runs the registered handler and finalizes the durable row in one
   * transaction: status -> 'approved' (the decision was to run it, whether
   * auto-allowed or human-approved; success/failure is recorded separately
   * in the `action.outcome` audit row's `outcome`), plus the outcome audit
   * row (unique per effectId). Never throws — callers decide whether to
   * surface the error (the immediate `allow` path rethrows; `resolve()` and
   * recovery do not, since nothing is awaiting them).
   */
  private async executeAndFinalize(
    effectId: string,
    entry: RegistryEntry,
    input: unknown,
    context: ToolContext,
    spaceId: string | undefined,
    recovering = false,
  ): Promise<{ result?: ToolResult; outcome: AuditOutcome; detail?: string }> {
    let result: ToolResult | undefined
    let outcome: AuditOutcome = 'executed'
    let detail: string | undefined
    try {
      result = await entry.tool.handler(input, context)
    } catch (error) {
      outcome = 'error'
      detail = error instanceof Error ? error.message : String(error)
    }
    const nowIso = this.nowIso()
    this.store.runInTransaction(() => {
      this.store.markApproved(effectId)
      this.store.insertAudit(
        {
          kind: 'action.outcome',
          refId: effectId,
          toolName: entry.tool.name,
          level: entry.tool.level as 'L1' | 'L2',
          outcome,
          ...(detail !== undefined ? { detail } : {}),
          ...(spaceId !== undefined ? { spaceId } : {}),
        },
        nowIso,
      )
    })
    this.appendOutcomeEventIfNeeded(effectId, entry.tool.name, outcome, spaceId, recovering)
    this.notifyChange()
    return {
      outcome,
      ...(result !== undefined ? { result } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }

  /**
   * Idempotent outcome event (A2): appended once, `outcome_event_at` guards
   * recovery re-runs. `recovering` (Fix 6) additionally guards the window
   * between appending this event and persisting `outcome_event_at`: only
   * recovery's own re-finalization of a row it is replaying passes it,
   * since only recovery can revisit a row whose event may already have
   * landed in the Space log in a crashed-out prior attempt. When it does,
   * a match against the persisted log skips the append and still marks
   * the row done, so the event is never doubled.
   */
  private appendOutcomeEventIfNeeded(
    effectId: string,
    toolName: string,
    outcome: AuditOutcome,
    spaceId: string | undefined,
    recovering = false,
  ): void {
    if (spaceId === undefined) return
    const row = this.store.getRawRow(effectId)
    if (!row || row.outcomeEventAt !== undefined) return
    const alreadyLogged = recovering && (this.hasOutcomeEventCallback?.(spaceId, effectId) ?? false)
    if (!alreadyLogged) {
      this.appendOutcomeEventCallback(spaceId, {
        approvalId: effectId,
        effectId,
        tool: toolName,
        outcome,
      })
    }
    this.store.setOutcomeEventAt(effectId, this.nowIso())
  }

  // -- Expiry + recovery (D7, A2) -----------------------------------------

  /**
   * Boot recovery, then arms the periodic sweep. Async because recovery may
   * re-run idempotent handlers for interrupted `executing` rows.
   */
  async start(): Promise<void> {
    await this.recoverAtBoot()
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  /** Idempotent: safe to call more than once (e.g. an explicit dispose in a test plus a suite-wide teardown). */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    if (this.disposed) return
    this.disposed = true
    this.store.dispose()
  }

  private async recoverAtBoot(): Promise<void> {
    const nowIso = this.nowIso()
    for (const row of this.store.listByStatus('pending')) {
      if (!this.registry.has(row.toolName)) {
        this.expirePending(row, 'tool no longer registered', true)
      } else if (row.expiresAt <= nowIso) {
        this.expirePending(row, undefined, true)
      }
    }

    for (const row of this.store.listByStatus('executing')) {
      const entry = this.registry.get(row.toolName)
      if (!entry) {
        this.markIndeterminate(row)
        continue
      }
      // Executors are idempotent per effectId (documented contract, A2):
      // crash-before-transport -> runs once now; crash-after-transport ->
      // transport dedupes; crash-before-outcome-persist -> outcome appended now.
      const context = this.rebuildContext(row)
      await this.executeAndFinalize(
        row.id,
        entry,
        rowProvenance(row).input,
        context,
        row.spaceId,
        true,
      )
    }

    this.recoverLostOutcomeEvents()
  }

  /**
   * Fix 10 (residual gap from Fix 6): every terminal transition (approved,
   * rejected, expired, indeterminate) commits its status change and its
   * `action.outcome` audit row in one transaction, but the Space outcome
   * event itself is appended only after that transaction commits — so a
   * crash in the window between the two leaves a row whose fate is fully
   * decided and audited, yet whose Space event never went out, and
   * `recoverAtBoot`'s own pending/executing queries never revisit it (its
   * status is already terminal). This closes that gap: every terminal row
   * with `outcome_event_at is null` gets its outcome re-derived from its own
   * `action.outcome` audit row (inserted atomically with the status change,
   * so it is always present) and appended through the same
   * `appendOutcomeEventIfNeeded` dedupe recovery already relies on.
   */
  private recoverLostOutcomeEvents(): void {
    for (const row of this.store.listTerminalMissingOutcomeEvent()) {
      const outcome = this.store.terminalOutcomeFor(row.id)
      if (!outcome) continue // defensive: every terminal row's own transaction always inserts one
      this.appendOutcomeEventIfNeeded(row.id, row.toolName, outcome, row.spaceId, true)
    }
  }

  /** Public so tests (and an optional external cron) can drive the TTL sweep without waiting on the timer. */
  sweepExpired(): void {
    const nowIso = this.nowIso()
    for (const row of this.store.listExpiredPending(nowIso)) this.expirePending(row)
  }

  private expirePending(
    row: ApprovalRow,
    detail = 'approval expired before a decision was made',
    recovering = false,
  ): void {
    const nowIso = this.nowIso()
    let claimed = false
    this.store.runInTransaction(() => {
      claimed = this.store.claimExpired(row.id)
      if (!claimed) return
      const provenance = rowProvenance(row)
      this.store.insertAudit(
        {
          kind: 'action.outcome',
          refId: row.id,
          toolName: row.toolName,
          level: row.level,
          outcome: 'expired',
          detail,
          effectiveOrigin: provenance.effectiveOrigin,
          originChain: provenance.originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          input: provenance.input,
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        },
        nowIso,
      )
    })
    if (!claimed) return
    if (row.surfaceId !== undefined) this.port.archive(row.surfaceId)
    this.appendOutcomeEventIfNeeded(row.id, row.toolName, 'expired', row.spaceId, recovering)
    this.notifyChange()
  }

  /** A2: an interrupted `executing` row whose tool vanished — never silently stranded. Recovery-only (see call site). */
  private markIndeterminate(row: ApprovalRow): void {
    const nowIso = this.nowIso()
    let claimed = false
    this.store.runInTransaction(() => {
      claimed = this.store.claimIndeterminate(row.id)
      if (!claimed) return
      const provenance = rowProvenance(row)
      this.store.insertAudit(
        {
          kind: 'action.outcome',
          refId: row.id,
          toolName: row.toolName,
          level: row.level,
          outcome: 'error',
          detail: 'tool no longer registered',
          effectiveOrigin: provenance.effectiveOrigin,
          originChain: provenance.originChain,
          ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
          contextHash: provenance.contextHash,
          input: provenance.input,
          ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
        },
        nowIso,
      )
    })
    if (!claimed) return
    this.onSystemNotice?.(
      `Approval ${row.id} for tool "${row.toolName}" is stuck indeterminate: the tool is no ` +
        'longer registered. Manual review needed.',
    )
    // Only ever called from recoverAtBoot's executingRows loop (see below):
    // always the recovery case.
    this.appendOutcomeEventIfNeeded(row.id, row.toolName, 'error', row.spaceId, true)
    this.notifyChange()
  }

  private rebuildContext(row: ApprovalRow): ToolContext {
    const provenance = rowProvenance(row)
    return {
      toolCallId: row.toolCallId,
      origin: row.effectiveOrigin,
      origins: provenance.originChain,
      taint: new TurnTaintAccumulator(provenance.originChain),
      ...(row.spaceId !== undefined ? { spaceId: row.spaceId } : {}),
      ...(provenance.trigger !== undefined ? { trigger: provenance.trigger } : {}),
      contextHash: row.contextHash,
      effectId: row.id,
    }
  }

  // -- Allowlist management (D5/A5) — delegates to TrustAllowlist (Fix C) --

  listAllowlistRules(): AllowlistRule[] {
    return this.allowlist.list()
  }

  /** See `TrustAllowlist.revoke` for the actor/Space/transactionality rationale. */
  revokeAllowlistRule(id: number): void {
    const revoked = this.allowlist.revoke(id, this.nowIso())
    if (!revoked) return
    this.notifyChange()
  }

  // -- Audit surface support (T7) ------------------------------------------

  auditEntries(limit = 200): AuditEntry[] {
    return this.store.auditEntries(limit)
  }

  /** Simplest refresh mechanism for T7 surfaces: subscribe, re-render on every mutation. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener()
  }

  // -- Internals ------------------------------------------------------------

  private nowIso(): string {
    return this.now().toISOString()
  }
}

function extractEditedInput(
  editedState: Record<string, unknown>,
  editableKeys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of editableKeys) {
    const stateKey = fieldStateKey(key)
    if (Object.prototype.hasOwnProperty.call(editedState, stateKey)) {
      result[key] = editedState[stateKey]
    }
  }
  return result
}
