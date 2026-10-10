import { toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { piFauxAssistantMessage, type PiChatContext } from './pi-provider-bridge.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

/** Deterministic fixture for the focused Space proposal journey in issue #137. */
export function respondToMockSpaceProposal(text: string, results: ToolResult[]) {
  if (text !== 'crea uno Space Lavoro') return undefined
  const proposal = results.find((result) => result.toolName === 'propose_space')
  if (!proposal) {
    return toolCallMessage(
      'propose_space',
      { name: 'Lavoro', reason: 'Keep work separate from Health.' },
      'Preparing a new Space proposal for your confirmation.',
    )
  }
  return piFauxAssistantMessage(
    proposal.isError
      ? `The Space proposal failed: ${toolResultText(proposal)}`
      : 'Review the proposal to create Lavoro. Your current Space stays open.',
  )
}
