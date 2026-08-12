import { ModelConnectionError, type ModelConnectionAdapter } from './model-connection-adapter.ts'

/**
 * The Claude subscription Model connection method (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment): permanently
 * unavailable. Anthropic does not permit a third-party product to offer
 * Claude.ai login or route subscription credentials without prior approval,
 * so this adapter never authorizes anything — `availability()` reports the
 * gate and every other verb throws the exact same reason as
 * `ModelConnectionError('unsupported', …)` rather than pretending to offer a
 * flow that cannot legally exist. Anthropic API keys stay fully supported
 * through `model-connection-byok.ts`'s `anthropic-api-key` method.
 */
const UNAVAILABLE_REASON =
  'Anthropic does not permit a third-party product to offer Claude.ai login or route subscription credentials without prior approval, so Veduta cannot ship this connection method yet. Anthropic API keys remain fully supported.'

const DOCS_URL = 'https://code.claude.com/docs/en/legal-and-compliance'

function unsupported(): never {
  throw new ModelConnectionError('unsupported', UNAVAILABLE_REASON)
}

export const claudeSubscriptionAdapter: ModelConnectionAdapter = {
  methodId: 'claude-subscription',
  providerName: 'anthropic',
  providerDisplayName: 'Claude',
  methodDisplayName: 'Subscription',
  capabilities: {
    authorization: 'none',
    refresh: 'automatic',
    revocation: 'provider',
    metered: true,
  },
  async availability() {
    return { available: false, reason: UNAVAILABLE_REASON, docsUrl: DOCS_URL }
  },
  // `async` here is load-bearing, not decorative: `unsupported()` throws
  // synchronously, and every caller (the registry, the contract test suite)
  // expects a *rejected promise* it can `await`/`.catch()`, the same as
  // every other adapter's verbs. A plain `() => unsupported()` would throw
  // synchronously on the call itself, before any `.catch()` ever attaches.
  authorize: async () => unsupported(),
  refresh: async () => unsupported(),
  catalog: async () => unsupported(),
  verify: async () => unsupported(),
  revoke: async () => unsupported(),
}
