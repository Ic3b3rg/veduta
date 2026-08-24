import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installEgressEnforcement, EgressPolicy, type EgressDenial } from './egress.ts'
import { createFakeProvider, fakeText, fakeUsage } from './fake-provider.ts'
import {
  defaultRoutingConfig,
  isMarkedNonRetryable,
  NonRetryableModelError,
  type SecretResolver,
} from './model-routing.ts'
import {
  completeToolless,
  createProviderBridge,
  isBuiltinModel,
  probeModel,
  type MockResponder,
  type ModelConnectionRuntime,
  type PiChatContext,
  type SubscriptionStreamRequest,
} from './pi-provider-bridge.ts'
// `PiModel` is a project type re-exported through `pi-agent-runner.ts`
// (`import-boundary.test.ts`'s `UNRESTRICTED_FILES`/`TYPE_ONLY_FILES` guard
// only the `@earendil-works/pi-agent-core`/`pi-ai` packages themselves, not
// this project file), used below only to type an intentionally malformed
// fixture — never to construct a live provider client.
import type { PiModel } from './pi-agent-runner.ts'

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

    it('keeps the canonical pi-ai provider on the descriptor and never substitutes the connection id', () => {
      // ADR-0014 amendment / issue #47: pi-ai's own routing (compat's
      // `shouldUseBuiltinModels`) keys off `model.provider`, so a connection
      // id can never be written there — it rides on a private stamp
      // instead (see the `streamFn` describe block below).
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
        connectionId: 'conn-xyz',
      })
      expect(model.provider).toBe('anthropic')
      expect(model.id).toBe('claude-sonnet-5')
    })

    it('returns a fresh clone per call (two calls do not share one object)', () => {
      // pi-ai's builtin catalog lookup returns one shared object per
      // provider+model; without cloning, stamping it would leak one
      // connection's binding onto every other caller that resolves the
      // same provider+model (issue #47).
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const ref = { provider: 'anthropic', modelId: 'claude-sonnet-5', tier: 'reasoning' as const }
      const first = bridge.resolveModel(ref)
      const second = bridge.resolveModel(ref)
      expect(first).not.toBe(second)
      ;(first as { name: string }).name = 'mutated-in-place'
      expect(second.name).not.toBe('mutated-in-place')
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

  describe('streamFn (connection binding, issue #47)', () => {
    // Same save/restore convention as the egress suite above.
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>

    beforeEach(() => {
      savedDispatcher = getGlobalDispatcher()
    })

    afterEach(() => {
      setGlobalDispatcher(savedDispatcher)
    })

    it('still refuses a legacy descriptor whose resolved key is empty (guard unchanged)', async () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })

      await expect(bridge.streamFn(model, { messages: [] }, { apiKey: '   ' })).rejects.toThrow(
        /no API key resolved/,
      )
    })

    it('rejects a descriptor without the bridge stamp', async () => {
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const stamped = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      })
      // `JSON.stringify` never serializes symbol-keyed properties, so a
      // round-trip through it produces exactly the shape of a descriptor
      // that never passed through this bridge's `resolveModel` at all —
      // the only realistic way one could reach `streamFn` unstamped.
      const unstamped = JSON.parse(JSON.stringify(stamped)) as PiModel

      await expect(
        bridge.streamFn(unstamped, { messages: [] }, { apiKey: 'sk-test' }),
      ).rejects.toThrow(/did not come from the provider bridge/)
    })

    it('resolves a connection-bound key from connectionKeys and ignores streamOptions.apiKey', async () => {
      const policy = new EgressPolicy() // no hosts declared: denies everything
      const denials: EgressDenial[] = []
      policy.onDenial((denial) => denials.push(denial))
      installEgressEnforcement(policy)

      const boundConfig = {
        ...config,
        connectionKeys: { 'conn-a': 'secret://vault/conn-a-api-key' },
      }
      const secrets: SecretResolver = {
        resolve: (ref) => (ref === 'secret://vault/conn-a-api-key' ? 'sk-conn-a' : undefined),
      }
      const bridge = createProviderBridge({ config: boundConfig, secrets })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
        connectionId: 'conn-a',
      })

      const stream = await bridge.streamFn(
        model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        // A decoy: if the bridge ever read this on a connection-bound
        // descriptor, the empty-key guard would reject before any network
        // attempt — the request reaching (and being denied by) egress is
        // proof it resolved the key from `connectionKeys` instead.
        { apiKey: '' },
      )
      for await (const _event of stream) {
        // drain to completion
      }
      await stream.result()

      expect(denials).toHaveLength(1)
      expect(denials[0]?.host).toBe('api.anthropic.com')
    })

    it('fails closed when a connection binding resolves no key rather than borrowing streamOptions.apiKey', async () => {
      const policy = new EgressPolicy() // no hosts declared: denies everything
      const denials: EgressDenial[] = []
      policy.onDenial((denial) => denials.push(denial))
      installEgressEnforcement(policy)

      // `connectionKeys` has no entry for 'conn-a' — the connection is
      // bound but unresolvable.
      const bridge = createProviderBridge({ config, secrets: noKeysResolve })
      const model = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
        connectionId: 'conn-a',
      })

      await expect(
        bridge.streamFn(
          model,
          { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
          // pi-agent-core pre-fills exactly this with the legacy provider
          // key before every call — a perfectly valid-looking decoy that
          // must never be borrowed for a connection-bound turn.
          { apiKey: 'sk-legacy-provider-key-should-never-be-used' },
        ),
      ).rejects.toThrow(/no stored key for Model connection "conn-a"/)

      // No egress denial either: proof the request never reached the
      // dispatcher — the bridge refused before ever calling into pi-ai.
      expect(denials).toHaveLength(0)
    })

    it('two connections on the same provider and model resolve their own keys (per-call clone isolation)', async () => {
      const policy = new EgressPolicy() // no hosts declared: denies everything
      const denials: EgressDenial[] = []
      policy.onDenial((denial) => denials.push(denial))
      installEgressEnforcement(policy)

      const boundConfig = {
        ...config,
        connectionKeys: {
          'conn-a': 'secret://vault/conn-a-api-key',
          'conn-b': 'secret://vault/conn-b-api-key',
        },
      }
      const secrets: SecretResolver = {
        resolve: (ref) => {
          if (ref === 'secret://vault/conn-a-api-key') return 'sk-conn-a'
          if (ref === 'secret://vault/conn-b-api-key') return 'sk-conn-b'
          return undefined
        },
      }
      const bridge = createProviderBridge({ config: boundConfig, secrets })

      const modelA = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
        connectionId: 'conn-a',
      })
      const modelB = bridge.resolveModel({
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
        connectionId: 'conn-b',
      })
      expect(modelA).not.toBe(modelB)

      for (const model of [modelA, modelB]) {
        const stream = await bridge.streamFn(
          model,
          { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
          {},
        )
        for await (const _event of stream) {
          // drain to completion
        }
        await stream.result()
      }

      // Both reached the network — neither connection's binding was lost
      // or overwritten by the other's, which a shared (unlcloned) descriptor
      // would risk.
      expect(denials).toHaveLength(2)
      expect(denials.every((denial) => denial.host === 'api.anthropic.com')).toBe(true)
    })
  })

  describe('resolveModel (subscription connections, issue #47)', () => {
    it('returns a veduta-subscription descriptor for a subscription runtime, keeping the canonical provider', () => {
      const runtime: ModelConnectionRuntime = {
        connectionId: 'codex-conn',
        provider: 'openai',
        transport: 'subscription',
        stream: async function* () {
          yield { type: 'text-delta' as const, text: 'never called' }
        },
      }
      const bridge = createProviderBridge({
        config,
        secrets: noKeysResolve,
        connections: () => [runtime],
      })

      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })

      expect(model.api).toBe('veduta-subscription')
      expect(model.provider).toBe('openai')
      expect(model.id).toBe('gpt-5-codex')
    })

    it('fails closed when a connection-bound model no longer has a live runtime', () => {
      const bridge = createProviderBridge({
        config,
        secrets: noKeysResolve,
        connections: () => [],
      })

      const resolve = () =>
        bridge.resolveModel({
          provider: 'openai',
          modelId: 'gpt-5.6-luna',
          tier: 'reasoning',
          connectionId: 'codex-conn',
        })

      expect(resolve).toThrow(NonRetryableModelError)
      expect(resolve).toThrow(/Model connection "codex-conn" is not available/)
    })
  })

  describe('streamFn (subscription connections, issue #47)', () => {
    function subscriptionBridge(runtime: ModelConnectionRuntime | undefined) {
      return createProviderBridge({
        config,
        secrets: noKeysResolve,
        connections: () => (runtime ? [runtime] : []),
      })
    }

    it("streams a subscription connection's text deltas and resolves the final message", async () => {
      const runtime: ModelConnectionRuntime = {
        connectionId: 'codex-conn',
        provider: 'openai',
        transport: 'subscription',
        stream: async function* () {
          yield { type: 'text-delta' as const, text: 'hello' }
          yield { type: 'text-delta' as const, text: ' world' }
        },
      }
      const bridge = subscriptionBridge(runtime)
      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })

      const stream = await bridge.streamFn(model, minimalContext(), {})
      const deltas: string[] = []
      for await (const event of stream) {
        if (event.type === 'text_delta') deltas.push(event.delta)
      }
      const finalMessage = await stream.result()

      expect(deltas).toEqual(['hello', ' world'])
      expect(finalMessage.stopReason).toBe('stop')
      expect(finalMessage.content).toEqual([{ type: 'text', text: 'hello world' }])
    })

    it('fails closed for a subscription descriptor with no runtime', async () => {
      // The connection existed (and streamed) at `resolveModel` time; the
      // runtime roster changed (a revoke, a daemon restart with a stale
      // record) before `streamFn` ran — the descriptor still carries the
      // `veduta-subscription` api, but no live runtime backs it anymore.
      let runtimes: ModelConnectionRuntime[] = [
        {
          connectionId: 'codex-conn',
          provider: 'openai',
          transport: 'subscription',
          stream: async function* () {
            yield { type: 'text-delta' as const, text: 'never reached' }
          },
        },
      ]
      const bridge = createProviderBridge({
        config,
        secrets: noKeysResolve,
        connections: () => runtimes,
      })
      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })
      expect(model.api).toBe('veduta-subscription')

      runtimes = []
      await expect(bridge.streamFn(model, minimalContext(), {})).rejects.toThrow(
        /Model connection "codex-conn" is not available/,
      )
    })

    it('maps one normalized subscription tool call onto the Pi tool-call stream contract', async () => {
      let receivedRequest: SubscriptionStreamRequest | undefined
      const runtime: ModelConnectionRuntime = {
        connectionId: 'codex-conn',
        provider: 'openai',
        transport: 'subscription',
        stream: async function* (request) {
          receivedRequest = request
          yield {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName: 'search_memory',
            input: { query: 'hello' },
          }
        },
      }
      const bridge = subscriptionBridge(runtime)
      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })

      const stream = await bridge.streamFn(
        model,
        {
          messages: [],
          tools: [
            {
              name: 'search_memory',
              description: 'Search memory.',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
          ],
        },
        {},
      )
      const eventTypes: string[] = []
      for await (const event of stream) eventTypes.push(event.type)
      const finalMessage = await stream.result()

      expect(receivedRequest?.prompt.tools).toEqual([
        {
          name: 'search_memory',
          description: 'Search memory.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ])
      expect(eventTypes).toEqual([
        'start',
        'toolcall_start',
        'toolcall_delta',
        'toolcall_end',
        'done',
      ])
      expect(finalMessage.stopReason).toBe('toolUse')
      expect(finalMessage.content).toEqual([
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'search_memory',
          arguments: { query: 'hello' },
        },
      ])
    })

    it('a NonRetryableModelError from the runtime stream is marked on the error message', async () => {
      const runtime: ModelConnectionRuntime = {
        connectionId: 'codex-conn',
        provider: 'openai',
        transport: 'subscription',
        stream: () => {
          throw new NonRetryableModelError('the subscription was revoked; reconnect and try again')
        },
      }
      const bridge = subscriptionBridge(runtime)
      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })

      const stream = await bridge.streamFn(model, minimalContext(), {})
      for await (const _event of stream) {
        // drain to completion
      }
      const finalMessage = await stream.result()

      expect(finalMessage.stopReason).toBe('error')
      expect(finalMessage.errorMessage).toBe(
        'the subscription was revoked; reconnect and try again',
      )
      // The exact object identity `pi-agent-runner.ts`'s `handlePiEvent`
      // later reads off `event.message` (issue #47) — pi's own agent loop
      // carries this SAME object all the way to `message_end`.
      expect(isMarkedNonRetryable(finalMessage)).toBe(true)
    })

    it('a plain error from the runtime stream is never marked non-retryable', async () => {
      const runtime: ModelConnectionRuntime = {
        connectionId: 'codex-conn',
        provider: 'openai',
        transport: 'subscription',
        stream: () => {
          throw new Error('a transient provider hiccup')
        },
      }
      const bridge = subscriptionBridge(runtime)
      const model = bridge.resolveModel({
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: 'codex-conn',
      })

      const stream = await bridge.streamFn(model, minimalContext(), {})
      for await (const _event of stream) {
        // drain to completion
      }
      const finalMessage = await stream.result()

      expect(finalMessage.stopReason).toBe('error')
      expect(isMarkedNonRetryable(finalMessage)).toBe(false)
    })
  })

  describe('probeModel', () => {
    it("surfaces the provider's exact errorMessage", async () => {
      const responder: MockResponder = () => ({
        role: 'assistant',
        content: [],
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
        stopReason: 'error',
        errorMessage: 'the provider rejected the request: invalid api key',
        timestamp: Date.now(),
      })
      const bridge = createProviderBridge({
        config,
        secrets: noKeysResolve,
        mockResponder: responder,
      })

      await expect(
        probeModel(bridge, { provider: 'mock', modelId: 'reader-mock', tier: 'triage' }),
      ).rejects.toThrow('the provider rejected the request: invalid api key')
    })
  })

  describe('completeToolless', () => {
    it('runs one fresh prompt with no tools and returns provider text and cost', async () => {
      const fake = createFakeProvider()
      let observedContext: PiChatContext | undefined
      fake.setResponses([
        {
          factory: (context) => {
            observedContext = context
            return fakeText('{"verdict":"pass"}')
          },
          usage: fakeUsage(0.125),
        },
      ])

      const result = await completeToolless(
        fake,
        { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' },
        'review this report',
      )

      expect(result).toEqual({ text: '{"verdict":"pass"}', costUsd: 0.125 })
      expect(observedContext?.tools).toBeUndefined()
      expect(observedContext?.messages).toHaveLength(1)
    })
  })

  describe('isBuiltinModel', () => {
    it('is true for anthropic claude models and false for a made-up provider', () => {
      expect(isBuiltinModel('anthropic', 'claude-sonnet-5')).toBe(true)
      expect(isBuiltinModel('not-a-provider', 'x')).toBe(false)
    })
  })
})
