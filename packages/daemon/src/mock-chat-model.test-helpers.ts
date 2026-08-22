import { fromPartial } from '@total-typescript/shoehorn'
import type { PiAssistantMessage, PiChatContext } from './pi-provider-bridge.ts'

export function userContext(text: string): PiChatContext {
  return fromPartial<PiChatContext>({
    messages: [{ role: 'user', content: text, timestamp: Date.now() }],
  })
}

/** Minimal Active Space section in the shape emitted by `spaces-engine.ts`. */
export function userContextInSpace(text: string, name: string, slug: string): PiChatContext {
  return fromPartial<PiChatContext>({
    systemPrompt: `# Active Space\n\n${name} (${slug})\nSome granularity rule.\nSome timer rule.`,
    messages: [{ role: 'user', content: text, timestamp: Date.now() }],
  })
}

export function toolResultContext(
  userText: string,
  results: Array<{ toolName: string; content: string; isError?: boolean }>,
): PiChatContext {
  return fromPartial<PiChatContext>({
    messages: [
      { role: 'user', content: userText, timestamp: Date.now() },
      ...results.flatMap((result, index) => {
        const toolCallId = `call-${index + 1}`
        return [
          {
            role: 'assistant' as const,
            content: [
              {
                type: 'toolCall' as const,
                id: toolCallId,
                name: result.toolName,
                arguments: {},
              },
            ],
            stopReason: 'toolUse' as const,
          },
          {
            role: 'toolResult' as const,
            toolCallId,
            toolName: result.toolName,
            content: [{ type: 'text' as const, text: result.content }],
            isError: result.isError ?? false,
            timestamp: Date.now(),
          },
        ]
      }),
    ],
  })
}

export function toolCallIn(message: PiAssistantMessage) {
  const call = message.content.find((block) => block.type === 'toolCall')
  if (!call || call.type !== 'toolCall') throw new Error('expected a tool call in the message')
  return call
}

export function textIn(message: PiAssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}
