import type { ModelRef } from './agent-runner.ts'

/**
 * Deterministic stand-in for the quarantined reader's LLM call (issue #13):
 * keyless dev profile classifies every event with a minimal, schema-valid
 * output. Profiles with a selected real Model connection use the live
 * tool-less bridge instead.
 */
export async function mockReaderComplete(
  _model: ModelRef,
  prompt: string,
): Promise<{ text: string }> {
  if (prompt.startsWith('You are a tool-less quarantined reader.')) {
    const field = (name: string) =>
      new RegExp(`<<<UNTRUSTED ${name}>>>\\n([\\s\\S]*?)\\n<<<END ${name}>>>`)
        .exec(prompt)?.[1]
        ?.trim() ?? ''
    const sender = field('sender')
    const subject = field('subject')
    return {
      text: JSON.stringify({
        sender,
        subject,
        intent: 'other',
        urgency: 'normal',
        entities: [],
        deadlines: [],
        summary: `${sender || 'Unknown sender'}: ${subject || 'Untitled message'}.`.slice(0, 500),
      }),
    }
  }
  return {
    text: JSON.stringify({
      intent: 'other',
      urgency: 'normal',
      entities: [],
      deadlines: [],
      summary:
        'External event received (mock reader; the real provider client lands with the Agent loop).',
    }),
  }
}
