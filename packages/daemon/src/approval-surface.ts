import { SurfaceSchema, type AtomNode, type JsonValue, type Surface } from '@veduta/protocol'
import type { FastMutationNotice, Store } from './store.ts'
import { neutralizeDelimiters } from './taint.ts'
import {
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  DECISION_APPROVE_KEY,
  DECISION_REJECT_KEY,
  fieldStateKey,
  type ApprovalCardModel,
  type ApprovalCardPort,
  type PendingApproval,
  type TrustLayer,
} from './trust-layer.ts'

/**
 * The approval card Surface (D4, issue #14): every pending L1/L2 approval is
 * rendered as its own Surface in the originating Space, never a chat bubble
 * or free-form HTML (ARCHITECTURE.md §7). This module owns both directions
 * of that Surface: building it (`buildApprovalCardSurface`) and reacting to
 * the human's fast-path clicks on it (`ApprovalSurfaceManager`, the
 * `ApprovalCardPort` the trust layer is built against).
 */

const SUMMARY_MAX_CHARS = 500
/** Fixed position of the validation-error Caption in every card's tree (D6/A4). */
const ERROR_CAPTION_NODE_ID = 'error'
const ERROR_CAPTION_PATH = '/children/3'

const APPROVAL_CARD_SURFACE_PREFIX = 'srf-approval-'

export function approvalCardSurfaceId(approvalId: string): string {
  return `${APPROVAL_CARD_SURFACE_PREFIX}${approvalId}`
}

/**
 * Inverse of `approvalCardSurfaceId` (Fix A, boot-rehydration race): the
 * card id encodes its approvalId deterministically, so a fast-mutation
 * notice can recover "its" approval from the id alone — a cheap string
 * pre-filter, never trusted on its own. The trust store's pending row is
 * still the source of truth (`handleFastMutation` checks it next); this
 * only rules out surfaces that could never be an approval card.
 */
export function approvalIdFromSurfaceId(surfaceId: string): string | undefined {
  return surfaceId.startsWith(APPROVAL_CARD_SURFACE_PREFIX)
    ? surfaceId.slice(APPROVAL_CARD_SURFACE_PREFIX.length)
    : undefined
}

/**
 * Composes the approval card Surface for one pending approval. Everything
 * derived from the tool's (possibly untrusted-influenced) `title`/`summary`
 * is delimiter-neutralized (`neutralizeDelimiters`, taint.ts); the summary is
 * additionally truncated, since it is the one field with no natural size
 * bound. Protocol-validated (`SurfaceSchema.parse`) before the caller
 * persists it (D4).
 */
export function buildApprovalCardSurface(
  approval: PendingApproval,
  card: ApprovalCardModel,
): Surface {
  const title = neutralizeDelimiters(card.title)
  const children: AtomNode[] = [
    { id: 'title', type: 'Title', props: { text: `Approval required: ${title}` } },
    { id: 'meta', type: 'Caption', props: { text: metaCaptionText(card) } },
    {
      id: 'summary',
      type: 'Markdown',
      // Neutralize before truncating: truncation can never re-create a
      // delimiter out of an already-neutralized string, but the reverse
      // order could exceed the length bound.
      props: { text: truncate(neutralizeDelimiters(card.summary), SUMMARY_MAX_CHARS) },
    },
    // Fixed at index 3 (`ERROR_CAPTION_PATH`) so `patchValidationError` can
    // replace it without needing to search the tree for it.
    { id: ERROR_CAPTION_NODE_ID, type: 'Caption', props: { text: '' } },
    ...card.editableFields.map((field) => editableFieldNode(field.key, field.value)),
    ...(card.showAllowlistCheckbox ? [allowlistCheckboxNode(approval.toolName)] : []),
    {
      id: 'decisions',
      type: 'Row',
      children: [
        decisionButtonNode('decision-approve', 'Approve', DECISION_APPROVE_KEY),
        decisionButtonNode('decision-reject', 'Reject', DECISION_REJECT_KEY),
      ],
    },
  ]

  const state: Record<string, JsonValue> = {}
  for (const field of card.editableFields) {
    state[fieldStateKey(field.key)] = toJsonValue(field.value)
  }
  state[DECISION_APPROVE_KEY] = false
  state[DECISION_REJECT_KEY] = false
  if (card.showAllowlistCheckbox) state[DECISION_ALLOWLIST_CHECKBOX_KEY] = false

  return SurfaceSchema.parse({
    id: approvalCardSurfaceId(approval.id),
    spaceId: approval.spaceId,
    title: `Approval required: ${title}`,
    tree: { id: 'root', type: 'Box', children },
    state,
    freshness: { updatedAt: approval.createdAt, updatedBy: 'job' },
  })
}

