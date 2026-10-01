import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

type PiToolResultMessage = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

function resultOf(message: PiToolResultMessage | undefined): Record<string, unknown> | undefined {
  if (!message) return undefined
  const parsed = parseJson(toolResultText(message))
  return isRecord(parsed) ? parsed : undefined
}

export function respondToMockHimalayaSetup(
  text: string,
  results: PiToolResultMessage[],
  cwd: string | undefined,
): PiAssistantMessage | undefined {
  if (!/\b(set up|setup|install)\s+himalaya\b/i.test(text)) return undefined
  if (!cwd) return piFauxAssistantMessage('A command working directory is unavailable.')
  const skill = results.find((result) => result.toolName === 'load_skill')
  if (!skill)
    return toolCallMessage(
      'load_skill',
      { skillId: 'himalaya-connector' },
      'Loading Himalaya setup guidance.',
    )
  if (toolResultText(skill).includes('not applicable'))
    return piFauxAssistantMessage('Himalaya setup guidance is unavailable.')
  const commands = results.filter((result) => result.toolName === 'execute_command')
  const first = resultOf(commands[0])
  if (!first)
    return toolCallMessage(
      'execute_command',
      { command: 'himalaya --version', cwd, outputMode: 'ordinary' },
      'Checking Himalaya.',
    )
  if (first.exitCode === 0 && /^himalaya v?2\.1\.0(?:\s|$)/m.test(String(first.stdout))) {
    return piFauxAssistantMessage(
      'Himalaya 2.1.0 is available. Add and test the IMAP/SMTP account in Mail connections.',
    )
  }
  const installed = resultOf(results.find((result) => result.toolName === 'install_himalaya'))
  if (!installed)
    return toolCallMessage(
      'install_himalaya',
      {},
      'Installing and verifying the reviewed Himalaya release.',
    )
  return piFauxAssistantMessage(
    installed.state === 'ready'
      ? 'Himalaya 2.1.0 is installed. Add and test the IMAP/SMTP account in Mail connections.'
      : `Himalaya setup did not complete. ${String(installed.reason ?? 'Retry setup.')}`,
  )
}
