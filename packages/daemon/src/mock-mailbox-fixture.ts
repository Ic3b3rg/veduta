import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'

type PiToolResultMessage = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

const REQUEST_RE =
  /\b(?:receipts?|newsletters?|subject|messages?\s+from|unread\s+(?:emails?|mail|messages?))\b/i

export function respondToMockMailbox(
  text: string,
  results: PiToolResultMessage[],
  spaceId?: string,
): PiAssistantMessage | undefined {
  if (!REQUEST_RE.test(text)) return undefined
  const call = (name: string, args: Record<string, unknown>, comment: string) =>
    toolCallMessage(name, { ...args, ...(spaceId ? { spaceId } : {}) }, comment)
  const loads = results.filter((result) => result.toolName === 'load_skill')
  if (loads.length === 0) {
    return call('load_skill', { skillId: 'mailbox-assistant' }, 'Loading Mailbox guidance.')
  }
  if (toolResultText(loads[0]!).includes('not applicable'))
    return piFauxAssistantMessage('The Mailbox procedure is unavailable.')
  const resolution = results.find((result) => result.toolName === 'resolve_mailbox_scope')
  if (!resolution) return call('resolve_mailbox_scope', {}, 'Resolving the Mailbox scope.')
  const scope = parseJson(toolResultText(resolution))
  if (!isRecord(scope) || typeof scope.scopeId !== 'string') {
    return piFauxAssistantMessage(toolResultText(resolution))
  }
  if (loads.length === 1) {
    const account = isRecord(scope.account) ? scope.account : {}
    const skillId = account.provider === 'himalaya' ? 'himalaya-connector' : 'gmail-connector'
    return call('load_skill', { skillId }, 'Loading connector guidance.')
  }
  if (toolResultText(loads[1]!).includes('not applicable'))
    return piFauxAssistantMessage('The connector procedure is unavailable.')
  const searched = results.find((result) => result.toolName === 'search_mailbox')
  if (!searched) {
    return call('search_mailbox', { scopeId: scope.scopeId }, 'Searching the selected Mailbox.')
  }
  if (searched.isError)
    return piFauxAssistantMessage(`The Mailbox search failed. ${toolResultText(searched)}`)
  const output = parseJson(toolResultText(searched))
  if (!isRecord(output)) return piFauxAssistantMessage(toolResultText(searched))
  const summaries = Array.isArray(output.summaries) ? output.summaries : []
  const lines = summaries
    .filter(isRecord)
    .map((item) => String(item.summary ?? ''))
    .filter(Boolean)
    .slice(0, 5)
  return piFauxAssistantMessage(
    `${summaries.length} messages from ${String(output.account)}. ` +
      `Query: ${String(output.query)}. Last checked: ${String(output.checkedAt)}.` +
      (lines.length ? `\n${lines.join('\n')}` : ''),
  )
}
