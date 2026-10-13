import {
  ChatMessageSchema,
  PendingDecisionSchema,
  SpaceWithSurfacesSchema,
  SYSTEM_SPACE_ID,
  pendingDecisionChatFeedback,
} from '@veduta/protocol'
import {
  DEMO_CREATE_REQUEST,
  DEMO_EDIT_REQUEST,
  DEMO_SPACE_REQUEST,
  demoSeed,
  demoSurface,
} from '@veduta/demo-data'
import type { DemoState } from './demo-state.ts'

export const DEMO_WORK_ID = 'demo-work'
export const DEMO_DECISION_ID = 'space-proposal:demo-work'

/** Protocol-validated data only. AppShell owns all product layout and presentation. */
export function demoProjection(state: DemoState) {
  const seed = demoSeed(state.updatedAt)
  const hasWork = ['space', 'surface', 'edited'].includes(state.stage)
  const hasSurface = state.stage === 'surface' || state.stage === 'edited'
  const spaces = [
    ...seed.spaces.map((space) => ({
      ...space,
      surfaces: seed.surfaces.filter((surface) => surface.spaceId === space.id),
    })),
    ...(hasWork
      ? [
          {
            id: DEMO_WORK_ID,
            slug: 'work',
            name: 'Work',
            archived: false,
            surfaces: hasSurface
              ? [demoSurface(DEMO_WORK_ID, state.stage === 'edited', state.updatedAt)]
              : [],
          },
        ]
      : []),
    { id: SYSTEM_SPACE_ID, slug: 'system', name: 'System', archived: false, surfaces: [] },
  ].map((space) =>
    SpaceWithSurfacesSchema.parse({
      ...space,
      surfaces: space.surfaces.map((surface) => ({ ...surface, pinnable: false })),
    }),
  )
  const decision =
    state.stage === 'start'
      ? undefined
      : PendingDecisionSchema.parse({
          id: DEMO_DECISION_ID,
          kind: 'space-proposal',
          summary: 'Create Space “Work”',
          scope: { type: 'global' },
          allowedResolutions: ['accept', 'reject'],
          createdAt: state.updatedAt,
          ...(state.stage === 'proposed'
            ? { state: 'pending' }
            : {
                state: 'terminal',
                outcome: hasWork ? 'accepted' : 'rejected',
                resolvedAt: state.updatedAt,
                resolvedBy: 'trusted:user',
              }),
        })
  const target = { spaceId: DEMO_WORK_ID, spaceSlug: 'work', spaceName: 'Work' }
  const globalEntries = ChatMessageSchema.array().parse(
    decision
      ? [
          { role: 'user', text: DEMO_SPACE_REQUEST },
          {
            role: 'assistant',
            text: pendingDecisionChatFeedback([decision], false),
            pendingDecisions: [decision],
            ...(hasWork ? { targets: [target] } : {}),
            ...(decision.state === 'terminal' ? { decisionFeedbackId: decision.id } : {}),
          },
        ]
      : [
          {
            role: 'assistant',
            text: `This is a guided demo with fictional data. Start with: ${DEMO_SPACE_REQUEST}`,
          },
        ],
  )
  const workEntries = ChatMessageSchema.array().parse([
    ...(state.stage === 'space'
      ? [{ role: 'assistant', text: `Work is ready. Try: ${DEMO_CREATE_REQUEST}` }]
      : []),
    ...(hasSurface
      ? [
          { role: 'user', text: DEMO_CREATE_REQUEST },
          {
            role: 'assistant',
            text: 'Weekly plan is ready, with three priorities.',
            targets: [
              {
                ...target,
                surfaceId: demoSurface(DEMO_WORK_ID).id,
                surfaceTitle: 'Weekly plan',
              },
            ],
          },
        ]
      : []),
    ...(state.stage === 'edited'
      ? [
          { role: 'user', text: DEMO_EDIT_REQUEST },
          {
            role: 'assistant',
            text: 'Talk to testers is now the top priority, on Tuesday. Refresh to check that your change stays here.',
          },
        ]
      : []),
  ])
  return {
    spaces,
    globalEntries,
    workEntries,
    pendingDecisions: decision?.state === 'pending' ? [decision] : [],
  }
}
