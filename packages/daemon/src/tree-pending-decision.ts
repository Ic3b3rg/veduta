import {
  formatPendingDecisionId,
  pendingDecisionNativeId,
  PendingDecisionSchema,
  type PendingDecision,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import type { PendingDecisionAdapter } from './pending-decision-service.ts'
import { boundedDecisionText } from './pending-decision-summary.ts'
import type { Store } from './store.ts'
import {
  treeProposalReviewUnavailableMessage,
  treeProposalSurfaceId,
  type TreeProposalSurfaceManager,
} from './tree-proposal.ts'
import type { TreeProposal } from './surface-engine.ts'
import { TREE_REVIEW_SUMMARY_KEY, treeProposalFallbackSummary } from './tree-proposal-preview.ts'

const NUMERIC_ID_RE = /^[1-9][0-9]*$/

export class TreePendingDecisionAdapter implements PendingDecisionAdapter {
  readonly kind = 'tree-proposal' as const

  constructor(
    private readonly store: Store,
    private readonly manager: TreeProposalSurfaceManager,
  ) {}

  list(): PendingDecision[] {
    return this.store.listTreeProposals().map((proposal) => this.toDecision(proposal))
  }

  get(id: string): PendingDecision | undefined {
    const proposalId = nativeProposalId(id)
    if (proposalId === undefined) return undefined
    const proposal = this.store.getTreeProposal(proposalId)
    return proposal ? this.toDecision(proposal) : undefined
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> {
    if (actor !== 'trusted:user') throw new Error('Tree proposal resolution requires trusted:user')
    if (resolution !== 'accept' && resolution !== 'reject') {
      throw new Error(`unsupported Tree proposal resolution: ${resolution}`)
    }
    const proposalId = nativeProposalId(id)
    if (proposalId === undefined)
      throw new Error(`invalid Tree proposal Pending decision id: ${id}`)
    const result = await this.manager.resolveDecision(proposalId, resolution, actor)
    return this.toDecision(result.proposal)
  }

  private toDecision(proposal: TreeProposal): PendingDecision {
    const target = this.store.getSurface(proposal.surfaceId)
    const targetTitle = target?.title ?? proposal.surfaceId
    const cardSurfaceId = treeProposalSurfaceId(proposal.id)
    const card = this.store.isSurfaceDaemonOwned(cardSurfaceId)
      ? this.store.getSurface(cardSurfaceId)
      : undefined
    const preparedSummary = card?.state[TREE_REVIEW_SUMMARY_KEY]
    const base = {
      id: formatPendingDecisionId(this.kind, proposal.id),
      kind: this.kind,
      summary:
        typeof preparedSummary === 'string'
          ? boundedDecisionText(preparedSummary, 500)
          : treeProposalFallbackSummary(proposal, targetTitle),
      scope: { type: 'space', spaceId: proposal.spaceId } as const,
      allowedResolutions: ['accept', 'reject'] as const,
      createdAt: proposal.createdAt,
    }
    if (proposal.status === 'pending') {
      const unavailable = treeProposalReviewUnavailableMessage(
        proposal,
        target,
        this.store.getSurfaceVersion(proposal.surfaceId)?.treeVersion,
      )
      const hasDecisionSurface =
        this.store.getSurface(cardSurfaceId) !== undefined &&
        this.store.isSurfaceDaemonOwned(cardSurfaceId)
      return PendingDecisionSchema.parse({
        ...base,
        state: 'pending',
        allowedResolutions: unavailable === undefined ? ['accept', 'reject'] : ['reject'],
        ...(hasDecisionSurface ? { decisionSurfaceId: cardSurfaceId } : {}),
      })
    }
    return PendingDecisionSchema.parse({
      ...base,
      state: 'terminal',
      outcome:
        proposal.status === 'accepted'
          ? 'accepted'
          : proposal.status === 'stale'
            ? 'stale'
            : 'rejected',
      resolvedAt: proposal.resolvedAt ?? proposal.createdAt,
      ...(proposal.resolvedBy === undefined ? {} : { resolvedBy: proposal.resolvedBy }),
    })
  }
}

function nativeProposalId(id: string): number | undefined {
  const raw = pendingDecisionNativeId(id, 'tree-proposal')
  if (raw === undefined) return undefined
  const proposalId = NUMERIC_ID_RE.test(raw) ? Number(raw) : undefined
  return proposalId !== undefined && Number.isSafeInteger(proposalId) ? proposalId : undefined
}
