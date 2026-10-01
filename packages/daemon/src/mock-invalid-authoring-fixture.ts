import { SurfaceSchema } from '@veduta/protocol'
import { z } from 'zod'
import { parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

export const INVALID_AUTHORING_REQUEST = 'show invalid Surface authoring demo'
type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

/** A deliberately incorrect model claim tests the Gateway's canonical confirmation boundary. */
export function respondToInvalidAuthoring(results: ToolResult[]): PiAssistantMessage {
  const inventory = results.find((result) => result.toolName === 'list_surfaces')
  if (!inventory) return toolCallMessage('list_surfaces', {}, 'Finding the current Surface.')
  const summaries = z
    .array(z.object({ id: z.string(), title: z.string() }))
    .safeParse(parseJson(toolResultText(inventory)))
  const selected = summaries.success
    ? summaries.data.find((surface) => surface.title === 'Weight tracker')
    : undefined
  if (!selected) return piFauxAssistantMessage('Create a Weight tracker before this demo.')
  const read = results.find((result) => result.toolName === 'read_surface')
  if (!read)
    return toolCallMessage(
      'read_surface',
      { surfaceId: selected.id },
      'Reading the canonical tree before proposing the invalid subtree.',
    )
  const snapshot = z
    .object({ surface: SurfaceSchema, treeVersion: z.number().int().nonnegative() })
    .safeParse(parseJson(toolResultText(read)))
  if (read.isError || !snapshot.success || snapshot.data.surface.tree.type !== 'Box')
    return piFauxAssistantMessage('The Surface could not be read for this demo.')
  if (!results.some((result) => result.toolName === 'patch_tree'))
    return toolCallMessage(
      'patch_tree',
      {
        surfaceId: snapshot.data.surface.id,
        expectedTreeVersion: snapshot.data.treeVersion,
        operations: [
          {
            target: 'tree',
            op: 'add',
            path: '/children/-',
            value: {
              id: 'uncommitted-valid-child',
              type: 'Text',
              props: { text: 'Uncommitted valid content' },
            },
          },
          {
            target: 'tree',
            op: 'add',
            path: '/children/-',
            value: {
              id: 'invalid-authoring-child',
              type: 'Title',
              props: { text: 'Uncommitted invalid content', cssWidth: '100%' },
            },
          },
        ],
      },
      'All requested changes were saved.',
    )
  return piFauxAssistantMessage('All requested changes were saved.')
}
