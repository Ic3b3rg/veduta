import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import {
  SurfaceSchema,
  inputSetPlan,
  type ActionScalarSpec,
  type ActionValueSpec,
  type JsonObject,
} from '../../protocol/src/index.ts'

export const CONTROL_SURFACE_ID = 'srf-control-contract'
export const CONTROL_SURFACE_TITLE = 'Control contract'

function selection(
  type: 'Checkbox' | 'Select' | 'RadioGroup' | 'DatePicker',
  id: string,
  label: string,
  binding: string,
  spec: ActionScalarSpec,
  props: JsonObject = {},
) {
  return {
    id,
    type,
    binding,
    props: { label, ...props },
    actions: [
      {
        name: type === 'Checkbox' ? 'toggle' : 'change',
        path: 'fast',
        plan: inputSetPlan(binding, spec),
      },
    ],
  }
}

/** Generic declarations in a fresh test root, never production domain Templates. */
export function createControlSurface(baseDir: string): void {
  const rows: ActionValueSpec = {
    type: 'array',
    items: {
      type: 'object',
      identityKey: 'id',
      fields: { id: { type: 'string' }, label: { type: 'string' } },
    },
  }
  const button = {
    id: 'record-control',
    type: 'Button',
    props: { label: 'Record entry' },
    actions: [
      {
        name: 'record',
        path: 'fast',
        plan: {
          inputs: {},
          targets: { records: rows },
          steps: [
            {
              op: 'append',
              target: 'records',
              value: {
                source: 'object',
                fields: {
                  id: { source: 'metadata', name: 'recordId' },
                  label: { source: 'literal', value: 'Recorded' },
                },
              },
            },
          ],
        },
      },
    ],
  }
  const controls = [
    button,
    selection('Checkbox', 'enabled-control', 'Enabled', 'enabled', { type: 'boolean' }),
    selection(
      'Select',
      'priority-control',
      'Priority',
      'priority',
      { type: 'string', enum: ['low', 'high'] },
      {
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
      },
    ),
    selection(
      'RadioGroup',
      'cadence-control',
      'Cadence',
      'cadence',
      { type: 'string', enum: ['daily', 'weekly'] },
      {
        options: [
          { label: 'Daily', value: 'daily' },
          { label: 'Weekly', value: 'weekly' },
        ],
      },
    ),
    selection('DatePicker', 'date-control', 'Date', 'date', { type: 'string' }),
    selection(
      'DatePicker',
      'optional-date-control',
      'Optional date',
      'optionalDate',
      { type: 'string' },
      { allowEmpty: true },
    ),
  ]
  const store = new Store({ rootDir: join(baseDir, 'data') })
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: CONTROL_SURFACE_ID,
        spaceId: 'spc-health',
        title: CONTROL_SURFACE_TITLE,
        state: {
          records: [],
          enabled: false,
          priority: 'low',
          cadence: 'daily',
          date: '2026-10-01',
          optionalDate: '2024-02-28',
        },
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'agent' },
        tree: {
          id: 'control-root',
          type: 'Col',
          props: { gap: 'md' },
          children: [
            {
              id: 'records-table',
              type: 'Table',
              binding: 'records',
              props: { caption: 'Recorded entries', columns: ['id', 'label'] },
            },
            ...controls,
            ...controls
              .filter((node) => node.id !== 'optional-date-control')
              .map((node) => ({
                ...node,
                id: `disabled-${node.id}`,
                props: { ...node.props, label: `Disabled ${node.props.label}`, disabled: true },
              })),
          ],
        },
      }),
      'agent',
    )
  } finally {
    store.close()
  }
}
