import { describe, expect, it } from 'vitest'
import {
  PendingDecisionListSchema,
  PendingDecisionResolveRequestSchema,
  PendingDecisionResolveResultSchema,
  PendingDecisionSchema,
  formatPendingDecisionId,
  parsePendingDecisionId,
  pendingDecisionNativeId,
} from './pending-decision.ts'

const pendingApproval = {
  id: 'approval:effect-1',
  kind: 'approval',
  summary: 'Send message to alice@example.com',
  scope: { type: 'space', spaceId: 'spc-work' },
  allowedResolutions: ['approve', 'reject'],
  state: 'pending',
  decisionSurfaceId: 'srf-approval-effect-1',
  createdAt: '2026-08-16T08:00:00.000Z',
} as const

describe('PendingDecisionSchema', () => {
  it('validates one safe channel-neutral decision contract', () => {
    expect(PendingDecisionSchema.parse(pendingApproval)).toEqual(pendingApproval)
    expect(PendingDecisionListSchema.parse({ decisions: [pendingApproval] })).toEqual({
      decisions: [pendingApproval],
    })
  })

  it('requires the id prefix and allowed resolutions to match the decision kind', () => {
    expect(
      PendingDecisionSchema.safeParse({
        ...pendingApproval,
        id: 'tree-proposal:1',
      }).success,
    ).toBe(false)
    expect(
      PendingDecisionSchema.safeParse({
        ...pendingApproval,
        allowedResolutions: ['apply'],
      }).success,
    ).toBe(false)
  })

  it('formats and parses durable ids through one kind-aware codec', () => {
    expect(formatPendingDecisionId('tree-proposal', 7)).toBe('tree-proposal:7')
    expect(parsePendingDecisionId('tree-proposal:7')).toEqual({
      kind: 'tree-proposal',
      nativeId: '7',
    })
    expect(pendingDecisionNativeId('tree-proposal:7', 'approval')).toBeUndefined()
    expect(parsePendingDecisionId('unknown:7')).toBeUndefined()
    expect(() => formatPendingDecisionId('approval', '')).toThrow(/invalid native id/)
  })

  it('requires terminal decisions to carry an outcome and resolution time', () => {
    expect(
      PendingDecisionSchema.safeParse({
        ...pendingApproval,
        state: 'terminal',
      }).success,
    ).toBe(false)

    const terminal = PendingDecisionSchema.parse({
      ...pendingApproval,
      state: 'terminal',
      outcome: 'executed',
      resolvedAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: 'trusted:user',
    })
    expect(terminal.outcome).toBe('executed')
  })

  it('distinguishes a user claim in progress from terminal resolution time', () => {
    const resolving = PendingDecisionSchema.parse({
      ...pendingApproval,
      state: 'resolving',
      decisionAt: '2026-08-16T08:01:00.000Z',
      resolvedBy: 'trusted:user',
    })
    expect(resolving).not.toHaveProperty('resolvedAt')
    expect(
      PendingDecisionSchema.safeParse({
        ...pendingApproval,
        state: 'resolving',
        resolvedAt: '2026-08-16T08:01:00.000Z',
        resolvedBy: 'trusted:user',
      }).success,
    ).toBe(false)
  })

  it('validates exact-resolution requests and authoritative replay results', () => {
    expect(PendingDecisionResolveRequestSchema.parse({ resolution: 'approve' })).toEqual({
      resolution: 'approve',
    })
    expect(
      PendingDecisionResolveResultSchema.parse({ decision: pendingApproval, replayed: true }),
    ).toEqual({ decision: pendingApproval, replayed: true })
  })
})
