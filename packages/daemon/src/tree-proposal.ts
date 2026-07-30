import { SurfaceSchema, type AtomNode, type PatchOperation, type Surface } from '@veduta/protocol'
import type { FastMutationNotice, Store } from './store.ts'
import type { TreeProposal } from './surface-engine.ts'
import { effectiveOrigin, neutralizeDelimiters } from './taint.ts'
import { walkAtomTree } from './templates.ts'

/**
 * The Tree proposal preview Surface (issue 022: a pinned Surface turns an
 * Agent tree patch into a proposal instead of applying it, `SurfaceEngine.
 * patchTree`). This module owns both directions of that Surface, the same
 * way `approval-surface.ts` owns the approval card: building it
 * (`buildTreeProposalSurface`) and reacting to the human's Accept/Reject
 * fast-path clicks (`TreeProposalSurfaceManager`).
 */

/** Caps applied to every string this module renders that is not a fixed enum value (see below). */
const TARGET_FIELD_MAX_CHARS = 200
const OPERATIONS_PREVIEW_MAX_CHARS = 4000

/**
 * Cap on each per-node prop value rendered into an operation's subtree
 * summary (issue 022 review fix, `summarizeNode`): a node's `label`/`text`/
 * `title`/`placeholder` is exactly the substantive content the preview must
 * show, and exactly as attacker-influenceable as the target's own title —
 * the whole summary still sits inside `OPERATIONS_PREVIEW_MAX_CHARS`, but a
 * single oversized prop must not be able to push every sibling node's
 * summary out of that cap by itself.
 */
const NODE_SUMMARY_PROP_MAX_CHARS = 80

/**
 * The prop keys whose value is meaningful to preview when present. The Atom
 * catalog's `props` are deliberately untyped per Atom
 * (`packages/protocol/src/atom.ts`), so this is the same small,
 * human-visible set across every type rather than a per-type allowlist.
 */
const SUMMARY_PROP_KEYS = ['label', 'text', 'title', 'placeholder'] as const

/** Fixed position of the refusal Caption in every card's tree. */
const ERROR_CAPTION_NODE_ID = 'error'
const ERROR_CAPTION_PATH = '/children/3'

const TREE_PROPOSAL_SURFACE_PREFIX = 'srf-tree-proposal-'

/**
 * Strict grammar for the numeric suffix `treeProposalIdFromSurfaceId` parses
 * (issue 022 review fix): canonical decimal digits only, no leading zero, no
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

/**
 * Composes the preview Surface for one recorded Tree proposal. Everything
 * derived from the target Surface's title/id, or from the proposed
 * operations' JSON-pointer paths, is delimiter-neutralized
 * (`neutralizeDelimiters`, taint.ts) and truncated: a proposal can
 * originate in a tainted turn (the Agent proposed it), so none of that text
 * is trusted. The Atom *types* the preview lists come from the fixed
 * `atomTypes` enum (`@veduta/protocol`), never from free-form props, so they
 * need no neutralization of their own. Protocol-validated
 * (`SurfaceSchema.parse`) before the caller persists it.
 */
