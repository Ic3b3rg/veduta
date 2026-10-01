import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { SurfaceSchema } from '../../protocol/src/index.ts'

export const AGENT_ACTION_SURFACE_ID = 'srf-agent-action-demo'
export const AGENT_ACTION_SURFACE_TITLE = 'Agent action demo'

/** Generic isolated test data; the Model connection still reads the live declaration. */
export function createAgentActionSurface(baseDir: string): void {
  const store = new Store({ rootDir: join(baseDir, 'data') })
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: AGENT_ACTION_SURFACE_ID,
        spaceId: 'spc-health',
        title: AGENT_ACTION_SURFACE_TITLE,
        state: { result: 'Waiting', records: [] },
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'agent' },
        tree: {
          id: 'agent-demo-root',
          type: 'Col',
          props: { gap: 'md' },
          children: [
            { id: 'demo-result', type: 'Stat', binding: 'result', props: { label: 'Result' } },
            {
              id: 'demo-records',
              type: 'Table',
              binding: 'records',
              props: { caption: 'Completed entries', columns: ['id', 'label'] },
            },
            {
              id: 'complete-demo',
              type: 'Button',
              props: { label: 'Complete demo' },
              actions: [
                {
                  name: 'complete_demo',
                  path: 'agent',
                  payload: { request: 'Complete the Agent action demo' },
                },
              ],
            },
            {
              id: 'fail-demo',
              type: 'Button',
              props: { label: 'Try rejected demo' },
              actions: [
                {
                  name: 'fail_demo',
                  path: 'agent',
                  payload: { request: 'Try an invalid Agent action demo' },
                },
              ],
            },
          ],
        },
      }),
      'agent',
    )
  } finally {
    store.close()
  }
}
