import {
  piFauxAssistantMessage,
  piFauxText,
  piFauxToolCall,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

type PiTurnMessage = PiChatContext['messages'][number]
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>

export function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
  text: string,
): PiAssistantMessage {
  return piFauxAssistantMessage([piFauxText(text), piFauxToolCall(name, args)], {
    stopReason: 'toolUse',
  })
}

export function toolResultText(message: PiToolResultMessage): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

export function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
