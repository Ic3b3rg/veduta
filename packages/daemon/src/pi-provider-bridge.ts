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
import type { RoutingConfig, RuntimeRoutingConfig, SecretResolver } from './model-routing.ts'
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

/**
 * A routable Model connection as the bridge sees it (issue #47). `transport`
 * is `'builtin'` today — every connection resolves through pi-ai's own
 * builtin catalog (Anthropic/OpenAI/OpenRouter). The `'subscription'`
 * transport (Codex, answering through the daemon's own adapter rather than
 * pi-ai, per docs/adr/0014-subscription-inference-boundary.md) arrives with
 * its first consumer in the inference-seam work that follows this slice.
 */
export interface ModelConnectionRuntime {
  connectionId: string
  provider: string
  transport: 'builtin'
}

export interface ProviderBridgeOptions {
  /**
   * A live config snapshot, or a getter for one (issue #47): the registry
   * rebuilds routing on every connection mutation, and a function lets the
   * bridge always read the current config instead of one captured at
   * construction time. A plain `RoutingConfig` — every existing caller —
   * keeps working unchanged.
   */
  config: RoutingConfig | (() => RuntimeRoutingConfig)
  secrets: SecretResolver
  /**
   * The live connection roster (issue #47). Not yet consulted by this
   * bridge — every connection today resolves through the builtin branch
   * below — and arrives with its first consumer alongside the
   * `'subscription'` transport.
   */
  connections?: () => ModelConnectionRuntime[]
  /** Deterministic loopback chat behavior, not yet supplied by any caller. Omit for a single canned reply. */
  mockResponder?: MockResponder
}

/**
 * Binds a resolved `PiModel` descriptor to the Model connection it came
 * from (issue #47). A symbol-keyed property is invisible to
 * `JSON.stringify` and survives `{ ...model }` spreads (own enumerable
 * symbol keys are copied) — pi-agent-core carries the exact descriptor
 * object `resolveModel` returned across a turn, by reference, so the stamp
 * rides along with it. `streamFn` reads this back to decide which key
 * resolves the request; `model.provider` itself is never repurposed for
 * this (see `resolveBuiltinModel` below for why).
 */
const CONNECTION_BINDING = Symbol('veduta.connectionId')

/**
 * Every descriptor `resolveModel` returns carries this stamp: `null` for a
 * legacy, unbound `ModelRef` (the bare-provider `providerKeys` path,
 * unchanged since issue #37), or the Model connection id whose
 * `connectionKeys` entry must resolve the request's key. A descriptor with
 * no own property at this key never came from this bridge at all —
 * `streamFn` treats that as a fail-closed refusal rather than guessing
 * which key it should use.
 */
type BoundPiModel = PiModel & { [CONNECTION_BINDING]?: string | null }

/**
 * Maps a routed `ModelRef` plus its resolved key onto pi-ai's provider
 * clients (ADR-0004 §"pi is never imported directly"): `resolveModel` and
 * `streamFn` are the two seams `PiAgentRunner` was built with and never
 * given (`pi-agent-runner.ts`'s `PiAgentRunnerOptions`).
 */
