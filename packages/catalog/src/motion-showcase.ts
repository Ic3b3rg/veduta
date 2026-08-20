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
        id: 'motion-caption',
        type: 'Caption',
        props: { text: 'Only the Status region changes in the update example.' },
      },
    ],
  },
  state: { status: 'Waiting', nextCheck: 'Friday', progress: 0.55 },
  freshness: { updatedAt: '2026-08-20T10:00:00.000Z', updatedBy: 'seed' },
})
