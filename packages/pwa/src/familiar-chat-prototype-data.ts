import { SurfaceSchema } from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'

// Disposable fixtures for #228. No Gateway, model connection, or persistent writes.
export const prototypeNow = Date.parse('2026-10-10T10:00:00Z')
export const beforeWalk = 'Friday, 18:30 — 40-minute walk after work.'
export const afterWalk = 'Saturday, 10:00 — 40-minute walk before lunch.'

export function weeklyPlan(moved = false) {
  return SurfaceSchema.parse({
    id: 'srf-prototype-week',
    spaceId: 'spc-prototype-health',
    title: 'Weekly plan',
    pinned: true,
    pinnable: true,
    presentation: 'full',
    tree: {
      id: 'week',
      type: 'Box',
      children: [
        { id: 'week-title', type: 'Title', props: { text: 'A little movement, every day' } },
        {
          id: 'week-description',
          type: 'Text',
          props: { text: '12–18 October · Three walks and room to recover.' },
        },
        {
          id: 'week-days',
          type: 'Markdown',
          props: {
            text: `### Monday\n18:30 — 30-minute walk. A gentle start to the week.\n\n### Wednesday\n18:30 — 30-minute walk. Take the park route.\n\n### ${moved ? 'Saturday' : 'Friday'}\n${moved ? afterWalk : beforeWalk}\n\n### The other days\nKeep them flexible. Rest, stretch, or take a short walk when it feels right.`,
          },
        },
      ],
    },
    state: {},
    freshness: { updatedAt: new Date(prototypeNow).toISOString(), updatedBy: 'agent' },
  })
}

export const prototypeNotes = SurfaceSchema.parse({
  ...weeklyPlan(),
  id: 'srf-prototype-notes',
  title: 'Notes for the week',
  pinned: false,
  tree: {
    id: 'notes',
    type: 'Box',
    children: [
      { id: 'notes-title', type: 'Title', props: { text: 'Keep it manageable' } },
      {
        id: 'notes-body',
        type: 'Markdown',
        props: {
          text: '## What is working\nA short walk after work makes it easier to switch off. The park is close enough to fit into an ordinary evening.\n\n## What to watch\nFriday is usually busy. Leave enough time to get home without rushing.\n\n## At the end of the week\nNotice which days felt easy to keep. Adjust the next plan around that, rather than trying to make every day identical.',
        },
      },
    ],
  },
})

export const prototypeSpace: SpaceWithSurfaces = {
  id: 'spc-prototype-health',
  slug: 'health',
  name: 'Health',
  archived: false,
  attention: 0,
  attentionRevision: 0,
  surfaces: [weeklyPlan(), prototypeNotes],
}

export type PrototypeMessage = {
  id: number
  role: 'user' | 'assistant'
  text: string
  proposal?: boolean
  resolution?: 'accepted' | 'declined'
}

export const initialMessages: PrototypeMessage[] = [
  { id: 1, role: 'user', text: 'Help me make next week a little easier to stick to.' },
  {
    id: 2,
    role: 'assistant',
    text: 'Your **Weekly plan** has three walks and room to recover.\n\nFriday looks busy. We could move that walk to Saturday morning and leave your evening free. Would you like to review that change or talk through the plan?',
  },
]

export const longReply = `The plan works best when it fits around your week. Here is how I would approach it, one day at a time.

### Start with what is already easy

Monday and Wednesday already have a clear place in your routine: a short walk after work. Keep those familiar slots. There is less to decide when you finish the day, and you do not need to reorganize the whole evening.

The aim is a repeatable rhythm. A plan you can return to on a busy week is more useful than a perfect week that only happens once.

### Leave Friday some breathing room

Your notes say Friday is often busy. The current plan puts a 40-minute walk at 18:30, just when you may be trying to get home and finish the week. Moving that walk to Saturday morning would free the evening while keeping the same three walks.

**The proposed change would be:** Friday at 18:30 → Saturday at 10:00. The walk stays 40 minutes. Monday and Wednesday stay as they are.

### Keep the rest days flexible

Tuesday, Thursday and Sunday do not need another target. You can take a short walk, stretch, or simply leave them open. There is no missed task to make up for on those days.

1. Look at the next day, rather than the entire week.
2. Keep a smaller option for a day that gets busy.
3. Resume the plan without doubling the following day.

### Check what actually worked

At the end of the week, ask which time was easiest to keep and which one felt squeezed. That gives us something concrete to change in the next plan.

For example, if Saturday morning turns out to be family time, we can choose another slot. The useful part is learning where movement fits, rather than defending the first version of the plan.

### Before changing your Surface

Your Weekly plan is pinned. I will show the existing entry beside the proposed replacement, including its day, time and duration. You can inspect it, accept it, or decline it. Until you accept, the plan stays as it is.

Would you like to **move Friday’s walk to Saturday**?`