export function buildTreeProposalSurface(proposal: TreeProposal, target: Surface): Surface {
  const targetTitle = truncate(neutralizeDelimiters(target.title), TARGET_FIELD_MAX_CHARS)
  const targetId = truncate(neutralizeDelimiters(target.id), TARGET_FIELD_MAX_CHARS)
  const previewText = truncate(
    proposal.operations.map((operation) => operationPreviewLine(operation)).join('\n'),
    OPERATIONS_PREVIEW_MAX_CHARS,
  )

  const children: AtomNode[] = [
    { id: 'title', type: 'Title', props: { text: `Proposed layout change: ${targetTitle}` } },
    {
      id: 'meta',
      type: 'Caption',
      props: {
        text: `Surface ${targetId} · expected tree version ${proposal.expectedTreeVersion}`,
      },
    },
    { id: 'preview', type: 'Markdown', props: { text: previewText } },
    // Fixed at index 3 (`ERROR_CAPTION_PATH`) so the refusal message can be
    // patched in place without needing to search the tree for it.
    { id: ERROR_CAPTION_NODE_ID, type: 'Caption', props: { text: '' } },
    {
      id: 'decisions',
      type: 'Row',
      children: [
        decisionButtonNode('decision-accept', 'Accept', DECISION_ACCEPT_KEY),
        decisionButtonNode('decision-reject', 'Reject', DECISION_REJECT_KEY),
      ],
    },
  ]

  return SurfaceSchema.parse({
    id: treeProposalSurfaceId(proposal.id),
    spaceId: proposal.spaceId,
    title: `Proposed layout change: ${targetTitle}`,
    tree: { id: 'root', type: 'Box', children },
    state: { [DECISION_ACCEPT_KEY]: false, [DECISION_REJECT_KEY]: false },
    freshness: { updatedAt: proposal.createdAt, updatedBy: 'job' },
  })
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

/**
 * One preview line per proposed operation: the op, its path, and — for
 * `add`/`replace` — a bounded, neutralized summary of the new subtree
 * (issue 022 review fix, `summarizeSubtree`). Listing only the Atom types a
 * new subtree introduces made a proposal that replaces a Button's action, or
 * a Markdown node's text, indistinguishable from an unrelated replacement of
 * the same shape — the user must be able to see what actually changed to
 * decide on it (`issues/022-emergent-templates.md`).
 */
function operationPreviewLine(operation: PatchOperation): string {
  if (operation.target !== 'tree') {
    // A Tree proposal only ever stores tree-target operations
    // (`SurfaceEngine.patchTree` calls `assertPatchTarget(operations,
    // 'tree')` before ever recording one) — this branch exists only so the
    // function is total over `PatchOperation`, not because it is reachable.
    return `${operation.op} ${neutralizeDelimiters(operation.path)}`
  }
  if (operation.op === 'move') {
    return `move ${neutralizeDelimiters(operation.from)} -> ${neutralizeDelimiters(operation.path)}`
  }
  const path = neutralizeDelimiters(operation.path)
  if (operation.op === 'remove') return `remove ${path}`
  return `${operation.op} ${path} (adds ${summarizeSubtree(operation.value)})`
}

/**
 * A bounded, neutralized, per-node summary of `root`'s subtree, in document
 * order (root first): each node's type, id, `binding` when present, the
 * human-visible props it declares (`SUMMARY_PROP_KEYS`), and every declared
 * action's name/path(/stateKey) — the substantive content a preview needs,
 * not merely the Atom type (issue 022 review fix).
 */
function summarizeSubtree(root: AtomNode): string {
  const lines: string[] = []
  walkAtomTree(root, (node) => lines.push(summarizeNode(node)))
  return lines.join('; ')
}

function summarizeNode(node: AtomNode): string {
  const parts = [node.type, `id=${neutralizeDelimiters(node.id)}`]
  if (node.binding !== undefined) {
    parts.push(`binding=${neutralizeDelimiters(node.binding)}`)
  }
  for (const key of SUMMARY_PROP_KEYS) {
    const value = node.props?.[key]
    if (typeof value !== 'string') continue
    parts.push(`${key}="${truncate(neutralizeDelimiters(value), NODE_SUMMARY_PROP_MAX_CHARS)}"`)
  }
  for (const action of node.actions ?? []) {
    const stateKey =
      action.stateKey === undefined ? '' : `(${neutralizeDelimiters(action.stateKey)})`
    parts.push(`action=${neutralizeDelimiters(action.name)}@${action.path}${stateKey}`)
  }
  return parts.join(' ')
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

/**
 * Observes `store.onTreeProposal` to build the preview card, and
 * `store.onFastMutation` for Accept/Reject clicks on the cards it created —
 * both wired in the constructor, unlike `ApprovalSurfaceManager`, which
 * needs a two-phase `setTrust` handshake only because `TrustLayer`'s own
 * constructor requires a port. Nothing here has that circularity.
 *
 * Resolution is funneled through a single serialized promise chain, exactly
 * as `ApprovalSurfaceManager` does: `onFastMutation` is a synchronous void
 * callback, so nothing else awaits the async resolution work directly, and
 * every link in the chain ends in its own `catch` — a resolution failure is
 * logged (`onError`) and never surfaces as an unhandled rejection. Two
 * notices for the same card (a doubled click before the first resolution
 * commits) queue rather than race: each `resolve()` call re-fetches the
 * proposal's current status from the store at its own start, and
 * `Store.resolveTreeProposal`'s guarded `update ... where status =
 * 'pending'` is the true exactly-once gate underneath that check.
 */
export class TreeProposalSurfaceManager {
  private readonly store: Store
  private readonly onError: (error: unknown) => void
  private chain: Promise<unknown> = Promise.resolve()
  private readonly unsubscribeProposal: () => void
  private readonly unsubscribeFastMutation: () => void

  constructor(options: TreeProposalSurfaceManagerOptions) {
    this.store = options.store
    this.onError =
      options.onError ?? ((error) => console.error('tree proposal: resolution failed', error))
    this.unsubscribeProposal = this.store.onTreeProposal((proposal) => this.createCard(proposal))
    this.unsubscribeFastMutation = this.store.onFastMutation((notice) =>
      this.handleFastMutation(notice),
    )
  }

  /**
   * Boot recovery: reopens any `accepted` proposal that provably never
   * applied (see `reconcileAcceptedButUnapplied`), then for every `pending`
   * proposal — including one just reopened — ensures its card Surface
   * exists at the deterministic id. A card Surface that survived a daemon
   * restart on disk is already fully clickable —
   * `handleFastMutation`/`resolve` resolve against the store directly, not
   * against anything `start()` builds — so this only ever needs to recreate
   * a card that is missing entirely (e.g. the daemon crashed between
   * recording the proposal and creating its card). If a Surface already
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
        }
        continue
      }
      this.createCard(proposal)
    }
  }

  /**
   * Reopens every `accepted` Tree proposal that provably never applied
   * (issue 022 review fix): `resolve()` claims a proposal's row `accepted`
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
  }

  /** Test/shutdown hook: resolves once every enqueued resolution has settled. */
  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Builds and persists the preview card for a newly recorded proposal.
   * Never throws: a `createSurface` failure (e.g. the deterministic id
   * somehow collided) is routed through `onError` instead (issue 022 review
   * fix), exactly as the unknown-target case just below already was —
   * `notifyTreeProposal` fires after the proposal's own recording
   * transaction has committed, so a card-creation failure must never make
   * the `patch_tree` tool report a failure for a proposal that is, in fact,
   * durably recorded (which would invite the Agent to retry and record a
   * duplicate).
   */
  private createCard(proposal: TreeProposal): void {
    const target = this.store.getSurface(proposal.surfaceId)
    if (!target) {
      this.onError(
        new Error(
          `tree proposal: unknown target Surface "${proposal.surfaceId}" for proposal ` +
            `#${proposal.id} — leaving it pending without a clickable card`,
        ),
      )
      return
    }
    try {
      const surface = buildTreeProposalSurface(proposal, target)
      // Daemon-owned (the same structural-defense contract as approval
      // cards): the Agent must never be able to rewrite this card's preview
      // or pre-set its `decision.*` state after the human has read it.
      this.store.createSurface(surface, 'job', { origin: 'trusted:system', daemonOwned: true })
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * The persisted daemon-owned card is the only clickable card — the same
   * stance `ApprovalSurfaceManager.handleFastMutation` takes
   * (approval-surface.ts) — enforced by two checks, both required (issue
   * 022 review fix): `treeProposalIdFromSurfaceId`'s strict grammar is a
   * cheap shape pre-filter, not proof the click landed on the real card, so
   * a click must also (a) target the exact canonical id for that proposal
   * — never an alias a looser grammar could once parse — and (b) land on a
   * Surface this manager itself created (`isSurfaceDaemonOwned`). Without
   * both, the Agent could `create_surface` an innocuous-looking card at (or
   * near) the canonical id with a `Button` declaring
   * `{ path: 'fast', stateKey: 'decision.accept', payload: { value: true } }`
   * and have a single user tap apply the proposal's operations to the
   * pinned Surface with `bypassPin: true` — no preview, no consent.
   */
  private handleFastMutation(notice: FastMutationNotice): void {
    if (notice.stateKey !== DECISION_ACCEPT_KEY && notice.stateKey !== DECISION_REJECT_KEY) return
    if (!notice.value) return
    const proposalId = treeProposalIdFromSurfaceId(notice.surfaceId)
    if (proposalId === undefined) return // not a card-surface id shape at all
    if (notice.surfaceId !== treeProposalSurfaceId(proposalId)) return // not the canonical id
    if (!this.store.isSurfaceDaemonOwned(notice.surfaceId)) return // not the daemon's own card
    // Cheap pre-filter only: `resolve()` re-checks this itself, against the
    // store, at the moment it actually runs.
    const proposal = this.store.getTreeProposal(proposalId)
    if (!proposal || proposal.status !== 'pending') return
    const decision = notice.stateKey === DECISION_ACCEPT_KEY ? 'accept' : 'reject'
    this.enqueue(() => this.resolve(proposalId, notice.surfaceId, decision))
  }

  private async resolve(
    proposalId: number,
    cardSurfaceId: string,
    decision: 'accept' | 'reject',
  ): Promise<void> {
    const proposal = this.store.getTreeProposal(proposalId)
    if (!proposal || proposal.status !== 'pending') return // resolved by a racing click already

    // `surface.tree_proposal_accepted`/`_rejected` interpolate the target's
    // own `surfaceId`, which is attacker-influenceable for a Surface built
    // from an imported Template (issue 022 review fix, mirrors
    // `recordTreeProposal`'s own `surface.tree_proposal` entry in
    // surface-engine.ts) — so the origin folds in the target's stored
    // `content_origin` instead of a hardcoded `trusted:system`, and the
    // interpolated id is neutralized and truncated exactly as the pin
    // event's title is (`TARGET_FIELD_MAX_CHARS`).
    const targetContentOrigin = this.store.surfaceProvenance(proposal.surfaceId)?.contentOrigin
    const resolutionEventOrigin = effectiveOrigin([targetContentOrigin], 'trusted:system')
    const targetId = truncate(neutralizeDelimiters(proposal.surfaceId), TARGET_FIELD_MAX_CHARS)

    if (decision === 'reject') {
      const resolved = this.store.resolveTreeProposal(proposalId, 'rejected')
      if (!resolved) return
      this.store.spacesEngine.appendEvent(proposal.spaceId, {
        type: 'surface.tree_proposal_rejected',
        text: `Rejected a proposed tree change for Surface "${targetId}"`,
        origin: resolutionEventOrigin,
        payload: { surfaceId: proposal.surfaceId, proposalId },
      })
      this.archive(cardSurfaceId)
      return
    }

    const currentVersion = this.store.getSurfaceVersion(proposal.surfaceId)
    if (!currentVersion || currentVersion.treeVersion !== proposal.expectedTreeVersion) {
      // Stale: the target's tree moved since this proposal was recorded.
      // Refuse visibly and reset the pressed decision key so a fixed-up
      // proposal (there is none automatically — the Agent would have to
      // re-propose) does not leave the button stuck at `true`. The
      // proposal itself stays `pending` — `resolveTreeProposal` is never
      // called on this path.
      this.refuseAccept(cardSurfaceId, STALE_PROPOSAL_MESSAGE, { resetDecision: true })
      return
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
    const claimed = this.store.resolveTreeProposal(proposalId, 'accepted')
    if (!claimed) return

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
      // above passed. Reopen the row back to `pending` (issue 022 review
      // fix) so the proposal is not stuck `accepted` forever with no way to
      // retry, log the failure, and leave the card in place with the
      // refusal Caption explaining it, rather than silently discarding the
      // failure. The pressed decision key is reset, same as the stale path
      // above, since the proposal is pending again and a plain re-click
      // should be enough once the Agent re-proposes or the binding is
      // restored.
      this.onError(error)
      this.store.reopenTreeProposal(proposalId)
      this.refuseAccept(cardSurfaceId, APPLY_FAILED_MESSAGE, { resetDecision: true })
      return
    }

    this.store.spacesEngine.appendEvent(proposal.spaceId, {
      type: 'surface.tree_proposal_accepted',
      text: `Accepted a proposed tree change for Surface "${targetId}"`,
      origin: resolutionEventOrigin,
      payload: { surfaceId: proposal.surfaceId, proposalId },
    })
    this.archive(cardSurfaceId)
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
          path: ERROR_CAPTION_PATH,
          value: errorCaptionNode(message),
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

  /** Serializes async resolution work; every entry terminates in its own `catch` (never an unhandled rejection). */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.catch(() => {}).then(() => work().catch((error) => this.onError(error)))
  }
}
