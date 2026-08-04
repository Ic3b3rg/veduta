import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelRef } from './agent-runner.ts'
import type { RoutingConfig, SecretResolver } from './model-routing.ts'
import type { PiModel, PiStreamFn } from './pi-agent-runner.ts'

/**
 * ADR-0004 amendment (issue #37): this is the model-routing counterpart to
 * `pi-agent-runner.ts` — the only other module allowed to import
 * `@earendil-works/pi-ai` (`import-boundary.test.ts`'s `UNRESTRICTED_FILES`).
 * Everything downstream of `createProviderBridge` (routes, the trust layer,
 * `fake-provider.ts`, tests) talks only to `ProviderBridge`/`ModelRef` and
 * the aliases re-exported below.
 */

/** pi-ai's turn context, renamed so callers never need to name pi-ai directly. */
export type PiChatContext = Context
/** pi-ai's resolved assistant message, renamed for the same reason. */
export type PiAssistantMessage = AssistantMessage
/** pi-ai's usage/cost envelope, renamed for the same reason. */
export type PiUsage = Usage
/**
 * pi-ai's stream return type, renamed for the same reason. Carries private
 * fields (see `EventStream` in `@earendil-works/pi-ai/utils/event-stream`),
 * so nothing outside pi-ai can build one structurally — a proxy wrapper
 * (`fake-provider.ts`'s usage override) can only ever reach this type via an
 * `unknown` cast, never a plain object literal.
 */
export type PiAssistantMessageEventStream = AssistantMessageEventStream

/**
 * `fake-provider.ts` (test support) may import only from this module — the
 * boundary test allows pi-ai's runtime nowhere else — so every faux building
 * block it needs is re-exported here under a name of our own.
 */
export const createFauxStreamCore = createFauxCore
export const piFauxText = fauxText
export const piFauxToolCall = fauxToolCall
export const piFauxAssistantMessage = fauxAssistantMessage
export type PiFauxResponseStep = FauxResponseStep

/**
 * Deterministic loopback chat behavior for keyless profiles (issue #37):
 * given the live turn context and the mock model's call count so far,
 * returns the next assistant message. Kept as a plain function type (not
 * pi-ai's `FauxResponseFactory`) so nothing outside this file needs to know
 * pi-ai's factory shape.
 */
export type MockResponder = (
  context: PiChatContext,
  state: { callCount: number },
) => PiAssistantMessage | Promise<PiAssistantMessage>

export interface ProviderBridge {
  resolveModel: (model: ModelRef) => PiModel
  getApiKey: (provider: string) => string | undefined
  streamFn: PiStreamFn
}

export interface ProviderBridgeOptions {
  config: RoutingConfig
  secrets: SecretResolver
  /** Deterministic loopback chat behavior, not yet supplied by any caller. Omit for a single canned reply. */
  mockResponder?: MockResponder
}

/**
 * Maps a routed `ModelRef` plus its resolved key onto pi-ai's provider
 * clients (ADR-0004 §"pi is never imported directly"): `resolveModel` and
 * `streamFn` are the two seams `PiAgentRunner` was built with and never
 * given (`pi-agent-runner.ts`'s `PiAgentRunnerOptions`).
 */
