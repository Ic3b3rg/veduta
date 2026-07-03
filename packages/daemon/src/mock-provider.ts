import type { ChatMessage } from '@veduta/protocol'

/**
 * Deterministic mock LLM provider (issue #1): development and tests
 * must require no API keys. The Gateway keeps using it until the
 * AgentRunner is wired into chat in the next foundation slice.
 */
export function mockReply(history: ChatMessage[]): string {
  const last = history.at(-1)?.text.trim() ?? ''
  if (last === '') return 'Say something and I will echo it back.'
  if (/help|aiuto/i.test(last)) {
    return 'I am the mock provider. The Agent runtime is isolated behind AgentRunner; chat wiring still answers deterministically, with no API key.'
  }
  return `[mock] You said: "${last}". Chat wiring still uses the deterministic dev provider; AgentRunner owns the real runtime boundary.`
}
