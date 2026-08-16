import {
  formatPendingDecisionId,
  pendingDecisionNativeId,
  PendingDecisionSchema,
  type PendingDecision,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import { boundedDecisionText } from './pending-decision-summary.ts'
import type { ApprovalDecisionRecord } from './trust-layer.ts'
import type { PendingDecisionAdapter } from './pending-decision-service.ts'

const SUMMARY_MAX_CHARS = 500

export interface ApprovalDecisionSource {
  listApprovalDecisions(): ApprovalDecisionRecord[]
  getApprovalDecision(id: string): ApprovalDecisionRecord | undefined
  resolve(id: string, resolution: 'approve' | 'reject'): Promise<void>
}

export class ApprovalPendingDecisionAdapter implements PendingDecisionAdapter {
  readonly kind = 'approval' as const

  constructor(private readonly source: ApprovalDecisionSource) {}

  list(): PendingDecision[] {
    return this.source.listApprovalDecisions().map((record) => this.toDecision(record))
  }

  get(id: string): PendingDecision | undefined {
    const nativeId = pendingDecisionNativeId(id, this.kind)
    if (nativeId === undefined) return undefined
    const record = this.source.getApprovalDecision(nativeId)
    return record ? this.toDecision(record) : undefined
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> {
    if (actor !== 'trusted:user') throw new Error('approval resolution requires trusted:user')
    if (resolution !== 'approve' && resolution !== 'reject') {
      throw new Error(`unsupported approval resolution: ${resolution}`)
    }
    const nativeId = pendingDecisionNativeId(id, this.kind)
    if (nativeId === undefined) throw new Error(`invalid approval Pending decision id: ${id}`)
    await this.source.resolve(nativeId, resolution)
    const record = this.source.getApprovalDecision(nativeId)
    if (!record) throw new Error(`approval disappeared after resolution: ${nativeId}`)
    return this.toDecision(record)
  }

  private toDecision(record: ApprovalDecisionRecord): PendingDecision {
    const summary = boundedDecisionText(record.title, SUMMARY_MAX_CHARS)
    const base = {
      id: formatPendingDecisionId(this.kind, record.id),
      kind: this.kind,
      summary: summary || 'Approval required',
      scope:
        record.spaceId === undefined
          ? ({ type: 'global' } as const)
          : ({ type: 'space', spaceId: record.spaceId } as const),
      allowedResolutions: ['approve', 'reject'] as const,
      createdAt: record.createdAt,
    }

    if (record.status === 'pending') {
      return PendingDecisionSchema.parse({
        ...base,
        state: 'pending',
        ...(record.surfaceId === undefined ? {} : { decisionSurfaceId: record.surfaceId }),
      })
    }
    if (record.status === 'executing') {
      return PendingDecisionSchema.parse({
        ...base,
        state: 'resolving',
        decisionAt: record.decisionAt ?? record.createdAt,
        resolvedBy: 'trusted:user',
      })
    }

    return PendingDecisionSchema.parse({
      ...base,
      state: 'terminal',
      outcome: approvalOutcome(record),
      ...(record.decisionAt === undefined ? {} : { decisionAt: record.decisionAt }),
      resolvedAt:
        record.decisionAt ?? (record.status === 'expired' ? record.expiresAt : record.createdAt),
      ...(record.status === 'expired' ? {} : { resolvedBy: 'trusted:user' as const }),
    })
  }
}

function approvalOutcome(record: ApprovalDecisionRecord): PendingDecision['outcome'] {
  if (record.status === 'rejected') return 'rejected'
  if (record.status === 'expired') return 'expired'
  if (record.status === 'indeterminate') return 'indeterminate'
  return record.outcome === 'executed' ? 'executed' : 'failed'
}
