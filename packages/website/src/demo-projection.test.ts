import { expect, it } from 'vitest'
import { DEMO_CREATE_REQUEST, DEMO_EDIT_REQUEST } from '@veduta/demo-data'
import { DEMO_WORK_ID, demoProjection } from './demo-projection.ts'
import { initialDemoState, transitionDemo } from './demo-state.ts'

it('projects a real pending Space decision and never creates Work before acceptance', () => {
  const state = transitionDemo(initialDemoState(), 'propose')
  const projection = demoProjection(state)
  expect(projection.spaces.some((space) => space.id === DEMO_WORK_ID)).toBe(false)
  expect(projection.pendingDecisions).toEqual([
    expect.objectContaining({
      kind: 'space-proposal',
      state: 'pending',
      allowedResolutions: ['accept', 'reject'],
    }),
  ])
  expect(projection.globalEntries[1]?.pendingDecisions).toEqual(projection.pendingDecisions)
  expect(projection.workEntries).toEqual([])
})

it('keeps Global and Work conversations separate and returns product navigation targets', () => {
  const accepted = transitionDemo(transitionDemo(initialDemoState(), 'propose'), 'accept')
  const edited = transitionDemo(transitionDemo(accepted, 'create'), 'edit')
  const projection = demoProjection(edited)
  expect(projection.pendingDecisions).toEqual([])
  expect(projection.globalEntries[1]?.targets?.[0]).toEqual({
    spaceId: DEMO_WORK_ID,
    spaceSlug: 'work',
    spaceName: 'Work',
  })
  expect(projection.globalEntries.some((entry) => entry.text === DEMO_CREATE_REQUEST)).toBe(false)
  expect(
    projection.workEntries.filter((entry) => entry.role === 'user').map((entry) => entry.text),
  ).toEqual([DEMO_CREATE_REQUEST, DEMO_EDIT_REQUEST])
  const work = projection.spaces.find((space) => space.id === DEMO_WORK_ID)
  expect(work?.surfaces[0]?.state).toMatchObject({
    topPriority: 'Talk to testers',
    tasks: [expect.objectContaining({ day: 'Tuesday' }), expect.anything(), expect.anything()],
  })
})

it('shows rejection without creating a Space and permits a new proposal', () => {
  const rejected = transitionDemo(transitionDemo(initialDemoState(), 'propose'), 'reject')
  const projection = demoProjection(rejected)
  expect(projection.spaces.some((space) => space.id === DEMO_WORK_ID)).toBe(false)
  expect(projection.globalEntries[1]?.text).toContain('Rejected:')
  expect(() => transitionDemo(rejected, 'create')).toThrow('Create Work first')
  expect(transitionDemo(rejected, 'propose').stage).toBe('proposed')
})
