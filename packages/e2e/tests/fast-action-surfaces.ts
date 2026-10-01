import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { SurfaceSchema, type ActionValueSpec } from '../../protocol/src/index.ts'

export const ITEM_SURFACE_ID = 'srf-action-items'
export const MEASUREMENT_SURFACE_ID = 'srf-action-measurements'
export const SEED_ITEM_ID = 'stable-seed'

const items: ActionValueSpec = {
  type: 'array',
  items: {
    type: 'object',
    identityKey: 'id',
    fields: { id: { type: 'string' }, label: { type: 'string' }, status: { type: 'string' } },
  },
}

/** Unrelated declarative compositions exercise the production Action contract in an isolated root. */
export function createFastActionSurfaces(baseDir: string): void {
  const store = new Store({ rootDir: join(baseDir, 'data') })
  const freshness = { updatedAt: new Date().toISOString(), updatedBy: 'agent' }
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: ITEM_SURFACE_ID,
        spaceId: 'spc-health',
        title: 'Item collection',
        freshness,
        state: { draft: '', items: [{ id: SEED_ITEM_ID, label: 'Seed item', status: 'open' }] },
        tree: {
          id: 'items-root',
          type: 'Box',
          props: { gap: 'md' },
          children: [
            {
              id: 'items-table',
              type: 'Table',
              binding: 'items',
              props: { caption: 'Items', columns: ['id', 'label', 'status'] },
            },
            {
              id: 'items-form',
              type: 'Form',
              props: { label: 'Add item', submitLabel: 'Add item' },
              children: [
                {
                  id: 'item-draft',
                  type: 'Input',
                  binding: 'draft',
                  props: { label: 'Item label' },
                },
              ],
              actions: [
                {
                  name: 'submit',
                  path: 'fast',
                  plan: {
                    inputs: { draft: { type: 'string' } },
                    targets: { items, draft: { type: 'string' } },
                    steps: [
                      {
                        op: 'append',
                        target: 'items',
                        value: {
                          source: 'object',
                          fields: {
                            id: { source: 'metadata', name: 'recordId' },
                            label: { source: 'input', name: 'draft' },
                            status: { source: 'literal', value: 'open' },
                          },
                        },
                      },
                      { op: 'clear', target: 'draft', value: '' },
                    ],
                  },
                },
              ],
            },
            {
              id: 'update-seed',
              type: 'Button',
              props: { label: 'Update seed item' },
              actions: [
                {
                  name: 'update',
                  path: 'fast',
                  plan: {
                    inputs: {},
                    targets: { items },
                    steps: [
                      {
                        op: 'update',
                        target: 'items',
                        selector: { source: 'literal', value: SEED_ITEM_ID },
                        fields: { status: { source: 'literal', value: 'completed' } },
                        missing: 'reject',
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'remove-seed',
              type: 'Button',
              props: { label: 'Remove seed item' },
              actions: [
                {
                  name: 'remove',
                  path: 'fast',
                  plan: {
                    inputs: {},
                    targets: { items },
                    steps: [
                      {
                        op: 'remove',
                        target: 'items',
                        selector: { source: 'literal', value: SEED_ITEM_ID },
                        missing: 'noop',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
      'agent',
    )
    store.createSurface(
      SurfaceSchema.parse({
        id: MEASUREMENT_SURFACE_ID,
        spaceId: 'spc-health',
        title: 'Measurement log',
        freshness,
        state: { draftValue: '7.5', currentValue: 0, records: [] },
        tree: {
          id: 'measurements-root',
          type: 'Box',
          props: { gap: 'md' },
          children: [
            {
              id: 'current-measurement',
              type: 'Stat',
              binding: 'currentValue',
              props: { label: 'Current measurement' },
            },
            {
              id: 'measurements-table',
              type: 'Table',
              binding: 'records',
              props: { caption: 'Measurements', columns: ['id', 'value', 'recordedAt'] },
            },
            {
              id: 'measurement-form',
              type: 'Form',
              props: { label: 'Record measurement', submitLabel: 'Record measurement' },
              children: [
                {
                  id: 'measurement-draft',
                  type: 'Input',
                  binding: 'draftValue',
                  props: { label: 'New measurement', valueType: 'number' },
                },
              ],
              actions: [
                {
                  name: 'submit',
                  path: 'fast',
                  plan: {
                    inputs: { draftValue: { type: 'number' } },
                    targets: {
                      draftValue: { type: 'string' },
                      currentValue: { type: 'number' },
                      records: {
                        type: 'array',
                        items: {
                          type: 'object',
                          identityKey: 'id',
                          fields: {
                            id: { type: 'string' },
                            value: { type: 'number' },
                            recordedAt: { type: 'string' },
                          },
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
                            value: { source: 'input', name: 'draftValue' },
                            recordedAt: { source: 'metadata', name: 'now' },
                          },
                        },
                      },
                      {
                        op: 'set',
                        target: 'currentValue',
                        value: { source: 'input', name: 'draftValue' },
                      },
                      { op: 'clear', target: 'draftValue', value: '' },
                    ],
                  },
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
