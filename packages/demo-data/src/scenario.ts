import { SurfaceSchema, type JsonObject, type Surface } from '@veduta/protocol'

/** Fictional, deterministic content shared by the public tour and the mock Model connection. */
export const DEMO_SPACE_REQUEST = 'Create a Space called Work.'
export const DEMO_CREATE_REQUEST =
  'Prepare a weekly plan with three priorities: ship the prototype, talk to testers, and write release notes.'
export const DEMO_EDIT_REQUEST = 'Move tester interviews to Tuesday and make them the top priority.'
export const DEMO_SURFACE_ID = 'srf-demo-weekly-plan'

export function demoPlanState(updated = false): JsonObject {
  return {
    topPriority: updated ? 'Talk to testers' : 'Ship the prototype',
    priorities: 3,
    focusTime: '6 hours',
    tasks: updated
      ? [
          {
            priority: '1',
            task: 'Talk to testers',
            day: 'Tuesday',
            outcome: 'Three useful conversations',
          },
          {
            priority: '2',
            task: 'Ship the prototype',
            day: 'Wednesday',
            outcome: 'One working flow',
          },
          { priority: '3', task: 'Write release notes', day: 'Friday', outcome: 'A clear update' },
        ]
      : [
          {
            priority: '1',
            task: 'Ship the prototype',
            day: 'Wednesday',
            outcome: 'One working flow',
          },
          {
            priority: '2',
            task: 'Talk to testers',
            day: 'Thursday',
            outcome: 'Three useful conversations',
          },
          { priority: '3', task: 'Write release notes', day: 'Friday', outcome: 'A clear update' },
        ],
  }
}

export function demoSurface(
  spaceId: string,
  updated = false,
  at = new Date().toISOString(),
): Surface {
  return SurfaceSchema.parse({
    id: DEMO_SURFACE_ID,
    spaceId,
    title: 'Weekly plan',
    presentation: 'full',
    freshness: { updatedAt: at, updatedBy: 'agent' },
    state: demoPlanState(updated),
    tree: {
      id: 'weekly-root',
      type: 'Box',
      props: { gap: 'lg', padding: 'md' },
      children: [
        { id: 'weekly-title', type: 'Title', props: { text: 'This week, in focus', level: 2 } },
        {
          id: 'weekly-caption',
          type: 'Caption',
          props: { text: 'A sample week. Three priorities, with room to think.' },
        },
        {
          id: 'weekly-stats',
          type: 'Row',
          props: { gap: 'lg', wrap: true },
          children: [
            {
              id: 'weekly-priority',
              type: 'Stat',
              binding: 'topPriority',
              props: { label: 'Top priority' },
            },
            {
              id: 'weekly-count',
              type: 'Stat',
              binding: 'priorities',
              props: { label: 'Priorities' },
            },
            {
              id: 'weekly-focus',
              type: 'Stat',
              binding: 'focusTime',
              props: { label: 'Deep work' },
            },
          ],
        },
        { id: 'weekly-divider', type: 'Divider' },
        {
          id: 'weekly-tasks',
          type: 'Table',
          binding: 'tasks',
          props: {
            caption: 'Your weekly priorities',
            columns: ['priority', 'task', 'day', 'outcome'],
          },
        },
        {
          id: 'weekly-note',
          type: 'Text',
          props: { text: 'Keep Monday for planning and Wednesday afternoon free for deep work.' },
        },
      ],
    },
  })
}

export function demoSurfaceInput(): Record<string, unknown> {
  const { id, title, tree, state, presentation } = demoSurface('demo-work')
  return { id, title, tree, state, presentation }
}

export function demoSeed(at = new Date().toISOString()) {
  const samples = [
    {
      slug: 'home',
      name: 'Home',
      title: 'Weekend together',
      text: 'Saturday lunch for six. Pick up groceries on Friday and keep the afternoon free.',
    },
    {
      slug: 'health',
      name: 'Health',
      title: 'A little movement, every day',
      text: 'A walk after lunch, a stretch before work, and an early night. Small habits to return to.',
    },
    {
      slug: 'reading',
      name: 'Reading',
      title: 'On the reading list',
      text: 'Finish the current book, save a few notes, and choose what to read next.',
    },
  ]
  return {
    spaces: samples.map((sample) => ({
      id: `demo-${sample.slug}`,
      name: sample.name,
      slug: sample.slug,
      archived: false,
    })),
    surfaces: samples.map((sample) =>
      SurfaceSchema.parse({
        id: `srf-demo-${sample.slug}`,
        spaceId: `demo-${sample.slug}`,
        title: sample.title,
        freshness: { updatedAt: at, updatedBy: 'seed' },
        state: {},
        tree: {
          id: `demo-${sample.slug}-root`,
          type: 'Box',
          props: { gap: 'md', padding: 'md' },
          children: [
            { id: `demo-${sample.slug}-title`, type: 'Title', props: { text: sample.title } },
            { id: `demo-${sample.slug}-text`, type: 'Text', props: { text: sample.text } },
          ],
        },
      }),
    ),
  }
}
