import { SurfaceSchema, type Surface } from '@veduta/protocol'

export const catalogMotionShowcaseSurface: Surface = SurfaceSchema.parse({
  id: 'srf-motion-showcase',
  spaceId: 'spc-showcase',
  title: 'Surface motion showcase',
  tree: {
    id: 'motion-root',
    type: 'Box',
    props: { gap: 'md', padding: 'lg' },
    children: [
      {
        id: 'motion-title',
        type: 'Title',
        props: { text: 'Morning overview', level: 3 },
      },
      {
        id: 'motion-summary',
        type: 'Row',
        props: { gap: 'md', align: 'stretch' },
        children: [
          {
            id: 'motion-status',
            type: 'Stat',
            binding: 'status',
            props: { label: 'Status' },
          },
          {
            id: 'motion-next-check',
            type: 'Stat',
            binding: 'nextCheck',
            props: { label: 'Next check' },
          },
        ],
      },
      {
        id: 'motion-progress',
        type: 'Progress',
        binding: 'progress',
        props: { label: 'Weekly progress' },
      },
      {
        id: 'motion-activity',
        type: 'Table',
        binding: 'activity',
        props: { columns: ['item', 'status'] },
      },
      {
        id: 'motion-acknowledged',
        type: 'Checkbox',
        binding: 'acknowledged',
        props: { label: 'Acknowledge update' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'acknowledged' }],
      },
      {
        id: 'motion-transition',
        type: 'Transition',
        props: { visible: false },
        children: [
          {
            id: 'motion-transition-copy',
            type: 'Text',
            props: { text: 'Nested detail stays mounted.' },
          },
        ],
      },
      {
        id: 'motion-caption',
        type: 'Caption',
        props: {
          text: 'The update changes scalar, collection, interactive, and nested Atom content.',
        },
      },
    ],
  },
  state: {
    status: 'Waiting',
    nextCheck: 'Friday',
    progress: 0.55,
    activity: [{ id: 'scan', item: 'Scan inbox', status: 'Waiting' }],
    acknowledged: false,
  },
  freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'seed' },
})
