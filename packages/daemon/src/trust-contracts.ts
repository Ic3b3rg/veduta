import type { ApprovalCard } from '@veduta/protocol'
import type { TriggerRef } from './agent-runner.ts'
import type { Origin } from './taint.ts'

/**
 * The trust layer's public contract (issue #14, ADR-0007, docs/SECURITY.md
 * §2/§3.2/§5): every type and constant a caller needs to register a tool,
 * build a decision, or read back the durable state, with no logic of its
 * own. `trust-store.ts` implements the durable state machine against these
 * shapes; `trust-layer.ts` implements the decision policy and re-exports
 * this module so every existing import path (`approval-surface.ts`,
 * `allowlist-surface.ts`, `audit-surface.ts`, `server.ts`, tests) is
 * unaffected by the split.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalStatus =
  'pending' | 'executing' | 'approved' | 'rejected' | 'expired' | 'indeterminate'

export type AuditKind =
  | 'action.decision'
  | 'approval.decided'
  | 'action.outcome'
  | 'approval.edit_rejected'
  | 'allowlist.created'
  | 'allowlist.revoked'

export type AuditOutcome = 'executed' | 'rejected' | 'expired' | 'error'

/** Registration metadata for one L1/L2 tool (D2). `TInput` is the tool's parsed input type. */
export interface ToolMeta<TInput = unknown> {
  /** Approval card title, computed from the (unedited) input. */
  title(input: TInput): string
  /** Approval card body/summary, computed from the (unedited) input. */
  summary(input: TInput): string
  /**
   * Bare identifiers (no `field.` prefix) the human may edit on the card
   * before approving. Rendered/bound as `field.<key>` state keys (D2).
   */
  editableKeys?: readonly string[]
  /**
   * Canonical shape of this call for allowlist matching (e.g. `{ to }` for
   * `send_message`). Absent means this tool can never be allowlisted —
   * every L1 call always cards.
   */
  allowlistParams?: (input: TInput) => Record<string, string>
}

/** A durable execution/approval row, as handed to the `ApprovalCardPort` (before a `surfaceId` exists). */
export interface PendingApproval {
  /** Stable, unique — doubles as the effectId threaded into `ToolContext.effectId`. */
  id: string
  toolName: string
  level: 'L1' | 'L2'
  input: unknown
  /** Decision-time taint snapshot's derived effective origin (A1). */
  effectiveOrigin: Origin
  /** Decision-time taint snapshot (A1) — the provenance truth for this approval, forever. */
  originChain: Origin[]
  trigger?: TriggerRef
  contextHash: string
  toolCallId: string
  spaceId: string
  createdAt: string
  expiresAt: string
}

/**
 * One still-pending, not-yet-expired approval plus its card model,
 * recomputed from the live registry exactly as `createCard()` computed it
 * originally — `listPending()`'s element type. `surfaceId` mirrors the
 * row's persisted column: `undefined` means the row's own card-creation
 * crashed before recording one (D7's rehydration gap `ApprovalSurfaceManager
 * .start()` closes).
 */
export interface PendingApprovalRecord {
  approval: PendingApproval
  card: ApprovalCardModel
  surfaceId?: string
}

/** Card-model data computed once at card-creation time (D4/D8, checkbox eligibility). */
export interface ApprovalCardModel {
  title: string
  summary: string
  level: 'L1' | 'L2'
  effectiveOrigin: Origin
  trigger?: TriggerRef
  expiresAt: string
  editableFields: readonly { key: string; value: unknown }[]
  /**
   * Whether "from now on approve like this" should render (D4/D8): the
   * eligibility computed here is UI-only — the actual grant is re-checked
   * against the decision-time snapshot inside the approve transaction (A4).
   */
  showAllowlistCheckbox: boolean
}

/**
 * Injected by T6 (`approval-surface.ts`): the trust layer must not import
 * surface modules directly, so card creation/mutation is abstracted here.
 * All methods are synchronous by contract — `resolve()`'s approve path
 * depends on `readEditedFields` being synchronous to keep the
 * claim-after-validate window free of `await` (exactly-once, A4).
 */
export interface ApprovalCardPort {
  create(approval: PendingApproval, card: ApprovalCardModel): { surfaceId: string }
  patchValidationError(surfaceId: string, message: string): void
  /** Current state of every `field.<key>` and `decision.allowlist` on the card Surface. */
  readEditedFields(surfaceId: string): Record<string, unknown>
  archive(surfaceId: string): void
}

/** Content-free outcome event payload (A2): `effectId` is the read-side dedupe key. */
export interface OutcomeEventPayload {
  approvalId: string
  effectId: string
  tool: string
  outcome: AuditOutcome
  [key: string]: string
}

export interface AllowlistRule {
  id: number
  toolName: string
  params: Record<string, string>
  paramsJson: string
  createdAt: string
  createdFromApprovalId: string
  revokedAt?: string
}

export interface AuditEntry {
  id: number
  at: string
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

export interface TrustDecision {
  outcome: 'allowed' | 'card' | 'denied'
  /** Correlates this decision with the pending/execution row and every later audit row (A1/A2). */
  effectId: string
  toolName: string
  level?: 'L1' | 'L2'
  effectiveOrigin: Origin
  snapshot: Origin[]
  reason?: string
}

export interface TrustLayerOptions {
  rootDir: string
  approvalCardPort: ApprovalCardPort
  /** Ephemeral chip notification (D13) — decision UI lives on the card Surface itself. */
  onApprovalCard: (card: ApprovalCard) => void
  /** Content-free Space event, made idempotent by `outcome_event_at` (A2). */
  appendOutcomeEvent: (spaceId: string, payload: OutcomeEventPayload) => void
  /**
   * Recovery-only duplicate check (A2/Fix 6): true if an `approval.outcome`
   * event carrying this `effectId` already exists in the Space's event
   * log. `appendOutcomeEvent` runs before `outcome_event_at` is persisted,
   * so a crash in between the two leaves a row recovery will revisit with
   * the event already durably appended; consulted only while replaying
   * recovery's own re-finalization, never on the live path, so it costs
   * nothing outside a crash's aftermath. Omitting it preserves the
   * pre-Fix-6 behavior (no recovery-time dedupe).
   */
  hasOutcomeEvent?: (spaceId: string, effectId: string) => boolean
  /** Recovery escalation for `indeterminate` rows (unregistered-tool crash recovery). */
  onSystemNotice?: (text: string) => void
  /** Approval TTL. Default 30 minutes. */
  ttlMs?: number
  /** Periodic expiry-sweep interval. Default 60s. */
  sweepIntervalMs?: number
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Reserved card state keys (D2) — exported so T6's Surface builder and T5
// share one vocabulary instead of duplicating magic strings.
// ---------------------------------------------------------------------------

export const DECISION_APPROVE_KEY = 'decision.approve'
export const DECISION_REJECT_KEY = 'decision.reject'
export const DECISION_ALLOWLIST_CHECKBOX_KEY = 'decision.allowlist'

export const RESERVED_DECISION_KEYS: ReadonlySet<string> = new Set([
  DECISION_APPROVE_KEY,
  DECISION_REJECT_KEY,
  DECISION_ALLOWLIST_CHECKBOX_KEY,
])

/** The card state key an editable `key` from `ToolMeta.editableKeys` binds to (D2). */
export function fieldStateKey(key: string): string {
  return `field.${key}`
}

/** Canonical (key-sorted) JSON encoding of allowlist match params — the allowlist's matching key. */
export function canonicalAllowlistParams(params: Record<string, string>): string {
  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(Object.fromEntries(sorted))
}
