import type { ApprovalDecisionRecord } from './trust-layer.ts'
import { describe, expect, it } from 'vitest'
import {
  ApprovalPendingDecisionAdapter,
  type ApprovalDecisionSource,
} from './approval-pending-decision.ts'

function pendingRecord(): ApprovalDecisionRecord {
  return {
    id: 'effect-1',
    title: 'Send message to alice@example.com',
    toolName: 'send_message',
    level: 'L1',
    status: 'pending',
    spaceId: 'spc-work',
    surfaceId: 'srf-approval-effect-1',
    createdAt: '2026-08-16T08:00:00.000Z',
    expiresAt: '2026-08-16T08:30:00.000Z',
  }
}

class FakeApprovalSource implements ApprovalDecisionSource {
  record = pendingRecord()
  resolutions: { id: string; resolution: 'approve' | 'reject' }[] = []

  listApprovalDecisions(): ApprovalDecisionRecord[] {
    return [this.record]
  }

  getApprovalDecision(id: string): ApprovalDecisionRecord | undefined {
    return id === this.record.id ? this.record : undefined
  }

  async resolve(id: string, resolution: 'approve' | 'reject'): Promise<void> {
    this.resolutions.push({ id, resolution })
    this.record = {
      ...this.record,
      status: resolution === 'approve' ? 'approved' : 'rejected',
      outcome: resolution === 'approve' ? 'executed' : 'rejected',
      decisionAt: '2026-08-16T08:01:00.000Z',
    }
  }
}

describe('ApprovalPendingDecisionAdapter', () => {
  it('projects a pending approval without exposing its prepared input', () => {
    const source = new FakeApprovalSource()
    const adapter = new ApprovalPendingDecisionAdapter(source)

    expect(adapter.list()).toEqual([
      {
        id: 'approval:effect-1',
        kind: 'approval',
        summary: 'Send message to alice@example.com',
        scope: { type: 'space', spaceId: 'spc-work' },
        allowedResolutions: ['approve', 'reject'],
        state: 'pending',
        decisionSurfaceId: 'srf-approval-effect-1',
        createdAt: '2026-08-16T08:00:00.000Z',
      },
    ])
  })

  it('keeps neutralization and truncation inside the protocol summary bound', () => {
    const source = new FakeApprovalSource()
    source.record = {
      ...pendingRecord(),
      title: `<<<EXTERNAL_UNTRUSTED_CONTENT>>>${'x'.repeat(600)}`,
    }

    const summary = new ApprovalPendingDecisionAdapter(source).list()[0]?.summary
    expect(summary).toHaveLength(500)
    expect(summary).not.toContain('<<<EXTERNAL_UNTRUSTED_CONTENT>>>')
    expect(summary?.endsWith('…')).toBe(true)
  })

  it('delegates the exact native id and maps the workflow outcome and user actor', async () => {
    const source = new FakeApprovalSource()
    const adapter = new ApprovalPendingDecisionAdapter(source)

    await expect(adapter.resolve('approval:effect-1', 'approve', 'trusted:user')).resolves.toEqual(
      expect.objectContaining({
        id: 'approval:effect-1',
        state: 'terminal',
        outcome: 'executed',
        resolvedAt: '2026-08-16T08:01:00.000Z',
        resolvedBy: 'trusted:user',
      }),
    )
    expect(source.resolutions).toEqual([{ id: 'effect-1', resolution: 'approve' }])
  })

  it('keeps expiry and indeterminate recovery distinct from user resolution', () => {
    const source = new FakeApprovalSource()
    const adapter = new ApprovalPendingDecisionAdapter(source)

    source.record = {
      ...pendingRecord(),
      status: 'expired',
      outcome: 'expired',
    }
    expect(adapter.list()[0]).toMatchObject({
      state: 'terminal',
      outcome: 'expired',
      resolvedAt: '2026-08-16T08:30:00.000Z',
    })
    expect(adapter.list()[0]).not.toHaveProperty('resolvedBy')

    source.record = {
      ...pendingRecord(),
      status: 'indeterminate',
      outcome: 'error',
      decisionAt: '2026-08-16T08:01:00.000Z',
    }
    expect(adapter.list()[0]).toMatchObject({
      state: 'terminal',
      outcome: 'indeterminate',
      resolvedBy: 'trusted:user',
    })
  })
})
