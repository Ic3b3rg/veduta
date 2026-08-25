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
})
