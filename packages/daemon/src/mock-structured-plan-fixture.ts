import { SurfaceSchema } from '@veduta/protocol'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

/** Exact deterministic model fixture for the issue #147 browser journey, outside Gateway interpretation. */
export const STRUCTURED_PLAN_REQUEST =
  'data la mia dieta fammi una scheda per la palestra 3 giorni a settimana'
type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export function respondToStructuredPlan(results: ToolResult[]): PiAssistantMessage {
  if (!results.some((result) => result.toolName === 'list_surfaces')) {
    return toolCallMessage(
      'list_surfaces',
      {},
      'Checking the current Surfaces before composing a separate plan.',
    )
  }
  const created = results.find((result) => result.toolName === 'create_surface')
  if (!created)
    return toolCallMessage(
      'create_surface',
      structuredPlanInput(),
      'Composing three sessions with exercises, repetitions, rest, progression, and safety guidance.',
    )
  if (created.isError)
    return piFauxAssistantMessage(`The plan was not created: ${toolResultText(created)}`)
  const read = results.find((result) => result.toolName === 'read_surface')
  if (!read)
    return toolCallMessage(
      'read_surface',
      { surfaceId: 'srf-structured-plan' },
      'Checking the canonical plan before describing its content.',
    )
  const parsed = parseJson(toolResultText(read))
  const surface = SurfaceSchema.safeParse(isRecord(parsed) ? parsed['surface'] : undefined)
  if (read.isError || !surface.success)
    return piFauxAssistantMessage(
      'The committed plan could not be verified; no content summary is available.',
    )
  const sessions =
    surface.data.tree.children
      ?.filter((node) => node.type === 'Col')
      .flatMap(
        (node) =>
          node.children
            ?.filter((child) => child.type === 'Title')
            .map((child) => child.props?.['text']) ?? [],
      )
      .filter((value): value is string => typeof value === 'string') ?? []
  return piFauxAssistantMessage(`Saved ${surface.data.title}: ${sessions.join('; ')}.`)
}

function structuredPlanInput(): Record<string, unknown> {
  const sessions = [
    { title: 'Session 1 — Strength', exercise: 'Squat', sets: '3 × 8', rest: '90 seconds' },
    { title: 'Session 2 — Upper body', exercise: 'Row', sets: '3 × 10', rest: '60 seconds' },
    { title: 'Session 3 — Full body', exercise: 'Deadlift', sets: '3 × 6', rest: '120 seconds' },
  ]
  return {
    id: 'srf-structured-plan',
    title: 'Gym plan — 3 days',
    state: {},
    tree: {
      id: 'plan-root',
      type: 'Box',
      children: [
        { id: 'plan-title', type: 'Title', props: { text: 'Gym plan — 3 days' } },
        {
          id: 'plan-caption',
          type: 'Caption',
          props: {
            text: 'A starting plan to discuss with a qualified trainer; it does not infer missing diet or health details.',
          },
        },
        ...sessions.map((session, index) => ({
          id: `session-${index + 1}`,
          type: 'Col',
          children: [
            {
              id: `session-title-${index + 1}`,
              type: 'Title',
              props: { text: session.title, level: 3 },
            },
            {
              id: `session-exercises-${index + 1}`,
              type: 'Table',
              props: {
                caption: session.title,
                columns: ['exercise', 'sets', 'rest'],
                rows: [{ exercise: session.exercise, sets: session.sets, rest: session.rest }],
              },
            },
          ],
        })),
        {
          id: 'plan-progression',
          type: 'ListItem',
          props: {
            label: 'Progression',
            detail: 'Add one repetition before increasing load. Keep the movement controlled.',
          },
        },
        {
          id: 'plan-safety',
          type: 'Markdown',
          props: {
            text: '**Safety:** stop if you feel sharp pain.\n\n- Warm up for 5 minutes.\n- Keep a rest day between sessions.\n- Ask a qualified trainer to check your technique.',
          },
        },
      ],
    },
  }
}
