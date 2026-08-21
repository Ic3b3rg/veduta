import type { PatchOperation } from '@veduta/protocol'

export const PROGRESSIVE_SURFACE_REQUEST = 'show progressive surface demo'
export const DEFAULT_PROGRESSIVE_FILL_DELAY_MS = 1_200

export function progressiveSurfaceInput(at: Date): Record<string, unknown> {
  return {
    id: `srf-progressive-${at.getTime()}`,
    title: 'Progressive trip plan',
    intent: 'Progressive trip planning demo',
    justification: 'This contributor demo must expose independent Pending regions and fallback.',
    tree: {
      id: 'progressive-root',
      type: 'Box',
      props: { gap: 'md' },
      children: [
        {
          id: 'progressive-title',
          type: 'Title',
          props: { text: 'Liguria road trip', level: 2 },
        },
        {
          id: 'progressive-caption',
          type: 'Caption',
          props: { text: 'Regions fill independently; the route preview demonstrates fallback.' },
        },
        {
          id: 'progressive-summary',
          type: 'Pending',
          props: { variant: 'text', label: 'Trip summary', lines: 3 },
        },
        {
          id: 'progressive-metrics',
          type: 'Row',
          props: { gap: 'md' },
          children: [
            {
              id: 'progressive-distance-column',
              type: 'Col',
              children: [
                {
                  id: 'progressive-distance',
                  type: 'Pending',
                  props: { variant: 'stat', label: 'Total distance' },
                },
              ],
            },
            {
              id: 'progressive-chart-column',
              type: 'Col',
              children: [
                {
                  id: 'progressive-chart',
                  type: 'Pending',
                  props: { variant: 'chart', label: 'Distance by day' },
                },
              ],
            },
          ],
        },
        {
          id: 'progressive-stops',
          type: 'Pending',
          props: { variant: 'list', label: 'Suggested stops', rows: 2 },
        },
        {
          id: 'progressive-route',
          type: 'Pending',
          props: { variant: 'image', label: 'Route preview', timeoutMs: 8_000 },
        },
      ],
    },
    state: {},
  }
}

export interface ProgressiveFillStep {
  label: string
  operation: PatchOperation
}

export const progressiveFillSteps: readonly ProgressiveFillStep[] = [
  {
    label: 'the summary',
    operation: {
      target: 'tree',
      op: 'replace',
      path: '/children/2',
      value: {
        id: 'progressive-summary',
        type: 'Text',
        props: {
          text: 'A four-day coastal route with short drives and time for unplanned stops.',
        },
      },
    },
  },
  {
    label: 'the distance',
    operation: {
      target: 'tree',
      op: 'replace',
      path: '/children/3/children/0/children/0',
      value: {
        id: 'progressive-distance',
        type: 'Stat',
        props: { label: 'Total distance', value: '286 km', detail: 'About 72 km per day' },
      },
    },
  },
  {
    label: 'the chart',
    operation: {
      target: 'tree',
      op: 'replace',
      path: '/children/3/children/1/children/0',
      value: {
        id: 'progressive-chart',
        type: 'Chart',
        props: {
          label: 'Distance by day',
          data: [
            { label: 'Day 1', value: 54 },
            { label: 'Day 2', value: 81 },
            { label: 'Day 3', value: 63 },
            { label: 'Day 4', value: 88 },
          ],
        },
      },
    },
  },
  {
    label: 'the stops',
    operation: {
      target: 'tree',
      op: 'replace',
      path: '/children/4',
      value: {
        id: 'progressive-stops',
        type: 'Col',
        children: [
          {
            id: 'progressive-stop-camogli',
            type: 'ListItem',
            props: { label: 'Camogli', detail: 'Morning harbor walk', status: 'Day 1' },
          },
          {
            id: 'progressive-stop-lerici',
            type: 'ListItem',
            props: { label: 'Lerici', detail: 'Late lunch by the castle', status: 'Day 3' },
          },
        ],
      },
    },
  },
]
