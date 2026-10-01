import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { parseGithubIssueWrite } from './service-intent.ts'

type PiToolResultMessage = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export function respondToMockGithubWrite(
  text: string,
  results: PiToolResultMessage[],
): PiAssistantMessage | undefined {
  const request = parseGithubIssueWrite(text)
  if (!request) return undefined
  const spaceId = targetSpaceId(text)
  if (spaceId && !results.some((item) => item.toolName === 'enter_space'))
    return toolCallMessage('enter_space', { spaceId }, 'Entering the requested Space.')
  const result = results.find((item) => item.toolName === 'create_github_issue')
  if (!result)
    return toolCallMessage(
      'create_github_issue',
      { ...request, ...(spaceId ? { spaceId } : {}) },
      'Preparing the separately approved GitHub issue write.',
    )
  return piFauxAssistantMessage(
    result.isError
      ? 'The GitHub issue request failed.'
      : 'The GitHub issue request is awaiting a separate approval decision.',
  )
}

export function respondToMockGithubIssues(
  text: string,
  results: PiToolResultMessage[],
): PiAssistantMessage | undefined {
  const match =
    /\b(?:list|show|find|summari[sz]e)\b[^\n]{0,160}\bopen\s+(?:github\s+)?issues?\b[^\n]{0,160}\b(?:in|from|for)\s+(?:the\s+)?(?:repository|repo)?\s*([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\b/i.exec(
      text,
    )
  if (!match) return undefined
  const spaceId = targetSpaceId(text)
  if (spaceId && !results.some((item) => item.toolName === 'enter_space'))
    return toolCallMessage('enter_space', { spaceId }, 'Entering the requested Space.')
  const result = results.find((item) => item.toolName === 'list_github_issues')
  if (!result)
    return toolCallMessage(
      'list_github_issues',
      { owner: match[1], repo: match[2], ...(spaceId ? { spaceId } : {}) },
      'Reading the granted repository issues.',
    )
  if (result.isError) return piFauxAssistantMessage('The GitHub issue read failed.')
  const output = parseJson(toolResultText(result))
  if (!isRecord(output)) return piFauxAssistantMessage('GitHub returned no readable issue result.')
  const issues = Array.isArray(output.issues) ? output.issues : []
  const titles = issues
    .filter(isRecord)
    .map((item) => `#${String(item.number)} ${String(item.title)}`)
    .slice(0, 10)
  return piFauxAssistantMessage(
    `${issues.length} open issues in ${String(output.repository)}. ` +
      (titles.length ? titles.join('; ') : 'No open issues were returned.'),
  )
}

function targetSpaceId(text: string): string | undefined {
  return /\b(?:in|for)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 -]{0,49})\s+Space[.!]?$/i
    .exec(text.trim())?.[1]
    ?.trim()
    .toLowerCase()
    .replaceAll(' ', '-')
}
