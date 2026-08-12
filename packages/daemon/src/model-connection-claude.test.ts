import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import { claudeSubscriptionAdapter } from './model-connection-claude.ts'
import { ModelConnectionError, type AdapterContext } from './model-connection-adapter.ts'

const REASON =
  'Anthropic does not permit a third-party product to offer Claude.ai login or route subscription credentials without prior approval, so Veduta cannot ship this connection method yet. Anthropic API keys remain fully supported.'

const CTX = fromPartial<AdapterContext>({})

describe('claudeSubscriptionAdapter', () => {
  it('describes the method', () => {
    expect(claudeSubscriptionAdapter.methodId).toBe('claude-subscription')
    expect(claudeSubscriptionAdapter.providerName).toBe('anthropic')
    expect(claudeSubscriptionAdapter.providerDisplayName).toBe('Claude')
    expect(claudeSubscriptionAdapter.methodDisplayName).toBe('Subscription')
    expect(claudeSubscriptionAdapter.capabilities).toEqual({
      authorization: 'none',
      refresh: 'automatic',
      revocation: 'provider',
      metered: true,
    })
  })

  it('is always unavailable with the exact reason and the legal docs link', async () => {
    const result = await claudeSubscriptionAdapter.availability(
      fromPartial({ rootDir: '/tmp', env: {}, vaultAvailable: true }),
    )
    expect(result).toEqual({
      available: false,
      reason: REASON,
      docsUrl: 'https://code.claude.com/docs/en/legal-and-compliance',
    })
  })

  it('every verb throws unsupported with the exact same reason', async () => {
    const verbs: Array<() => Promise<unknown>> = [
      () => claudeSubscriptionAdapter.authorize(CTX, {}),
      () => claudeSubscriptionAdapter.refresh(CTX),
      () => claudeSubscriptionAdapter.catalog(CTX),
      () => claudeSubscriptionAdapter.verify(CTX, 'claude-sonnet-5'),
      () => claudeSubscriptionAdapter.revoke(CTX),
    ]
    for (const verb of verbs) {
      const error = await verb().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ModelConnectionError)
      expect((error as ModelConnectionError).code).toBe('unsupported')
      expect((error as ModelConnectionError).message).toBe(REASON)
    }
  })
})