export function createProviderBridge(options: ProviderBridgeOptions): ProviderBridge {
  const { config, secrets, mockResponder } = options

  const resolveModel = (model: ModelRef): PiModel =>
    model.provider === 'mock' ? mockModelDescriptor(model.modelId) : resolveBuiltinModel(model)

  const getApiKey = (provider: string): string | undefined => {
    if (provider === 'mock') return undefined
    const secretRef = config.providerKeys[provider]
    // docs/SECURITY.md §4: resolved here, at call time, immediately before
    // pi issues the request (pi-agent-core reads `getApiKey(model.provider)`
    // per call, not once up front) — the key itself never enters LLM
    // context. Any provider error text that later reaches a log has already
    // been through the redactor (`defaultRedactor`), which the vault-open
    // path (server.ts) registers every resolved secret value with, so a key
    // that leaked into an error message would already be masked.
    return secretRef === undefined ? undefined : secrets.resolve(secretRef)
  }

  const streamFn: PiStreamFn = (model, context, streamOptions) => {
    if (model.provider === 'mock') return streamMock(model, context, streamOptions, mockResponder)
    // docs/SECURITY.md §4: a resolved key reaches pi only through
    // `getApiKey` above, at call time, never through pi-ai's own fallback.
    // pi-ai's compat `streamSimple` silently reads `getEnvApiKey` (ambient
    // `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/... ) when `options.apiKey` is
    // undefined — that path bypasses the vault/SecretResolver entirely, so
    // an operator's stray shell env var could authenticate a request the
    // trust layer never approved. Fail closed instead of delegating.
    // The guard treats a whitespace-only key exactly like a missing one:
    // pi-ai trims the value it receives and falls back to the ambient
    // environment lookup when the trimmed result is empty, so `'  '` would
    // sail past a plain undefined-check and reopen the bypass.
    if (streamOptions?.apiKey === undefined || streamOptions.apiKey.trim() === '') {
      // A rejected promise, not a synchronous throw: every other branch of
      // this function returns `AssistantMessageEventStream | Promise<...>`,
      // and callers (this bridge's own tests, pi's agent loop) both drive
      // `streamFn` with `await`/`.rejects` — a synchronous throw here would
      // reject before either ever gets the chance to attach a handler.
      return Promise.reject(
        new Error(
          `no API key resolved for provider "${model.provider}" — refusing to let pi-ai fall ` +
            `back to an ambient environment variable (docs/SECURITY.md §4); check that ` +
            `routing.json's providerKeys entry for "${model.provider}" references a secret the ` +
            `vault/env resolver can actually resolve`,
        ),
      )
    }
    return streamSimple(model, context, streamOptions)
  }

  return { resolveModel, getApiKey, streamFn }
}

/** Casts away `getBuiltinModel`'s generic catalog-key typing for a dynamic `ModelRef`. */
const lookupBuiltinModel = getBuiltinModel as unknown as (
  provider: string,
  modelId: string,
) => PiModel | undefined

function resolveBuiltinModel(model: ModelRef): PiModel {
  const found = lookupBuiltinModel(model.provider, model.modelId)
  if (!found) {
    throw new Error(
      `no pi-ai built-in model for provider "${model.provider}", modelId "${model.modelId}" — check routing.json`,
    )
  }
  return found
}

/**
 * The two keyless candidates `withMockFallback` (model-routing.ts) appends
 * when no tier candidate resolves a key: `reader-mock` for triage,
 * `worker-mock` for reasoning. Hand-built rather than read off a
 * `createFauxCore` registration — the faux core's `stream`/`streamSimple`
 * only ever consult `requestModel.id`, never the `models` list it was
 * constructed with, so there is nothing to gain from routing this through a
 * live faux registration.
 */
function mockModelDescriptor(modelId: string): PiModel {
  return {
    id: modelId,
    name: modelId,
    api: 'mock',
    provider: 'mock',
    baseUrl: 'http://localhost:0',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

/**
 * A fresh `createFauxCore` per call — never one shared across the bridge's
 * lifetime. Faux's pending-response queue is consumed with `shift()` and
 * errors ("No more faux responses queued") once drained; a bridge-scoped
 * core would race between concurrent turns that both resolve to the mock
 * candidate (a chat turn and a proactive heartbeat/Worker call can land on
 * `reader-mock`/`worker-mock` at the same time), each stealing the queue
 * slot meant for the other. Scoping the core — and its one-shot queue — to
 * this single call removes the race entirely; the cost is one throwaway
 * object per call, not a measurable one for a mock provider.
 */
function streamMock(
  model: PiModel,
  context: PiChatContext,
  streamOptions: SimpleStreamOptions | undefined,
  mockResponder: MockResponder | undefined,
) {
  const core = createFauxStreamCore({ provider: 'mock' })
  const step: FauxResponseStep = mockResponder
    ? async (ctx, _options, state) => mockResponder(ctx, state)
    : piFauxAssistantMessage('Hello — the mock provider has no response script configured yet.')
  core.setResponses([step])
  return core.stream(model, context, streamOptions)
}