function metaCaptionText(card: ApprovalCardModel): string {
  const parts = [`Level ${card.level}`, `origin ${card.effectiveOrigin}`]
  if (card.trigger) {
    const summary = card.trigger.summary ? `: ${neutralizeDelimiters(card.trigger.summary)}` : ''
    parts.push(`trigger ${card.trigger.kind}${summary}`)
  }
  parts.push(`expires ${card.expiresAt}`)
  return parts.join(' · ')
}

function editableFieldNode(key: string, value: unknown): AtomNode {
  const stateKey = fieldStateKey(key)
  return {
    id: `field-${key}`,
    type: fieldAtomType(value),
    props: { label: humanizeKey(key) },
    binding: stateKey,
    actions: [{ name: 'change', path: 'fast', stateKey, payload: {} }],
  }
}

function fieldAtomType(value: unknown): 'Input' | 'Textarea' {
  return typeof value === 'string' && (value.length > 80 || value.includes('\n'))
    ? 'Textarea'
    : 'Input'
}

function humanizeKey(key: string): string {
  return key.length > 0 ? key.charAt(0).toUpperCase() + key.slice(1) : key
}

function allowlistCheckboxNode(toolName: string): AtomNode {
  return {
    id: 'decision-allowlist',
    type: 'Checkbox',
    props: { label: `From now on, approve ${toolName} like this` },
    binding: DECISION_ALLOWLIST_CHECKBOX_KEY,
    actions: [
      { name: 'toggle', path: 'fast', stateKey: DECISION_ALLOWLIST_CHECKBOX_KEY, payload: {} },
    ],
  }
}

function decisionButtonNode(id: string, label: string, stateKey: string): AtomNode {
  return {
    id,
    type: 'Button',
    props: { label },
    actions: [{ name: 'press', path: 'fast', stateKey, payload: { value: true } }],
  }
}

function errorCaptionNode(message: string): AtomNode {
  return { id: ERROR_CAPTION_NODE_ID, type: 'Caption', props: { text: message } }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue)
}

// ---------------------------------------------------------------------------
// ApprovalSurfaceManager — the ApprovalCardPort backing the trust layer, and
// the fast-mutation observer that turns Approve/Reject clicks into
// `trust.resolve()` calls (D6).
// ---------------------------------------------------------------------------

export interface ApprovalSurfaceManagerOptions {
  store: Store
  /** Defaults to `console.error`. Never lets a resolution failure become an unhandled rejection. */
  onError?: (error: unknown) => void
}

