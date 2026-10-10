import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { toolCallMessage, toolResultText } from './mock-fixture-support.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

/** Deterministic Chat acceptance examples still execute the real owning-domain tools. */
export function respondToMockSpaceControls(
  text: string,
  results: ToolResult[],
): PiAssistantMessage | undefined {
  const focused = text === 'imposta lo spazio a due colonne'
  const focusedArchive = text === 'Archive this Space'
  const archive = text === 'Archive Health' || focusedArchive
  const restore = text === 'Restore Health'
  if (!focused && !archive && !restore) return undefined
  if (archive && !focusedArchive && !results.some((result) => result.toolName === 'enter_space')) {
    return toolCallMessage(
      'enter_space',
      { spaceId: 'health' },
      'Finding Health before archiving it.',
    )
  }
  const name = focused ? 'set_space_presentation' : archive ? 'archive_space' : 'restore_space'
  const result = results.find((result) => result.toolName === name)
  if (result) return piFauxAssistantMessage(toolResultText(result))
  if (restore && !results.some((result) => result.toolName === 'list_archived_spaces')) {
    return toolCallMessage('list_archived_spaces', {}, 'Finding the archived Health Space.')
  }
  return toolCallMessage(
    name,
    {
      userRequest: text,
      ...(focusedArchive
        ? {}
        : focused
          ? { presentation: 'two-columns' }
          : { spaceId: restore ? 'spc-health' : 'health' }),
    },
    focused
      ? 'Arranging this Space in two columns.'
      : archive
        ? 'Requesting approval to archive this Space with its content preserved.'
        : 'Restoring Health.',
  )
}
