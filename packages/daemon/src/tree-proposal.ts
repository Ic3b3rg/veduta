import {
  SurfaceSchema,
  applySurfacePatch,
  type AtomNode,
  type ChatTurnCorrelation,
  type Surface,
} from '@veduta/protocol'
import {
  DECISION_ERROR_CAPTION_PATH,
  decisionButtonNode,
  decisionErrorCaptionNode,
} from './decision-surface.ts'
import { SerializedWorkQueue } from './serialized-work-queue.ts'
import type { Store } from './store.ts'
import type { CommittedFastActionOutcome } from '@veduta/protocol'
import { fastActionChangedKeys } from './fast-action-projection.ts'
import { SurfaceActionError } from './fast-action.ts'
import type { FastActionPreflightContext } from './surface-engine.ts'
import type { TreeProposal } from './surface-engine.ts'
import { effectiveOrigin, neutralizeDelimiters } from './taint.ts'
import {
  TREE_REVIEW_FORMAT,
  TREE_REVIEW_FORMAT_KEY,
  TREE_REVIEW_READY_KEY,
  TREE_REVIEW_SUMMARY_KEY,
  treeProposalFallbackSummary,
  treeProposalPreview,
} from './tree-proposal-preview.ts'

/**
 * The Tree proposal preview Surface (issue 022: a pinned Surface turns an
 * Agent tree patch into a proposal instead of applying it, `SurfaceEngine.
 * patchTree`). This module owns both directions of that Surface, the same
 * way `approval-surface.ts` owns the approval card: building it
 * (`buildTreeProposalSurface`) and reacting to the human's Accept/Reject
 * fast-path clicks (`TreeProposalSurfaceManager`).
 */

/** Bounds compact target metadata and Event text; complete review content is never truncated. */
const TARGET_FIELD_MAX_CHARS = 200
const TREE_PROPOSAL_SURFACE_PREFIX = 'srf-tree-proposal-'

/**
 * Strict grammar for the numeric suffix `treeProposalIdFromSurfaceId` parses
 *: canonical decimal digits only, no leading zero, no
 * sign, no decimal point or exponent. `Number(raw)` alone accepted anything
 * `Number.isInteger` allows — `03`, `-7.0`, `-0x7`, `-+7`, `-7e0`, and even
 * the empty suffix (`Number('') === 0`) all round-tripped onto a real
 * proposal id, so a Surface created at one of those alias ids could be
 * mistaken for the canonical card for proposal 0/7/etc. Requiring the raw
 * suffix to match this exactly, before ever calling `Number`, guarantees
 * `treeProposalSurfaceId(treeProposalIdFromSurfaceId(id)) === id` whenever a
 * value is returned at all.
 */
const TREE_PROPOSAL_ID_RE = /^[1-9][0-9]*$/

/** The fast-path state keys the Accept/Reject buttons declare actions on. */
export const DECISION_ACCEPT_KEY = 'decision.accept'
export const DECISION_REJECT_KEY = 'decision.reject'

const STALE_PROPOSAL_MESSAGE =
  "the Surface's tree changed since this proposal was recorded; the proposed change was not applied"
const APPLY_FAILED_MESSAGE =
  'applying this change failed; the proposed change was not applied to the Surface'

export function treeProposalSurfaceId(proposalId: number): string {
  return `${TREE_PROPOSAL_SURFACE_PREFIX}${proposalId}`
}

/**
 * Inverse of `treeProposalSurfaceId` (cheap pre-filter): the card id encodes
 * its proposalId deterministically, so a fast-mutation notice can recover
 * "its" proposal from the id alone, the way `approvalIdFromSurfaceId` does
 * for approval cards. Never trusted on its own — the persisted `tree_
 * proposals` row (`Store.getTreeProposal`) is the only source of truth;
 * this only rules out surfaces that could never be a proposal card.
 */
export function treeProposalIdFromSurfaceId(surfaceId: string): number | undefined {
  if (!surfaceId.startsWith(TREE_PROPOSAL_SURFACE_PREFIX)) return undefined
  const raw = surfaceId.slice(TREE_PROPOSAL_SURFACE_PREFIX.length)
  if (!TREE_PROPOSAL_ID_RE.test(raw)) return undefined
  return Number(raw)
}

