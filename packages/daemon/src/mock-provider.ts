export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/**
 * Deterministic mock LLM provider (issue #1): development and tests
 * must require no API keys. Real providers arrive behind the
 * AgentRunner wrapper (issue #3); this mock exists so `pnpm dev`
 * always answers in chat.
 */
export function mockReply(history: ChatMessage[]): string {
  const last = history.at(-1)?.text.trim() ?? ''
  if (last === '') return 'Say something and I will echo it back.'
  if (/help|aiuto/i.test(last)) {
    return 'I am the mock provider. The real Agent arrives with issue #3 — until then I answer deterministically, with no API key.'
  }
  return `[mock] You said: "${last}". The real Agent (issue #3) will act on this; for now I only prove the loop works.`
}
