import {
  formatPendingDecisionId,
  pendingDecisionNativeId,
  PendingDecisionSchema,
  type PendingDecision,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import type { PendingDecisionAdapter } from './pending-decision-service.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import type { UpdateDecisionRecord } from './update-decisions.ts'
import { UPDATE_SURFACE_ID } from './update-surface.ts'

export interface UpdateDecisionSource {
  listUpdateDecisions(): UpdateDecisionRecord[]
  getUpdateDecision(version: string): UpdateDecisionRecord | undefined
  resolveUpdateDecision(version: string, actor: 'trusted:user'): Promise<UpdateDecisionRecord>
}

export class UpdatePendingDecisionAdapter implements PendingDecisionAdapter {
  readonly kind = 'update-offer' as const

  constructor(private readonly source: UpdateDecisionSource) {}

  list(): PendingDecision[] {
    return this.source.listUpdateDecisions().map((record) => this.toDecision(record))
  }

  get(id: string): PendingDecision | undefined {
    const version = pendingDecisionNativeId(id, this.kind)
    if (version === undefined) return undefined
    const record = this.source.getUpdateDecision(version)
    return record ? this.toDecision(record) : undefined
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> {
    if (actor !== 'trusted:user') throw new Error('update resolution requires trusted:user')
    if (resolution !== 'apply') {
      throw new Error(`unsupported update resolution: ${resolution}`)
    }
    const version = pendingDecisionNativeId(id, this.kind)
    if (version === undefined) throw new Error(`invalid update Pending decision id: ${id}`)
    return this.toDecision(await this.source.resolveUpdateDecision(version, actor))
  }

  private toDecision(record: UpdateDecisionRecord): PendingDecision {
    const base = {
      id: formatPendingDecisionId(this.kind, record.version),
      kind: this.kind,
      summary: `Apply verified update ${record.version}`,
      scope: { type: 'space', spaceId: SYSTEM_SPACE_ID } as const,
      allowedResolutions: ['apply'] as const,
      createdAt: record.createdAt,
    }

    if (record.status === 'pending') {
      return PendingDecisionSchema.parse({
        ...base,
        state: 'pending',
        decisionSurfaceId: UPDATE_SURFACE_ID,
      })
    }
    if (record.status === 'resolving') {
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
      outcome: record.status,
      ...(record.decisionAt === undefined ? {} : { decisionAt: record.decisionAt }),
      resolvedAt: record.resolvedAt ?? record.decisionAt ?? record.createdAt,
      ...(record.resolvedBy === undefined ? {} : { resolvedBy: record.resolvedBy }),
    })
  }
}