/**
 * Implements `ApprovalCardPort` against the real Surface engine, and
 * observes `store.onFastMutation` for Approve/Reject/allowlist-checkbox
 * clicks on the cards it created. The trust layer itself is supplied after
 * construction (`setTrust`) — `TrustLayer`'s constructor requires a port, so
 * this manager must exist first; wiring (T9) constructs both then connects
 * them.
 *
 * Resolution is funneled through a single serialized promise chain (the
 * `fullTextChain` pattern in `server.ts`): `onFastMutation` is a synchronous
 * void callback, so nothing else awaits or observes the async
 * `trust.resolve()` work directly — every link in the chain ends in its own
 * `catch`, so a resolution failure is logged and never surfaces as an
 * unhandled rejection, and two notices for the same card (e.g. a doubled
 * click before the first claim commits) queue rather than race: the trust
 * layer's own exactly-once claim makes the second a harmless no-op.
 *
 * There is deliberately no in-memory `surfaceId -> approvalId` map (Fix A,
 * boot-rehydration race): the trust store's persisted `pending_approvals`
 * row is the only source of truth `handleFastMutation` consults, so a click
 * on a card resolves correctly the instant the daemon can reach the store —
 * it never depends on `start()` (boot rehydration) having run first. An
 * in-memory cache would only ever be a redundant pre-filter here; the
 * deterministic id (`approvalIdFromSurfaceId`) already gives that for free.
 */
export class ApprovalSurfaceManager implements ApprovalCardPort {
  private readonly store: Store
  private readonly onError: (error: unknown) => void
  private trust: TrustLayer | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(options: ApprovalSurfaceManagerOptions) {
    this.store = options.store
    this.onError =
      options.onError ?? ((error) => console.error('approval surface: resolution failed', error))
    this.unsubscribe = this.store.onFastMutation((notice) => this.handleFastMutation(notice))
  }

  /** Connects the trust layer this manager's card clicks resolve against. */
  setTrust(trust: TrustLayer): void {
    this.trust = trust
  }

  /**
   * Boot rehydration (issue #14 review fix; narrowed by Fix A): a card
   * Surface that survived a daemon restart on disk is already fully
   * clickable — `handleFastMutation` resolves against the trust store
   * directly, not against anything `start()` builds — so this only ever
   * needs to repair what the store itself cannot recompute: a card Surface
   * whose `createCard()` crashed between inserting the row and recording
   * its `surface_id` (recreated here, at the deterministic id, then
   * persisted back via `attachSurfaceId`). Must run only after the trust
   * layer's own boot recovery (`TrustLayer.start()`) settles: a row
   * `recoverAtBoot()` just expired, or whose tool vanished, must never be
   * resurrected as a clickable card. Calling this late (or never) only
   * delays that repair — it is never a correctness requirement for clicks
   * on cards that already have a surface (`hasPendingCardSurface` requires
   * an exact `surface_id` match, so such a row simply stays un-clickable
   * until repaired, never adopting an impostor).
   */
  start(): void {
    if (!this.trust) throw new Error('approval surface: no TrustLayer attached (call setTrust)')
    for (const record of this.trust.listPending()) {
      if (record.surfaceId !== undefined) {
        // Normal case: `createCard()` already recorded `surface_id`. Only
        // recreate the Surface if it was somehow lost — no ownership
        // question here, since a fresh one is always created daemon-owned.
        if (!this.store.getSurface(record.surfaceId)) {
          const surface = buildApprovalCardSurface(record.approval, record.card)
          this.store.createSurface(surface, 'job', { origin: 'trusted:system', daemonOwned: true })
        }
        continue
      }
      this.repairMissingSurfaceId(record)
    }
  }

  /**
   * Repairs a row whose `surface_id` is still `null` (D7: `createCard()`
   * crashed between inserting the row and recording one). The only
   * legitimate Surface for this approval lives at the deterministic id
   * (`approvalCardSurfaceId`); if something already occupies that id, it
   * must be verified daemon-owned before this manager adopts it as the
   * approval's card — otherwise a non-owned impostor (planted by the Agent
   * or a compromised client under the guessable canonical id) could be
   * wired up to accept Approve/Reject clicks. An impostor is never
   * archived (it may be a legitimate, unrelated Surface that merely
   * collided with the id) and the canonical card can never be recreated
   * under that same id while the impostor occupies it — so this leaves the
   * approval pending, un-clickable, and logs the situation via `onError`
   * for an operator to investigate. This is a narrow, deliberately inert
   * edge: the approval simply never gets a working card until the
   * impostor Surface is removed and `start()` runs again.
   */
  private repairMissingSurfaceId(record: {
    approval: PendingApproval
    card: ApprovalCardModel
  }): void {
    const canonicalSurfaceId = approvalCardSurfaceId(record.approval.id)
    const existing = this.store.getSurface(canonicalSurfaceId)
    if (existing && !this.store.isSurfaceDaemonOwned(canonicalSurfaceId)) {
      this.onError(
        new Error(
          `approval surface: refusing to adopt non-daemon-owned Surface "${canonicalSurfaceId}" ` +
            `for pending approval "${record.approval.id}" — leaving it pending without a clickable card`,
        ),
      )
      return
    }
    if (!existing) {
      const surface = buildApprovalCardSurface(record.approval, record.card)
      this.store.createSurface(surface, 'job', { origin: 'trusted:system', daemonOwned: true })
    }
    this.trust?.attachSurfaceId(record.approval.id, canonicalSurfaceId)
  }

