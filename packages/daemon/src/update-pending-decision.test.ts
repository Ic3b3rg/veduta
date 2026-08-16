import { describe, expect, it } from 'vitest'
import {
  UpdatePendingDecisionAdapter,
  type UpdateDecisionSource,
} from './update-pending-decision.ts'
import type { UpdateDecisionRecord } from './update-decisions.ts'

function pendingRecord(): UpdateDecisionRecord {
  return {
    version: '1.1.0',
    available: { version: '1.1.0', notes: 'Bug fixes', migratesData: false },
    status: 'pending',
    createdAt: '2026-08-16T08:00:00.000Z',
  }
}

class FakeUpdateSource implements UpdateDecisionSource {
  record = pendingRecord()
  resolutions: { version: string; actor: 'trusted:user' }[] = []

  listUpdateDecisions(): UpdateDecisionRecord[] {
    return [this.record]
  }

  getUpdateDecision(version: string): UpdateDecisionRecord | undefined {
    return version === this.record.version ? this.record : undefined
  }

  async resolveUpdateDecision(
    version: string,
    actor: 'trusted:user',
  ): Promise<UpdateDecisionRecord> {
    this.resolutions.push({ version, actor })
    this.record = {
      ...this.record,
      status: 'resolving',
      decisionAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: actor,
    }
    return this.record
  }
}

describe('UpdatePendingDecisionAdapter', () => {
  it('projects only safe verified-offer metadata and delegates the exact version', async () => {
    const source = new FakeUpdateSource()
    const adapter = new UpdatePendingDecisionAdapter(source)

    expect(adapter.list()).toEqual([
      {
        id: 'update-offer:1.1.0',
        kind: 'update-offer',
        summary: 'Apply verified update 1.1.0',
        scope: { type: 'space', spaceId: 'spc-system' },
        allowedResolutions: ['apply'],
        state: 'pending',
        decisionSurfaceId: 'srf-update',
        createdAt: '2026-08-16T08:00:00.000Z',
      },
    ])

    await expect(
      adapter.resolve('update-offer:1.1.0', 'apply', 'trusted:user'),
    ).resolves.toMatchObject({
      state: 'resolving',
      decisionAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: 'trusted:user',
    })
    expect(source.resolutions).toEqual([{ version: '1.1.0', actor: 'trusted:user' }])
  })

  it.each([
    ['applied', 'applied'],
    ['rolled-back', 'rolled-back'],
    ['refused', 'refused'],
    ['stale', 'stale'],
    ['failed', 'failed'],
  ] as const)('maps %s to terminal outcome %s', (status, outcome) => {
    const source = new FakeUpdateSource()
    source.record = {
      ...pendingRecord(),
      status,
      resolvedAt: '2026-08-16T08:02:00.000Z',
      resolvedBy: 'trusted:user',
    }
    const decision = new UpdatePendingDecisionAdapter(source).list()[0]
    expect(decision).toMatchObject({ state: 'terminal', outcome })
  })
})
