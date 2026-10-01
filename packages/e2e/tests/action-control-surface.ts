import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { SurfaceSchema, inputSetPlan } from '../../protocol/src/index.ts'

export const ACTION_CONTROL_SURFACE_ID = 'srf-remaining-actions'
export const ACTION_CONTROL_SURFACE_TITLE = 'Remaining actions'

/** A generic declared composition in the isolated stack; no production domain Template. */
export function createActionControlSurface(baseDir: string): void {
  const store = new Store({ rootDir: join(baseDir, 'data') })
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: ACTION_CONTROL_SURFACE_ID,
        spaceId: 'spc-health',
        title: ACTION_CONTROL_SURFACE_TITLE,
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'agent' },
        state: { quiet: false, city: 'rm', enabled: true, records: [] },
        tree: {
          id: 'action-controls',
          type: 'Col',
          children: [
            {
              id: 'quiet-control',
              type: 'Switch',
              binding: 'quiet',
              props: { label: 'Quiet hours' },
              actions: [
                { name: 'toggle', path: 'fast', plan: inputSetPlan('quiet', { type: 'boolean' }) },
              ],
            },
            {
              id: 'city-control',
              type: 'Combobox',
              binding: 'city',
              props: {
                label: 'City',
                options: [
                  { label: 'Rome', value: 'rm' },
                  { label: 'Milan', value: 'mi' },
                ],
              },
              actions: [
                {
                  name: 'change',
                  path: 'fast',
                  plan: inputSetPlan('city', { type: 'string', enum: ['rm', 'mi'] }),
                },
              ],
            },
            {
              id: 'entry-control',
              type: 'ListItem',
              props: { label: 'Record entry', detail: 'Save a record' },
              actions: [
                {
                  name: 'click',
                  path: 'fast',
                  plan: {
                    inputs: {},
                    targets: {
                      records: {
                        type: 'array',
                        items: {
                          type: 'object',
                          identityKey: 'id',
                          fields: { id: { type: 'string' }, label: { type: 'string' } },
                        },
                      },
                    },
                    steps: [
                      {
                        op: 'append',
                        target: 'records',
                        value: {
                          source: 'object',
                          fields: {
                            id: { source: 'metadata', name: 'recordId' },
                            label: { source: 'literal', value: 'Saved' },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'rule-control',
              type: 'Automation',
              binding: 'enabled',
              props: { label: 'Example rule', schedule: 'Each morning' },
              actions: [
                {
                  name: 'toggle',
                  path: 'fast',
                  plan: inputSetPlan('enabled', { type: 'boolean' }),
                },
              ],
            },
            {
              id: 'saved-records',
              type: 'Table',
              binding: 'records',
              props: { caption: 'Saved records', columns: ['id', 'label'] },
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
