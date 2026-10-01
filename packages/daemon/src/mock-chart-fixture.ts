import { SurfaceSchema } from '@veduta/protocol'
import { z } from 'zod'
import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'

export const WEIGHT_MEASUREMENT_REQUEST = 'mi sono pesato e sono 74 kg'

type PiToolResultMessage = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export function mockWeightTrackerInput() {
  return {
    id: 'srf-health-weight-tracker',
    title: 'Weight tracker',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Weight tracker' } },
        {
          id: 'current-weight',
          type: 'Stat',
          binding: 'currentWeight',
          props: { label: 'Current weight' },
        },
        { id: 'history-label', type: 'Text', props: { text: 'Weight history (kg)' } },
        {
          id: 'weight-history',
          type: 'Table',
          binding: 'weightRecords',
          props: { columns: ['occurredAt', 'weight'], emptyText: 'No weight recorded yet.' },
        },
        {
          id: 'weight-chart',
          type: 'Chart',
          binding: 'weightRecords',
          props: {
            type: 'line',
            xKey: 'occurredAt',
            yKey: 'weight',
            label: 'Weight history',
            xLabel: 'Recorded at',
            yLabel: 'Weight (kg)',
            emptyText: 'No weight recorded yet.',
          },
        },
      ],
    },
    state: { currentWeight: 'Not recorded', weightRecords: [] },
  }
}

/** Scripted Model connection for issue #145; all effects go through ordinary Surface tools. */
export function respondToMockWeightMeasurement(
  results: PiToolResultMessage[],
  now: Date,
): PiAssistantMessage {
  const inventory = results.find((result) => result.toolName === 'list_surfaces')
  if (!inventory) {
    return toolCallMessage('list_surfaces', {}, 'Finding the current Weight tracker.')
  }
  if (inventory.isError) {
    return piFauxAssistantMessage(`Weight was not recorded: ${toolResultText(inventory)}`)
  }
  const summaries = z
    .array(z.object({ id: z.string(), title: z.string() }))
    .safeParse(parseJson(toolResultText(inventory)))
  const selected = summaries.success
    ? summaries.data.find((surface) => surface.title === 'Weight tracker')
    : undefined
  if (!selected)
    return piFauxAssistantMessage('Weight was not recorded: create a Weight tracker first.')

  const read = results.find((result) => result.toolName === 'read_surface')
  if (!read) {
    return toolCallMessage(
      'read_surface',
      { surfaceId: selected.id },
      'Reading its canonical current value and ordered history.',
    )
  }
  const snapshot = z.object({ surface: SurfaceSchema }).safeParse(parseJson(toolResultText(read)))
  if (read.isError || !snapshot.success) {
    return piFauxAssistantMessage('Weight was not recorded: its Surface could not be read.')
  }
  const records = snapshot.data.surface.state['weightRecords']
  if (!Array.isArray(records)) {
    return piFauxAssistantMessage('Weight was not recorded: its history is unavailable.')
  }
  const patch = results.find((result) => result.toolName === 'patch_state')
  if (!patch) {
    return toolCallMessage(
      'patch_state',
      {
        surfaceId: snapshot.data.surface.id,
        operations: [
          { target: 'state', op: 'replace', path: '/currentWeight', value: '74 kg' },
          {
            target: 'state',
            op: 'replace',
            path: '/weightRecords',
            value: [...records, { occurredAt: now.toISOString(), weight: 74 }],
          },
        ],
      },
      'Recording 74 kg in the current value and the shared history and Chart source.',
    )
  }
  return piFauxAssistantMessage(
    patch.isError
      ? `Weight was not recorded: ${toolResultText(patch)}`
      : 'Recorded 74 kg in the Weight tracker current value, history, and Chart.',
  )
}