/** Builds a read-only comparison only from the proposal's exact target tree version. */
export function buildTreeProposalSurface(
  proposal: TreeProposal,
  target: Surface | undefined,
  currentTreeVersion: number | undefined,
): Surface {
  const targetTitle = truncate(
    neutralizeDelimiters(target?.title ?? proposal.surfaceId),
    TARGET_FIELD_MAX_CHARS,
  )
  const targetId = truncate(neutralizeDelimiters(proposal.surfaceId), TARGET_FIELD_MAX_CHARS)
  const unavailable = reviewUnavailableMessage(proposal, target, currentTreeVersion)
  const preview = unavailable || !target ? undefined : treeProposalPreview(proposal, target)
  const summary =
    preview?.summary ?? treeProposalFallbackSummary(proposal, target?.title ?? proposal.surfaceId)
  const children: AtomNode[] = [
    { id: 'title', type: 'Title', props: { text: `Proposed change: ${targetTitle}` } },
    {
      id: 'meta',
      type: 'Caption',
      props: {
        text: `Surface ${targetId} · review of tree version ${proposal.expectedTreeVersion} · proposal ${proposal.id}`,
      },
    },
    { id: 'preview', type: 'Text', props: { text: `Summary: ${summary}` } },
    // Kept at DECISION_ERROR_CAPTION_PATH for the existing refusal projection.
    decisionErrorCaptionNode(unavailable ?? 'No changes have been applied.'),
    {
      id: 'decisions',
      type: 'Col',
      children: [
        {
          id: 'consequences',
          type: 'Text',
          props: {
            text: unavailable
              ? 'Accept is unavailable. Reject keeps the Surface unchanged and discards this proposal. Ask for a fresh proposal to make a change.'
              : 'Accept applies these changes once, in the order shown. Reject keeps the Surface unchanged and discards this proposal. Live data continues updating; values below were captured when this review was prepared.',
          },
        },
        {
          id: 'decision-buttons',
          type: 'Row',
          children: [
            ...(unavailable
              ? []
              : [decisionButtonNode('decision-accept', 'Accept', DECISION_ACCEPT_KEY)]),
            decisionButtonNode('decision-reject', 'Reject', DECISION_REJECT_KEY),
          ],
        },
      ],
    },
    ...(preview
      ? [
          {
            id: 'details-label',
            type: 'Caption' as const,
            props: {
              text: 'Complete details · expand each change to read all content, data bindings and declared actions. This review cannot run the proposed actions or load external images.',
            },
          },
          ...preview.details,
        ]
      : []),
  ]

  return SurfaceSchema.parse({
    id: treeProposalSurfaceId(proposal.id),
    spaceId: proposal.spaceId,
    title: `Proposed change: ${targetTitle}`,
    presentation: 'full',
    tree: { id: 'root', type: 'Box', children },
    state: {
      [DECISION_ACCEPT_KEY]: false,
      [DECISION_REJECT_KEY]: false,
      [TREE_REVIEW_SUMMARY_KEY]: summary,
      [TREE_REVIEW_FORMAT_KEY]: TREE_REVIEW_FORMAT,
      [TREE_REVIEW_READY_KEY]: preview !== undefined,
    },
    freshness: { updatedAt: proposal.createdAt, updatedBy: 'job' },
  })
}

