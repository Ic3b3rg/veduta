import type { ModelRef } from './agent-runner.ts'

/**
 * Deterministic stand-in for the quarantined reader's LLM call (issue #13):
 * the dev profile has no provider keys by design, so the reader classifies
 * every event with a minimal, schema-valid output. The real provider client
 * lands with the Agent loop wiring, same as chat.
 */
export async function mockReaderComplete(
  _model: ModelRef,
  _prompt: string,
): Promise<{ text: string }> {
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
