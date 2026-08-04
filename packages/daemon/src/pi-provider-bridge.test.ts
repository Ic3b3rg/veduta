import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installEgressEnforcement, EgressPolicy, type EgressDenial } from './egress.ts'
import { defaultRoutingConfig, type SecretResolver } from './model-routing.ts'
import {
  createProviderBridge,
  type MockResponder,
  type PiChatContext,
} from './pi-provider-bridge.ts'

/**
 * `import-boundary.test.ts` allows this file only `import type` of
 * `@earendil-works/pi-agent-core`/`pi-ai` (`TYPE_ONLY_FILES`); this file
 * needs no such import at all — every pi-ai-shaped type it needs
 * (`PiAssistantMessage`, `PiChatContext`) comes from the bridge's own
 * aliases. Constructing a live provider client needs a working key, which
 * the mock/builtin-lookup paths below avoid entirely.
 */

const config = defaultRoutingConfig()

const noKeysResolve: SecretResolver = { resolve: () => undefined }

function minimalContext(): PiChatContext {
  return { messages: [] }
}

describe('createProviderBridge', () => {
  describe('resolveModel', () => {
    it('resolves a builtin model from pi-ai catalog', () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      // "claude-sonnet-5" is the anthropic reasoning-tier default in
      // `defaultRoutingConfig()` — already relied on elsewhere in the
      // codebase, so a stale id here would surface as a routing-config
      // failure too, not just a test artifact.
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })
      expect(model.id).toBe('claude-sonnet-5')
      expect(model.provider).toBe('anthropic')
    })

    it('throws naming both the provider and the model on an unknown provider', () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      expect(() =>
        bridge.resolveModel({ provider: 'not-a-provider', modelId: 'x', tier: 'reasoning' }),
      ).toThrow(/not-a-provider.*x|x.*not-a-provider/)
    })

    it('throws naming both on a known provider with an unknown model id', () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      expect(() =>
        bridge.resolveModel({
          provider: 'anthropic',
          modelId: 'not-a-real-model-id',
          tier: 'reasoning',
        }),
      ).toThrow(/anthropic/)
    })

    it('resolves the mock candidates without touching the builtin catalog', () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const reader = bridge.resolveModel({
        provider: 'mock',
        modelId: 'reader-mock',
        tier: 'triage',
      })
      const worker = bridge.resolveModel({
        provider: 'mock',
        modelId: 'worker-mock',
        tier: 'reasoning',
      })
      expect(reader.id).toBe('reader-mock')
      expect(worker.id).toBe('worker-mock')
      expect(reader.provider).toBe('mock')
    })
  })

  describe('getApiKey', () => {
    it('resolves through the SecretResolver for a configured provider', () => {
      const onlyAnthropicResolves: SecretResolver = {
        resolve: (ref) => (ref === config.providerKeys['anthropic'] ? 'sk-test-key' : undefined),
      }
      const bridge = createProviderBridge({ config, secrets: onlyAnthropicResolves })
      expect(bridge.getApiKey('anthropic')).toBe('sk-test-key')
      expect(bridge.getApiKey('openai')).toBeUndefined()
    })

    it('is always undefined for the mock provider', () => {
      const alwaysResolves: SecretResolver = { resolve: () => 'sk-should-never-be-read' }
      const bridge = createProviderBridge({ config, secrets: alwaysResolves })
      expect(bridge.getApiKey('mock')).toBeUndefined()
    })

    it('is undefined for a provider with no configured key entry', () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      expect(bridge.getApiKey('not-a-configured-provider')).toBeUndefined()
    })
  })

  describe('streamFn (mock)', () => {
    it('yields a single deterministic text message when no mockResponder is supplied', async () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'mock',
        modelId: 'reader-mock',
        tier: 'triage',
      })
      const stream = await bridge.streamFn(model, minimalContext(), {})
      const events: string[] = []
      for await (const event of stream) events.push(event.type)
      const finalMessage = await stream.result()
      expect(events.at(-1)).toBe('done')
      expect(finalMessage.stopReason).toBe('stop')
      expect(finalMessage.content).toEqual([
        { type: 'text', text: expect.stringContaining('mock provider') },
      ])
    })

    it('drives a supplied mockResponder with the live turn context and call count', async () => {
      let seenCallCount = -1
      const responder: MockResponder = (context, state) => {
        seenCallCount = state.callCount
        return {
          role: 'assistant',
          content: [{ type: 'text', text: `echo:${context.messages.length}` }],
          api: 'mock',
          provider: 'mock',
          model: 'reader-mock',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        }
      }
      const bridge = createProviderBridge({
        config,
        secrets: noKeysResolve,
        mockResponder: responder,
      })
      const model = bridge.resolveModel({
        provider: 'mock',
        modelId: 'worker-mock',
        tier: 'reasoning',
      })
      const context: PiChatContext = {
        messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
      }
      const stream = await bridge.streamFn(model, context, {})
      for await (const _event of stream) {
        // drain to completion
      }
      const finalMessage = await stream.result()
      expect(finalMessage.content).toEqual([{ type: 'text', text: 'echo:1' }])
      // pi-ai's faux core increments `state.callCount` before invoking the
      // step (`createFauxCore`'s `stream()`, `@earendil-works/pi-ai/providers/faux`),
      // so the first (and only) call here observes 1, not 0.
      expect(seenCallCount).toBe(1)
    })
  })

  describe('streamFn (real provider) — egress enforcement (issue #37, egress from issue #15)', () => {
    // Other test files in this process share undici's global dispatcher —
    // never leak an installed policy past this suite (egress.test.ts's own
    // save/restore convention).
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>

    beforeEach(() => {
      savedDispatcher = getGlobalDispatcher()
    })

    afterEach(() => {
      setGlobalDispatcher(savedDispatcher)
    })

    it('a real builtin model call is blocked at the network layer by a denying EgressPolicy', async () => {
      // pi-ai's providers ride Node's global fetch, which shares undici's
      // dispatcher — this test pins that assumption against a pi-ai upgrade
      // (issue #37, egress from issue #15).
      const policy = new EgressPolicy() // no hosts declared: denies everything
      const denials: EgressDenial[] = []
      policy.onDenial((denial) => denials.push(denial))
      installEgressEnforcement(policy)

      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })

      const stream = await bridge.streamFn(
        model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        { apiKey: 'sk-test' },
      )
      for await (const _event of stream) {
        // drain to completion — pi encodes the request failure into the
        // stream itself rather than rejecting it (same shape
        // `pi-agent-runner.ts`'s `turnFailureStatus` doc comment describes
        // for provider failures generally), though it normalizes the
        // underlying cause down to a generic "Connection error." rather than
        // surfacing `EgressDeniedError`'s own message text — the denial
        // listener below, not `errorMessage`, is what actually proves the
        // request was ever attempted.
      }
      const finalMessage = await stream.result()

      expect(finalMessage.stopReason).toBe('error')
      // No bytes left: exactly the one denial the policy's `check()` raised
      // before any DNS lookup or socket — proof the request reached the
      // dispatcher and was stopped there, not that it silently vanished
      // some other way (a typo'd host, a network failure unrelated to
      // egress enforcement) that would make this test pass for the wrong
      // reason.
      expect(denials).toHaveLength(1)
      expect(denials[0]?.host).toBe('api.anthropic.com')
    })
  })

  describe('streamFn (real provider) — no ambient env-key fallback (issue #37 fix)', () => {
    // Same save/restore convention as the egress suite above, plus the
    // ambient env var this test deliberately sets and must never leak past it.
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>
    let savedApiKeyEnv: string | undefined

    beforeEach(() => {
      savedDispatcher = getGlobalDispatcher()
      savedApiKeyEnv = process.env['ANTHROPIC_API_KEY']
    })

    afterEach(() => {
      setGlobalDispatcher(savedDispatcher)
      if (savedApiKeyEnv === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = savedApiKeyEnv
    })

    it('rejects a real provider call with no resolved key instead of letting pi-ai read the ambient env var, and never reaches the network', async () => {
      // pi-ai's compat `streamSimple` would otherwise silently read this via
      // `getEnvApiKey` when `options.apiKey` is undefined — proving the
      // bridge itself refuses before that fallback ever gets a chance,
      // regardless of what happens to be sitting in the shell environment.
      process.env['ANTHROPIC_API_KEY'] = 'sk-ambient-should-never-be-used'

      const policy = new EgressPolicy() // no hosts declared: denies everything
      const denials: EgressDenial[] = []
      policy.onDenial((denial) => denials.push(denial))
      installEgressEnforcement(policy)

      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })

      await expect(
        bridge.streamFn(
          model,
          { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
          {},
        ),
      ).rejects.toThrow(/anthropic.*routing\.json|routing\.json.*anthropic/is)

      // No egress denial either: proof the request never reached the
      // dispatcher at all — the bridge rejected before pi-ai ever attempted
      // the call, not merely because the ambient key happened to fail some
      // other way once a request went out.
      expect(denials).toHaveLength(0)
    })

    it('rejects a whitespace-only resolved key the same way — pi-ai trims it to absent and would fall back to the ambient env var', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ambient-should-never-be-used'

      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })

      await expect(
        bridge.streamFn(
          model,
          { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
          { apiKey: '   ' },
        ),
      ).rejects.toThrow(/no API key resolved/)
    })
  })
})
