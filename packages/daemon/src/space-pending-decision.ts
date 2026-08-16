import {
  formatPendingDecisionId,
  pendingDecisionNativeId,
  PendingDecisionSchema,
  type PendingDecision,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import type { PendingDecisionAdapter } from './pending-decision-service.ts'
import { boundedDecisionText } from './pending-decision-summary.ts'
import type { SpaceProposal, SpacesEngine } from './spaces-engine.ts'

const SUMMARY_MAX_CHARS = 500
const SUMMARY_OVERHEAD = 'Create Space “”'.length

type SpaceProposalSource = Pick<
  SpacesEngine,
  'listSpaceProposals' | 'getSpaceProposal' | 'resolveSpaceProposal'
>

export class SpacePendingDecisionAdapter implements PendingDecisionAdapter {
  readonly kind = 'space-proposal' as const

  constructor(private readonly source: SpaceProposalSource) {}

  list(): PendingDecision[] {
    return this.source.listSpaceProposals().map((proposal) => this.toDecision(proposal))
  }

  get(id: string): PendingDecision | undefined {
    const nativeId = pendingDecisionNativeId(id, this.kind)
    if (nativeId === undefined) return undefined
    const proposal = this.source.getSpaceProposal(nativeId)
    return proposal ? this.toDecision(proposal) : undefined
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> {
    if (actor !== 'trusted:user') throw new Error('Space proposal resolution requires trusted:user')
    if (resolution !== 'accept' && resolution !== 'reject') {
      throw new Error(`unsupported Space proposal resolution: ${resolution}`)
    }
    const nativeId = pendingDecisionNativeId(id, this.kind)
    if (nativeId === undefined) throw new Error(`invalid Space proposal Pending decision id: ${id}`)
    return this.toDecision(this.source.resolveSpaceProposal(nativeId, resolution, actor))
  }

  private toDecision(proposal: SpaceProposal): PendingDecision {
    const name = boundedDecisionText(proposal.name, SUMMARY_MAX_CHARS - SUMMARY_OVERHEAD)
    const base = {
      id: formatPendingDecisionId(this.kind, proposal.id),
      kind: this.kind,
      summary: `Create Space “${name || 'Untitled'}”`,
      scope: { type: 'global' } as const,
      allowedResolutions: ['accept', 'reject'] as const,
      createdAt: proposal.createdAt,
    }

    if (proposal.status === 'pending') {
      return PendingDecisionSchema.parse({ ...base, state: 'pending' })
    }
    if (proposal.status === 'resolving') {
      return PendingDecisionSchema.parse({
        ...base,
        state: 'resolving',
        decisionAt: proposal.decisionAt ?? proposal.createdAt,
        resolvedBy: 'trusted:user',
      })
    }
    return PendingDecisionSchema.parse({
      ...base,
      state: 'terminal',
      outcome:
        proposal.status === 'accepted'
          ? 'accepted'
          : proposal.status === 'rejected'
            ? 'rejected'
            : 'failed',
      ...(proposal.decisionAt === undefined ? {} : { decisionAt: proposal.decisionAt }),
      resolvedAt: proposal.resolvedAt ?? proposal.decisionAt ?? proposal.createdAt,
      ...(proposal.resolvedBy === undefined ? {} : { resolvedBy: proposal.resolvedBy }),
    })
  }
}
