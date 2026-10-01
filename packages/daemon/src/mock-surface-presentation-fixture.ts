import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export const SURFACE_FULL_PRESENTATION_REQUEST = 'Make Groceries full-row'

/** The Loopback acceptance fixture learns Surface identity from the real tool inventory. */
export function respondToMockSurfacePresentation(
  text: string,
  results: ToolResult[],
): PiAssistantMessage | undefined {
  if (text !== SURFACE_FULL_PRESENTATION_REQUEST) return undefined
  const inventory = results.find((result) => result.toolName === 'list_surfaces')
  if (!inventory)
    return toolCallMessage('list_surfaces', {}, 'Finding the requested Groceries Surface.')
  if (inventory.isError)
    return piFauxAssistantMessage(`Groceries could not be found: ${toolResultText(inventory)}`)
  const candidates = parseJson(toolResultText(inventory))
  const selected = Array.isArray(candidates)
    ? candidates.find(
        (candidate) =>
          isRecord(candidate) &&
          candidate['title'] === 'Groceries' &&
          typeof candidate['id'] === 'string',
      )
    : undefined
  if (!isRecord(selected))
    return piFauxAssistantMessage('No authorable Groceries Surface was found.')
  const changed = results.find((result) => result.toolName === 'set_surface_presentation')
  if (!changed)
    return toolCallMessage(
      'set_surface_presentation',
      { surfaceId: selected['id'], presentation: 'full', userRequest: text },
      'Applying the requested full presentation to Groceries.',
    )
  return piFauxAssistantMessage(
    changed.isError
      ? `Groceries presentation could not be changed: ${toolResultText(changed)}`
      : 'Groceries now uses full presentation.',
  )
}