function reviewUnavailableMessage(
  proposal: TreeProposal,
  target: Surface | undefined,
  currentTreeVersion: number | undefined,
): string | undefined {
  if (!target)
    return 'Review unavailable: the target Surface is no longer available. This proposal cannot be applied.'
  if (
    target.id !== proposal.surfaceId ||
    target.spaceId !== proposal.spaceId ||
    currentTreeVersion !== proposal.expectedTreeVersion
  ) {
    return 'Review unavailable: the target no longer matches the reviewed tree version. This proposal cannot be applied; request a fresh proposal.'
  }
  try {
    applySurfacePatch(target, { surfaceId: proposal.surfaceId, operations: proposal.operations })
  } catch {
    return 'Review unavailable: the proposed change no longer validates against the Surface data. Nothing has been applied.'
  }
  return undefined
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

// ---------------------------------------------------------------------------
// TreeProposalSurfaceManager — creates the preview card when a proposal is
// recorded, and turns Accept/Reject fast-path clicks into the proposal's
// resolution.
// ---------------------------------------------------------------------------

export interface TreeProposalSurfaceManagerOptions {
  store: Store
  /** Defaults to `console.error`. Never lets a resolution failure become an unhandled rejection. */
  onError?: (error: unknown) => void
}

export interface TreeProposalResolutionResult {
  proposal: TreeProposal
  refusal?: 'stale' | 'failed'
}

/**
 * Observes `store.onTreeProposal` to build the preview card, and
 * `store.onFastActionOutcome` for Accept/Reject clicks on the cards it created —
 * both wired in the constructor, unlike `ApprovalSurfaceManager`, which
 * needs a two-phase `setTrust` handshake only because `TrustLayer`'s own
 * constructor requires a port. Nothing here has that circularity.
 *
 * Resolution uses the same serialized promise chain as `ApprovalSurfaceManager`.
 * Its returned promise lets `onFastActionOutcome` record its named receipt after
 * the async projection completes. Failures remain diagnostic and retryable. Two
 * outcomes for the same card queue rather than race: each `resolve()` re-fetches the
 * proposal's current status from the store at its own start, and
 * `Store.resolveTreeProposal`'s guarded `update ... where status =
 * 'pending'` is the true exactly-once gate underneath that check.
 */
export class TreeProposalSurfaceManager {
  private readonly store: Store
  private readonly onError: (error: unknown) => void
  private readonly resolutions: SerializedWorkQueue
  private readonly unsubscribeProposal: () => void
  private readonly unsubscribeFastMutation: () => void
  private readonly unsubscribePreflight: () => void
  private readonly unsubscribeSurface: () => void

  constructor(options: TreeProposalSurfaceManagerOptions) {
    this.store = options.store
    this.onError =
      options.onError ?? ((error) => console.error('tree proposal: resolution failed', error))
    this.resolutions = new SerializedWorkQueue(this.onError)
    this.unsubscribeProposal = this.store.onTreeProposal((proposal, initiatingTurn) =>
      this.createCard(proposal, initiatingTurn),
    )
    this.unsubscribePreflight = this.store.onFastActionPreflight((context) =>
      this.preflight(context),
    )
    this.unsubscribeFastMutation = this.store.onFastActionOutcome('tree-proposals', (outcome) =>
      this.project(outcome),
    )
    this.unsubscribeSurface = this.store.onSurfaceEvent((notice) => {
      const surfaceId =
        notice.kind === 'patch'
          ? notice.event.patch.surfaceId
          : notice.kind === 'archived'
            ? notice.event.surfaceId
            : undefined
      if (surfaceId === undefined) return
      for (const proposal of this.store.listTreeProposals({ surfaceId, status: 'pending' })) {
        this.refreshReviewAvailability(proposal)
      }
    })
  }

  /**
   * Boot recovery: reopens any `accepted` proposal that provably never
   * applied (see `reconcileAcceptedButUnapplied`), then for every `pending`
   * proposal — including one just reopened — ensures its card Surface
   * exists at the deterministic id. A card Surface that survived a daemon
   * restart on disk is already fully clickable —
   * `project`/`resolve` resolve against the store directly, not
   * against anything `start()` builds. Recovery recreates missing cards,
   * upgrades legacy previews against an exact version, and refreshes unavailable
   * notices without changing the prepared comparison. If a Surface already
   * occupies the canonical id and is not daemon-owned, this refuses to
   * adopt it as the proposal's card: an impostor (planted by the Agent, or
   * a legitimate unrelated Surface that merely collided with the id) must
   * never be wired up to accept Accept/Reject clicks (the same stance
   * `ApprovalSurfaceManager.start()`'s `repairMissingSurfaceId` takes, and
   * for the same reason). The proposal is left pending, un-clickable, and
   * the situation is reported through `onError` for an operator to
   * investigate.
   */
  start(): void {
    this.reconcileAcceptedButUnapplied()
    for (const proposal of this.store.listTreeProposals({ status: 'pending' })) {
      const canonicalSurfaceId = treeProposalSurfaceId(proposal.id)
      const existing = this.store.getSurface(canonicalSurfaceId)
      if (existing) {
        if (!this.store.isSurfaceDaemonOwned(canonicalSurfaceId)) {
          this.onError(
            new Error(
              `tree proposal: refusing to adopt non-daemon-owned Surface "${canonicalSurfaceId}" ` +
                `for pending proposal #${proposal.id} — leaving it pending without a clickable card`,
            ),
          )
        } else if (existing.state[TREE_REVIEW_FORMAT_KEY] !== TREE_REVIEW_FORMAT) {
          // Upgrade a legacy projection only after the same exact-version check as a new review.
          this.replaceReview(proposal)
        } else {
          this.refreshReviewAvailability(proposal)
        }
        continue
      }
      this.createCard(proposal)
    }
  }

  /**
   * Reopens every `accepted` Tree proposal that provably never applied
   *: `resolve()` claims a proposal's row `accepted`
   * *before* calling `patchTree` — the exactly-once gate a doubled Accept
   * click needs — but a process crash between that claim and the apply
   * leaves the row permanently `accepted` with the card already gone from
   * the Accept fast-path click (or never rendered again), and the tree
   * unchanged. `resolve()`'s own `try`/`catch` already reopens this race
   * when it *observes* the failure; a crash observes nothing, so this is the
   * boot-time counterpart.
   *
   * "Never applied" is tested structurally, not by a flag: the target
   * Surface still exists and its `treeVersion` still equals the proposal's
   * `expectedTreeVersion` — had `patchTree` actually run, it would have
   * bumped `treeVersion` by exactly one. An `accepted` row whose version
   * *did* move applied successfully (its card was already archived) and is
   * left alone. A `pending` proposal reopened here is picked up by the
   * ordinary `pending` loop in `start()` right after this runs, rather than
   * duplicating that card-recovery logic a second time.
   */
  private reconcileAcceptedButUnapplied(): void {
    for (const proposal of this.store.listTreeProposals({ status: 'accepted' })) {
      const version = this.store.getSurfaceVersion(proposal.surfaceId)
      if (!version || version.treeVersion !== proposal.expectedTreeVersion) continue
      this.store.reopenTreeProposal(proposal.id)
    }
  }

  /** Stops observing both hooks. Idempotent-safe: the underlying `Store` unsubscribes already are. */
  dispose(): void {
    this.unsubscribeProposal()
    this.unsubscribeFastMutation()
    this.unsubscribePreflight()
    this.unsubscribeSurface()
  }

  /** Test/shutdown hook: resolves once every enqueued resolution has settled. */
  flush(): Promise<void> {
    return this.resolutions.flush()
  }

  /** Alternative authenticated channel into the same workflow authority as the Decision Surface. */
  resolveDecision(
    proposalId: number,
    decision: 'accept' | 'reject',
    actor: 'trusted:user',
  ): Promise<TreeProposalResolutionResult> {
    if (actor !== 'trusted:user') throw new Error('Tree proposal resolution requires trusted:user')
    return this.resolve(proposalId, treeProposalSurfaceId(proposalId), decision, actor)
  }

  /**
   * Builds and persists the preview card for a newly recorded proposal.
   * Never throws: a `createSurface` failure (e.g. the deterministic id
   * somehow collided) is routed through `onError`, exactly as the
   * unknown-target case just below already was —
   * `notifyTreeProposal` fires after the proposal's own recording
   * transaction has committed, so a card-creation failure must never make
   * the `patch_tree` tool report a failure for a proposal that is, in fact,
   * durably recorded (which would invite the Agent to retry and record a
   * duplicate).
   */
  private createCard(proposal: TreeProposal, initiatingTurn?: ChatTurnCorrelation): void {
    const target = this.store.getSurface(proposal.surfaceId)
    try {
      const surface = buildTreeProposalSurface(
        proposal,
        target,
        this.store.getSurfaceVersion(proposal.surfaceId)?.treeVersion,
      )
      // Daemon-owned (the same structural-defense contract as approval
      // cards): the Agent must never be able to rewrite this card's preview
      // or pre-set its `decision.*` state after the human has read it.
      this.store.createSurface(surface, 'job', {
        origin: 'trusted:system',
        daemonOwned: true,
        ...(initiatingTurn === undefined ? {} : { initiatingTurn }),
      })
    } catch (error) {
      this.onError(error)
    }
  }

  private refreshReviewAvailability(proposal: TreeProposal): void {
    const surfaceId = treeProposalSurfaceId(proposal.id)
    const card = this.store.getSurface(surfaceId)
    if (!card || !this.store.isSurfaceDaemonOwned(surfaceId)) return
    const unavailable = reviewUnavailableMessage(
      proposal,
      this.store.getSurface(proposal.surfaceId),
      this.store.getSurfaceVersion(proposal.surfaceId)?.treeVersion,
    )
    if (!unavailable && card.state[TREE_REVIEW_READY_KEY] !== true) {
      this.replaceReview(proposal)
      return
    }
    const error = card.tree.children?.[3]
    const previous = error?.type === 'Caption' ? error.props?.text : undefined
    const message = unavailable ?? 'No changes have been applied.'
    if (previous === message) return
    try {
      this.refuseAccept(surfaceId, message, { resetDecision: false })
    } catch (error) {
      this.onError(error)
    }
  }

  private replaceReview(proposal: TreeProposal): void {
    const surfaceId = treeProposalSurfaceId(proposal.id)
    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return
    try {
      const review = buildTreeProposalSurface(
        proposal,
        this.store.getSurface(proposal.surfaceId),
        this.store.getSurfaceVersion(proposal.surfaceId)?.treeVersion,
      )
      this.store.patchTree(
        surfaceId,
        [{ target: 'tree', op: 'replace', path: '', value: review.tree }],
        {
          expectedTreeVersion: version.treeVersion,
          updatedBy: 'job',
          origin: 'trusted:system',
        },
      )
      this.store.patchState(
        surfaceId,
        [TREE_REVIEW_FORMAT_KEY, TREE_REVIEW_SUMMARY_KEY, TREE_REVIEW_READY_KEY].map((key) => ({
          target: 'state' as const,
          op: 'add' as const,
          path: `/${key}`,
          value: review.state[key]!,
        })),
        { updatedBy: 'job', origin: 'trusted:system' },
      )
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * The persisted daemon-owned card is the only clickable card — the same
   * stance `ApprovalSurfaceManager.project` takes
   * (`approval-surface.ts`) — enforced by two required checks.
   * `treeProposalIdFromSurfaceId`'s strict grammar is a
   * cheap shape pre-filter, not proof the click landed on the real card, so
   * a click must also (a) target the exact canonical id for that proposal
   * — never an alias a looser grammar could once parse — and (b) land on a
   * Surface this manager itself created (`isSurfaceDaemonOwned`). Without
   * both, the Agent could `create_surface` an innocuous-looking card at (or
   * near) the canonical id with a `Button` whose fast plan sets `decision.accept`
   * to a literal `true`
   * and have a single user tap apply the proposal's operations to the
   * pinned Surface with `bypassPin: true` — no preview, no consent.
   */
  private preflight(context: FastActionPreflightContext): void {
    const id = treeProposalIdFromSurfaceId(context.surface.id)
    if (
      id === undefined ||
      context.surface.id !== treeProposalSurfaceId(id) ||
      !this.store.isSurfaceDaemonOwned(context.surface.id)
    )
      return
    const keys = Object.keys(context.action.plan.targets)
    if (!keys.some((key) => key === DECISION_ACCEPT_KEY || key === DECISION_REJECT_KEY)) return
    const proposal = this.store.getTreeProposal(id)
    if (!proposal || proposal.status !== 'pending')
      throw new SurfaceActionError('preflight_rejected', 'This tree proposal is no longer pending')
    if (keys.includes(DECISION_ACCEPT_KEY)) {
      const target = this.store.getSurface(proposal.surfaceId)
      if (
        !target ||
        this.store.getSurfaceVersion(proposal.surfaceId)?.treeVersion !==
          proposal.expectedTreeVersion
      )
        throw new SurfaceActionError('preflight_rejected', STALE_PROPOSAL_MESSAGE)
      try {
        applySurfacePatch(target, { surfaceId: target.id, operations: proposal.operations })
      } catch {
        throw new SurfaceActionError('preflight_rejected', APPLY_FAILED_MESSAGE)
      }
    }
  }

  private project(outcome: CommittedFastActionOutcome): Promise<void> | void {
    const id = treeProposalIdFromSurfaceId(outcome.surfaceId)
    if (
      id === undefined ||
      outcome.surfaceId !== treeProposalSurfaceId(id) ||
      !this.store.isSurfaceDaemonOwned(outcome.surfaceId)
    )
      return
    if (this.store.getTreeProposal(id)?.status !== 'pending') return
    const key = fastActionChangedKeys(outcome).find(
      (key) =>
        (key === DECISION_ACCEPT_KEY || key === DECISION_REJECT_KEY) &&
        outcome.surface.state[key] === true,
    )
    if (!key) return
    const decision = key === DECISION_ACCEPT_KEY ? 'accept' : 'reject'
    return this.resolutions.enqueue(async () => {
      await this.resolve(id, outcome.surfaceId, decision, 'trusted:user')
    })
  }

  private async resolve(
    proposalId: number,
    cardSurfaceId: string,
    decision: 'accept' | 'reject',
    actor: 'trusted:user',
  ): Promise<TreeProposalResolutionResult> {
    const proposal = this.store.getTreeProposal(proposalId)
    if (!proposal) throw new Error(`tree proposal: unknown proposal #${proposalId}`)
    if (proposal.status !== 'pending') return { proposal } // resolved by a racing click already

    // `surface.tree_proposal_accepted`/`_rejected` interpolate the target's
    // own `surfaceId`, which is attacker-influenceable for a Surface built
    // from an imported Template (mirrors
    // `recordTreeProposal`'s own `surface.tree_proposal` entry in
    // surface-engine.ts) — so the origin folds in the target's stored
    // `content_origin` instead of a hardcoded `trusted:system`, and the
    // interpolated id is neutralized and truncated exactly as the pin
    // event's title is (`TARGET_FIELD_MAX_CHARS`).
    const targetContentOrigin = this.store.surfaceProvenance(proposal.surfaceId)?.contentOrigin
    const resolutionEventOrigin = effectiveOrigin([targetContentOrigin], 'trusted:system')
    const targetId = truncate(neutralizeDelimiters(proposal.surfaceId), TARGET_FIELD_MAX_CHARS)

    if (decision === 'reject') {
      const resolved = this.store.resolveTreeProposal(proposalId, 'rejected', actor)
      if (!resolved) {
        return { proposal: this.store.getTreeProposal(proposalId) ?? proposal }
      }
      this.store.spacesEngine.appendEvent(proposal.spaceId, {
        type: 'surface.tree_proposal_rejected',
        text: `Rejected a proposed tree change for Surface "${targetId}"`,
        origin: resolutionEventOrigin,
        payload: { surfaceId: proposal.surfaceId, proposalId },
      })
      this.archive(cardSurfaceId)
      return { proposal: resolved }
    }

    const currentVersion = this.store.getSurfaceVersion(proposal.surfaceId)
    if (!currentVersion || currentVersion.treeVersion !== proposal.expectedTreeVersion) {
      // Stale: the target's tree moved since this proposal was recorded.
      // Terminalize the exact proposal so every channel sees the same
      // truthful outcome. A fixed-up change requires a new proposal.
      const stale = this.store.resolveTreeProposal(proposalId, 'stale', actor)
      if (!stale) {
        return { proposal: this.store.getTreeProposal(proposalId) ?? proposal }
      }
      this.refuseAccept(cardSurfaceId, STALE_PROPOSAL_MESSAGE, { resetDecision: true })
      this.store.spacesEngine.appendEvent(proposal.spaceId, {
        type: 'surface.tree_proposal_stale',
        text: `Refused a stale tree change for Surface "${targetId}"`,
        origin: resolutionEventOrigin,
        payload: { surfaceId: proposal.surfaceId, proposalId },
      })
      return { proposal: stale, refusal: 'stale' }
    }

    // Claim the row *before* applying, not after: this is the exactly-once
    // gate. A second, already-enqueued Accept click re-fetches the proposal
    // at the top of its own `resolve()` call (above) and — because
    // `enqueue`'s chain serializes every resolution — only ever runs after
    // this one has fully committed, so it finds the proposal no longer
    // `pending` and returns before ever reaching `patchTree`. Applying first
    // and resolving after was rejected: that ordering would let two
    // already-enqueued Accept clicks both still observe `pending` and both
    // apply the patch before either claimed the row.
    const claimed = this.store.resolveTreeProposal(proposalId, 'accepted', actor)
    if (!claimed) {
      return { proposal: this.store.getTreeProposal(proposalId) ?? proposal }
    }

    try {
      this.store.patchTree(proposal.surfaceId, proposal.operations, {
        expectedTreeVersion: proposal.expectedTreeVersion,
        updatedBy: 'user',
        bypassPin: true,
        origin: proposal.origin,
      })
    } catch (error) {
      // The row is already claimed `accepted` at this point (deliberately —
      // see the comment above); this is the rare edge that ordering
      // accepts. It is deterministically reachable: a state patch can
      // remove a key the proposed node binds while `treeVersion` stays put
      // (state patches are never gated by the pin), so `patchTree`'s
      // dry-run re-validation throws here even though the staleness check
      // above passed. Reopen the row back to `pending` so the proposal is
      // not stuck `accepted` forever with no way to
      // retry, log the failure, and leave the card in place with the
      // refusal Caption explaining it, rather than silently discarding the
      // failure. The pressed decision key is reset, same as the stale path
      // above, since the proposal is pending again and a plain re-click
      // should be enough once the Agent re-proposes or the binding is
      // restored.
      this.onError(error)
      this.store.reopenTreeProposal(proposalId)
      this.refuseAccept(cardSurfaceId, APPLY_FAILED_MESSAGE, { resetDecision: true })
      return {
        proposal: this.store.getTreeProposal(proposalId) ?? proposal,
        refusal: 'failed',
      }
    }

    this.store.spacesEngine.appendEvent(proposal.spaceId, {
      type: 'surface.tree_proposal_accepted',
      text: `Accepted a proposed tree change for Surface "${targetId}"`,
      origin: resolutionEventOrigin,
      payload: { surfaceId: proposal.surfaceId, proposalId },
    })
    this.archive(cardSurfaceId)
    return { proposal: this.store.getTreeProposal(proposalId) ?? claimed }
  }

  /** Patches the card's refusal Caption, optionally resetting the Accept decision key back to `false`. */
  private refuseAccept(
    surfaceId: string,
    message: string,
    options: { resetDecision: boolean },
  ): void {
    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return // archived/unknown — nothing to patch
    this.store.patchTree(
      surfaceId,
      [
        {
          target: 'tree',
          op: 'replace',
          path: DECISION_ERROR_CAPTION_PATH,
          value: decisionErrorCaptionNode(message),
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job', origin: 'trusted:system' },
    )
    if (options.resetDecision) {
      this.store.patchState(
        surfaceId,
        [{ target: 'state', op: 'replace', path: `/${DECISION_ACCEPT_KEY}`, value: false }],
        { updatedBy: 'job', origin: 'trusted:system' },
      )
    }
  }

  private archive(surfaceId: string): void {
    if (!this.store.getSurface(surfaceId)) return // already archived/unknown — graceful no-op
    this.store.archiveSurface(surfaceId, 'job')
  }
}
