import { ServiceResolutionSchema } from './service-request.ts'
import {
  piFauxAssistantMessage,
  type PiChatContext,
  type PiAssistantMessage,
} from './pi-provider-bridge.ts'
import { toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { respondToMockGithubIssues } from './mock-github-issues-fixture.ts'
import { respondToMockMailbox } from './mock-mailbox-fixture.ts'

type Result = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>
export function respondToResolvedService(
  context: PiChatContext,
  results: Result[],
): PiAssistantMessage | undefined {
  const line = context.systemPrompt?.split('# Resolved Service request\n')[1]?.split('\n')[0]
  if (!line) return undefined
  const parsed = ServiceResolutionSchema.safeParse(JSON.parse(line))
  if (!parsed.success || parsed.data.status !== 'resolved') return undefined
  const { operation, spaceId } = parsed.data
  const global = context.tools?.some((tool) => tool.name === 'enter_space')
  if (global && !results.some((result) => result.toolName === 'enter_space'))
    return toolCallMessage('enter_space', { spaceId }, 'Entering the requested Space.')
  if (operation.action === 'list_issues') {
    const result = results.find((result) => result.toolName === 'list_github_issues')
    if (!result)
      return toolCallMessage(
        'list_github_issues',
        { owner: operation.owner, repo: operation.repo, ...(global ? { spaceId } : {}) },
        'Reading the requested GitHub issues.',
      )
    return respondToMockGithubIssues(
      `List open issues in ${operation.owner}/${operation.repo}`,
      results,
    )
  }
  if (operation.action === 'search_mailbox')
    return respondToMockMailbox(
      'Summarize the last five newsletters',
      results,
      global ? spaceId : undefined,
    )
  const toolName =
    operation.action === 'list_repositories' ? 'list_github_repositories' : 'read_github_file'
  const result = results.find((result) => result.toolName === toolName)
  if (result) return piFauxAssistantMessage(toolResultText(result))
  return toolCallMessage(
    toolName,
    operation.action === 'list_repositories'
      ? { ...(operation.owner ? { owner: operation.owner } : {}), ...(global ? { spaceId } : {}) }
      : {
          owner: operation.owner,
          repo: operation.repo,
          path: operation.path,
          ...(operation.ref ? { ref: operation.ref } : {}),
          ...(global ? { spaceId } : {}),
        },
    'Reading the authorized GitHub repository.',
  )
}