export function createProviderBridge(options: ProviderBridgeOptions): ProviderBridge {
  const { config, secrets, mockResponder } = options

  /**
   * Normalizes the `RoutingConfig | (() => RuntimeRoutingConfig)` union
   * (issue #47) to a single read, called at the point of use rather than
   * once at construction time — the registry's live routing rebuilds must
   * be visible to the very next call, not just the next `createProviderBridge`.
   */
  const readConfig = (): RoutingConfig | RuntimeRoutingConfig =>
    typeof config === 'function' ? config() : config

  const resolveModel = (model: ModelRef): PiModel => {
    if (model.provider === 'mock') {
      const descriptor: BoundPiModel = { ...mockModelDescriptor(model.modelId) }
      descriptor[CONNECTION_BINDING] = model.connectionId ?? null
      return descriptor
    }
    // pi-ai's builtin catalog lookup returns a shared object per
    // provider+model, not a fresh one per call. Stamping it in place would
    // leak one connection's binding onto every other `ModelRef` that
    // resolves to the same provider+model — two accounts on the same
    // provider must never end up sharing a key
    // (docs/adr/0014-subscription-inference-boundary.md). Clone first,
    // stamp the clone.
    const descriptor: BoundPiModel = { ...resolveBuiltinModel(model) }
    descriptor[CONNECTION_BINDING] = model.connectionId ?? null
    // `descriptor.provider` is left exactly as `resolveBuiltinModel`
    // returned it — never rewritten to the connection id. pi-ai's compat
    // layer decides whether a call goes through its builtin provider
    // clients (with the provider's own baseUrl, headers and auth applied)
    // by matching `model.provider` against its own catalog; substituting a
    // connection id here would silently divert the request onto a
    // different, unauthenticated code path instead of just failing loudly.
    // The connection travels on `CONNECTION_BINDING` instead, precisely so
    // `provider` can stay canonical.
    return descriptor
  }

  const getApiKey = (provider: string): string | undefined => {
    if (provider === 'mock') return undefined
    const secretRef = readConfig().providerKeys[provider]
    // docs/SECURITY.md §4: resolved here, at call time, immediately before
    // pi issues the request (pi-agent-core reads `getApiKey(model.provider)`
    // per call, not once up front) — the key itself never enters LLM
    // context. Any provider error text that later reaches a log has already
    // been through the redactor (`defaultRedactor`), which the vault-open
    // path (server.ts) registers every resolved secret value with, so a key
    // that leaked into an error message would already be masked.
    return secretRef === undefined ? undefined : secrets.resolve(secretRef)
  }

  /**
   * The single point where a request's API key is decided (issue #47).
   * Reads the `CONNECTION_BINDING` stamp `resolveModel` left on the
   * descriptor — never `model.provider` — and throws (never returns a key
   * pulled from the wrong place) when that stamp cannot yield one. Callers
   * turn the throw into a rejected promise; see the comment in `streamFn`
   * for why that indirection exists.
   */
  const resolveRequestApiKey = (
    model: PiModel,
    streamOptions: SimpleStreamOptions | undefined,
  ): string => {
    const boundModel = model as BoundPiModel
    if (!Object.prototype.hasOwnProperty.call(boundModel, CONNECTION_BINDING)) {
      // Fail closed: a descriptor with no binding at all never passed
      // through this bridge's `resolveModel`, so there is no record of
      // which key — if any — it is entitled to. Never fall through to
      // `streamOptions.apiKey`: that value could belong to any provider.
      throw new Error(
        'this model descriptor did not come from the provider bridge; refusing the turn',
      )
    }
    // `hasOwnProperty` above already proved the stamp is present, so the
    // value is `string | null` in practice; the cast just tells the
    // compiler what the runtime check already guarantees.
    const connectionId = boundModel[CONNECTION_BINDING] as string | null

    let apiKey: string | undefined
    let missingKeyMessage: string
    if (connectionId === null) {
      // Legacy, unbound descriptor: the bare-provider `providerKeys` path,
      // unchanged since issue #37.
      apiKey = streamOptions?.apiKey
      missingKeyMessage =
        `no API key resolved for provider "${model.provider}" — refusing to let pi-ai fall ` +
        `back to an ambient environment variable (docs/SECURITY.md §4); check that ` +
        `routing.json's providerKeys entry for "${model.provider}" references a secret the ` +
        `vault/env resolver can actually resolve`
    } else {
      // Connection-bound: the key resolves from `connectionKeys[connectionId]`
      // only. `streamOptions.apiKey` is deliberately never read on this
      // path — pi-agent-core pre-fills it with `getApiKey(model.provider)`,
      // the LEGACY bare-provider key, before every call, and reading it
      // here would silently bill whatever account that legacy key belongs
      // to instead of the connection the user actually selected.
      const secretRef = readConfig().connectionKeys[connectionId]
      apiKey = secretRef === undefined ? undefined : secrets.resolve(secretRef)
      missingKeyMessage =
        `no stored key for Model connection "${connectionId}" — refusing the turn rather ` +
        `than borrowing another credential`
    }

    // The guard treats a whitespace-only key exactly like a missing one on
    // both paths: pi-ai trims the value it receives and falls back to the
    // ambient environment lookup when the trimmed result is empty, so
    // `'  '` would sail past a plain undefined-check and reopen the bypass
    // this whole function exists to close.
    if (apiKey === undefined || apiKey.trim() === '') throw new Error(missingKeyMessage)
    return apiKey
  }

  const streamFn: PiStreamFn = (model, context, streamOptions) => {
    if (model.provider === 'mock') return streamMock(model, context, streamOptions, mockResponder)
    try {
      const apiKey = resolveRequestApiKey(model, streamOptions)
      return streamSimple(model, context, { ...streamOptions, apiKey })
    } catch (error) {
      // A rejected promise, not a synchronous throw: every other branch of
      // this function returns `AssistantMessageEventStream | Promise<...>`,
      // and callers (this bridge's own tests, pi's agent loop) both drive
      // `streamFn` with `await`/`.rejects` — a synchronous throw here would
      // reject before either ever gets the chance to attach a handler.
      return Promise.reject(error)
    }
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
 * True when pi-ai's builtin catalog can resolve `provider`/`modelId`
 * (issue #47): the Model connection registry uses this to mark a
 * connection's catalog entries that this build cannot actually route to as
 * disabled, rather than let them silently fail mid-turn. `tier` has no
 * bearing on whether the catalog lookup succeeds — `'reasoning'` is an
 * arbitrary but valid placeholder so the call satisfies `ModelRef`.
 */
export function isBuiltinModel(provider: string, modelId: string): boolean {
  try {
    resolveBuiltinModel({ provider, modelId, tier: 'reasoning' })
    return true
  } catch {
    return false
  }
}

/**
 * One minimal turn through the exact `resolveModel` + `streamFn` path a
 * real chat turn takes (issue #47) — every Model connection method's
 * verification step is this call, never a bare status-code check.
 * `bridge.getApiKey` supplies the legacy provider key for an unbound
 * `ModelRef`; a connection-bound `ModelRef` ignores whatever this returns
 * (`resolveRequestApiKey` resolves from `connectionKeys` instead), exactly
 * like a real turn would.
 */
export async function probeModel(bridge: ProviderBridge, model: ModelRef): Promise<void> {
  const descriptor = bridge.resolveModel(model)
  const context: PiChatContext = {
    systemPrompt: 'You are a connection test.',
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  }
  const apiKey = bridge.getApiKey(descriptor.provider)
  const stream = await bridge.streamFn(descriptor, context, {
    ...(apiKey === undefined ? {} : { apiKey }),
    maxTokens: 8,
  })
  for await (const _event of stream) {
    // Drain to completion; only the final message matters here.
  }
  const finalMessage = await stream.result()
  if (finalMessage.stopReason === 'error') {
    throw new Error(
      finalMessage.errorMessage ?? 'the connection test failed with no error message reported',
    )
  }
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
