import {
  DEMO_CREATE_REQUEST,
  DEMO_EDIT_REQUEST,
  DEMO_SPACE_REQUEST,
  DEMO_SURFACE_ID,
  demoSurfaceInput,
  demoPlanState,
} from '@veduta/demo-data'
import { SurfaceSchema } from '@veduta/protocol'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { piFauxAssistantMessage, type PiChatContext } from './pi-provider-bridge.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

/** A scripted model only: ordinary Gateway tools own validation, commits and Event delivery. */
export function respondToProductDemo(text: string, results: ToolResult[]) {
  if (text === DEMO_SPACE_REQUEST) {
    const proposal = results.find((result) => result.toolName === 'propose_space')
    if (!proposal)
      return toolCallMessage(
        'propose_space',
        { name: 'Work', reason: 'Keep work plans and priorities together.' },
        'Preparing Work for your confirmation.',
      )
    return piFauxAssistantMessage(
      proposal.isError ? 'Work was not proposed.' : 'Review the proposal to create Work.',
    )
  }
  if (text !== DEMO_CREATE_REQUEST && text !== DEMO_EDIT_REQUEST) return undefined
  const editing = text === DEMO_EDIT_REQUEST
  const failure = results.find((result) => result.isError)
  if (failure)
    return piFauxAssistantMessage(
      `Weekly plan was not ${editing ? 'updated' : 'created'}: ${toolResultText(failure)}`,
    )
  if (!editing && !results.some((result) => result.toolName === 'list_surfaces'))
    return toolCallMessage('list_surfaces', {}, 'Checking the current Surfaces in Work.')
  if (!editing && !results.some((result) => result.toolName === 'create_surface'))
    return toolCallMessage(
      'create_surface',
      demoSurfaceInput(),
      'Preparing three priorities for the week.',
    )
  const patched = results.some((result) => result.toolName === 'patch_state')
  const reads = results.filter((result) => result.toolName === 'read_surface')
  const read = reads.at(-1)
  if (!read || (patched && reads.length < 2))
    return toolCallMessage(
      'read_surface',
      { surfaceId: DEMO_SURFACE_ID },
      'Checking the saved Weekly plan.',
    )
  const parsed = parseJson(toolResultText(read))
  const surface = SurfaceSchema.safeParse(isRecord(parsed) ? parsed['surface'] : undefined)
  if (!surface.success)
    return piFauxAssistantMessage(
      `Weekly plan was not ${editing ? 'updated' : 'verified'}: its saved content is unavailable.`,
    )
  if (editing && !patched)
    return toolCallMessage(
      'patch_state',
      {
        surfaceId: DEMO_SURFACE_ID,
        operations: Object.entries(demoPlanState(true)).map(([key, value]) => ({
          target: 'state',
          op: 'replace',
          path: `/${key}`,
          value,
        })),
      },
      'Moving tester interviews to Tuesday and making them the top priority.',
    )
  return piFauxAssistantMessage(
    editing
      ? 'Updated Weekly plan: Talk to testers is the top priority, on Tuesday.'
      : 'Saved Weekly plan with three priorities. You can update it through Chat.',
  )
}
