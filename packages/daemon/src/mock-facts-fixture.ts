import { toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { piFauxAssistantMessage, type PiChatContext } from './pi-provider-bridge.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export const FACTS_REMEMBER_REQUEST = 'Remember this fact: I dislike celery'
export const FACTS_CORRECTION_REQUEST = 'Change "I dislike celery" to "I like celery now".'

/** Deterministic FACTS journey; all write inputs come from the explicit user message. */
export function respondToMockFacts(text: string, results: ToolResult[]) {
  if (text !== FACTS_REMEMBER_REQUEST && text !== FACTS_CORRECTION_REQUEST) return undefined
  const written = results.find((result) => result.toolName === 'write_fact')
  if (written)
    return piFauxAssistantMessage(
      written.isError
        ? `The fact was not changed: ${toolResultText(written)}`
        : toolResultText(written),
    )
  const correction = /^Change "(.+)" to "(.+)"\.$/.exec(text)
  const input = correction
    ? { fact: correction[2], supersedes: correction[1] }
    : { fact: text.slice('Remember this fact: '.length) }
  return toolCallMessage('write_fact', input, 'Saving the requested fact through the Curator.')
}
