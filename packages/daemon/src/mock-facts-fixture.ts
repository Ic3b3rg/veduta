import { toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { piFauxAssistantMessage, type PiChatContext } from './pi-provider-bridge.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export const FACTS_REMEMBER_REQUEST = 'Remember this fact: I dislike celery'
export const FACTS_CORRECTION_REQUEST = 'Change "I dislike celery" to "I like celery now".'
export const SPACE_PURPOSE_REQUEST =
  'Questo spazio è dedicato ai bug di veduta per me che sono lowner del progetto'

/** Deterministic FACTS journey; all write inputs come from the explicit user message. */
export function respondToMockFacts(text: string, results: ToolResult[]) {
  if (![FACTS_REMEMBER_REQUEST, FACTS_CORRECTION_REQUEST, SPACE_PURPOSE_REQUEST].includes(text))
    return undefined
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
    : { fact: text === SPACE_PURPOSE_REQUEST ? text : text.slice('Remember this fact: '.length) }
  return toolCallMessage('write_fact', input, 'Saving the requested fact through the Curator.')
}