  /** Stops observing fast mutations. Idempotent-safe: `store.onFastMutation`'s returned cleanup already is. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Test/shutdown hook: resolves once every enqueued resolution has settled. */
  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    )
  }

  // -- ApprovalCardPort --------------------------------------------------

  create(approval: PendingApproval, card: ApprovalCardModel): { surfaceId: string } {
    const surface = buildApprovalCardSurface(approval, card)
    // Daemon-owned (D4/ADR-0007's structural-defense contract): a
    // tainted-but-L0 turn must never be able to rewrite this card's
    // `field.*` content or pre-set its `decision.*` state after the human
    // has read it.
    this.store.createSurface(surface, 'job', { origin: 'trusted:system', daemonOwned: true })
    return { surfaceId: surface.id }
  }

  patchValidationError(surfaceId: string, message: string): void {
    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return // archived/unknown — nothing to patch
    this.store.patchTree(
      surfaceId,
      [
        {
          target: 'tree',
          op: 'replace',
          path: ERROR_CAPTION_PATH,
          value: errorCaptionNode(message),
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job', origin: 'trusted:system' },
    )
  }

  readEditedFields(surfaceId: string): Record<string, unknown> {
    const surface = this.store.getSurface(surfaceId)
    return surface ? { ...surface.state } : {}
  }

  archive(surfaceId: string): void {
    if (!this.store.getSurface(surfaceId)) return // already archived/unknown — graceful no-op
    this.store.archiveSurface(surfaceId, 'job')
  }

  // -- Fast-mutation observer (D6) ---------------------------------------

  /**
   * Resolves the approvalId from the surfaceId's deterministic shape, then
   * confirms it against the trust store's own pending row (Fix A): fixes
   * the boot-rehydration race where a click on a persisted card, arriving
   * before `start()` settles, used to find nothing in an in-memory map and
   * get silently dropped. The store is the only source of truth here — a
   * click resolves correctly the moment the daemon can read it, regardless
   * of `start()`'s timing.
   */
  private handleFastMutation(notice: FastMutationNotice): void {
    if (notice.stateKey !== DECISION_APPROVE_KEY && notice.stateKey !== DECISION_REJECT_KEY) return
    if (!notice.value) return
    const approvalId = approvalIdFromSurfaceId(notice.surfaceId)
    if (approvalId === undefined) return // not a card-surface id shape at all
    if (!this.trust?.hasPendingCardSurface(approvalId, notice.surfaceId)) return
    const decision = notice.stateKey === DECISION_APPROVE_KEY ? 'approve' : 'reject'
    this.enqueue(() => this.resolve(approvalId, decision))
  }

  private async resolve(approvalId: string, decision: 'approve' | 'reject'): Promise<void> {
    if (!this.trust) throw new Error('approval surface: no TrustLayer attached (call setTrust)')
    await this.trust.resolve(approvalId, decision)
  }

  /** Serializes async resolution work; every entry terminates in its own `catch` (never an unhandled rejection). */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.catch(() => {}).then(() => work().catch((error) => this.onError(error)))
  }
}
