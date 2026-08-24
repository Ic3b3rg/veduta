import type { ModelConnectionMethodId } from '@veduta/protocol'

/** Complete primary-route policy used by connection and onboarding tests unless a case narrows it. */
export const primaryRoutableMethodsFixture: ReadonlySet<ModelConnectionMethodId> = new Set([
  'anthropic-api-key',
  'openai-api-key',
  'openrouter-api-key',
  'chatgpt-codex',
])
