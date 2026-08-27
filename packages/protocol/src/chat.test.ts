import { describe, expect, it } from 'vitest'
import { ChatMessageSchema } from './chat.ts'

describe('ChatMessageSchema result targets', () => {
  it('accepts bounded Space targets with an optional complete Surface target', () => {
    expect(
      ChatMessageSchema.parse({
        role: 'assistant',
        text: 'Your tracker is ready.',
        targets: [
          {
            spaceId: 'spc-health',
            spaceSlug: 'health',
            spaceName: 'Health',
            surfaceId: 'srf-weight',
            surfaceTitle: 'Weight tracker',
          },
          {
            spaceId: 'spc-work',
            spaceSlug: 'work',
            spaceName: 'Work',
          },
        ],
      }),
    ).toEqual({
      role: 'assistant',
      text: 'Your tracker is ready.',
      targets: [
        {
          spaceId: 'spc-health',
          spaceSlug: 'health',
          spaceName: 'Health',
          surfaceId: 'srf-weight',
          surfaceTitle: 'Weight tracker',
        },
        {
          spaceId: 'spc-work',
          spaceSlug: 'work',
          spaceName: 'Work',
        },
      ],
    })
  })

  it('rejects a partial Surface target that cannot produce an accessible result link', () => {
    expect(
      ChatMessageSchema.safeParse({
        role: 'assistant',
        text: 'Done.',
        targets: [
          {
            spaceId: 'spc-health',
            spaceSlug: 'health',
            spaceName: 'Health',
            surfaceId: 'srf-weight',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('carries a pending Space proposal as a resolvable chat decision', () => {
    const pendingDecision = {
      id: 'space-proposal:proposal-1',
      kind: 'space-proposal',
      summary: 'Create Space “Travel”',
      scope: { type: 'global' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-08-25T10:00:00.000Z',
    }

    expect(
      ChatMessageSchema.parse({
        role: 'assistant',
        text: 'Travel does not fit an existing Space.',
        pendingDecisions: [pendingDecision],
      }),
    ).toEqual({
      role: 'assistant',
      text: 'Travel does not fit an existing Space.',
      pendingDecisions: [pendingDecision],
    })
  })

  it('ties one daemon-authored feedback entry to its exact Pending-decision id', () => {
    const decision = {
      id: 'approval:effect-1',
      kind: 'approval',
      summary: 'Send a message',
      scope: { type: 'space', spaceId: 'spc-work' },
      allowedResolutions: ['approve', 'reject'],
      state: 'terminal',
      outcome: 'executed',
      createdAt: '2026-08-25T10:00:00.000Z',
      resolvedAt: '2026-08-25T10:01:00.000Z',
      resolvedBy: 'trusted:user',
    }
    const feedback = {
      role: 'assistant',
      text: 'Executed: Send a message.',
      decisionFeedbackId: 'approval:effect-1',
      pendingDecisions: [decision],
    }

    expect(ChatMessageSchema.parse(feedback)).toEqual(feedback)
    expect(
      ChatMessageSchema.safeParse({ ...feedback, decisionFeedbackId: 'approval:other' }).success,
    ).toBe(false)
    expect(ChatMessageSchema.safeParse({ ...feedback, role: 'user' }).success).toBe(false)
  })
})
