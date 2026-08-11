import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type FauxResponseStep,
  type ImageContent,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelRef } from './agent-runner.ts'
import {
  markNonRetryable,
  NonRetryableModelError,
  type RoutingConfig,
  type RuntimeRoutingConfig,
  type SecretResolver,
} from './model-routing.ts'
import type { PiModel, PiStreamFn } from './pi-agent-runner.ts'
import { toSubscriptionPrompt, type SubscriptionPrompt } from './subscription-prompt.ts'

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
/** pi-ai's per-block content types, renamed for the same reason — `subscription-prompt.ts` (issue #47) needs these to render a `PiChatContext` into text without ever importing pi-ai directly. */
export type PiTextContent = TextContent
export type PiImageContent = ImageContent
export type PiThinkingContent = ThinkingContent
export type PiToolCall = ToolCall

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
 * A routable Model connection as the bridge sees it (issue #47). `'builtin'`
 * resolves through pi-ai's own builtin catalog (Anthropic/OpenAI/OpenRouter,
 * `resolveBuiltinModel` below). `'subscription'` (Codex) answers through the
 * daemon's own adapter instead of pi-ai
 * (docs/adr/0014-subscription-inference-boundary.md) — its `stream` member
 * is what `resolveModel`/`streamFn` call instead of ever dialing pi-ai's own
 * HTTP client for that connection. `connection-inference.ts` is the one
 * place that builds this array for `server.ts` — it wraps
 * `ModelConnectionRegistry.runtimes()`'s raw sources with the
 * freshness/failure policy this bridge deliberately does not know about.
 */
export interface ModelConnectionRuntime {
  connectionId: string
  provider: string
  transport: 'builtin' | 'subscription'
  /** Present only on a `'subscription'`-transport runtime. Absent (or a runtime with none) fails the turn closed — never silently degrades to the builtin/mock path. */
  stream?: (request: SubscriptionStreamRequest) => AsyncIterable<string>
}

/** One subscription-transport turn's request (issue #47): the prompt is already the exact `PiChatContext` mapping (`subscription-prompt.ts`) — a subscription adapter never sees pi's structured `Context`. */
export interface SubscriptionStreamRequest {
  modelId: string
  prompt: SubscriptionPrompt
  signal?: AbortSignal
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
   * The live connection roster (issue #47): `resolveModel` consults this to
   * find a `'subscription'`-transport runtime for a connection-bound
   * `ModelRef`, and `streamFn` reads the matching runtime's `stream` back
   * off the descriptor's `CONNECTION_BINDING` stamp. `server.ts` supplies
   * `connection-inference.ts`'s `createConnectionRuntimes(registry)`, never
   * a bare `() => registry.runtimes()` — the wrapping there is what makes a
   * revoked/expired subscription fail the turn instead of silently
   * retrying with a stale credential.
   */
  connections?: () => ModelConnectionRuntime[]
  /** Optional deterministic Loopback-profile chat behavior. Omit for a single canned reply. */
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
 * Clones `base` and stamps the clone with `connectionId` (issue #47) — the
 * one place `resolveModel`'s three branches (mock, subscription, builtin)
 * all go through. Cloning first is load-bearing, not decorative:
 * `resolveBuiltinModel`'s pi-ai lookup returns a shared object per
 * provider+model, not a fresh one per call, so stamping it in place would
 * leak one connection's binding onto every other `ModelRef` that resolves
 * to the same provider+model — two accounts on the same provider must
 * never end up sharing a key
 * (docs/adr/0014-subscription-inference-boundary.md).
 */
function stampConnection(base: PiModel, connectionId: string | null): BoundPiModel {
  const descriptor: BoundPiModel = { ...base }
  descriptor[CONNECTION_BINDING] = connectionId
  return descriptor
}

/**
 * Reads the `CONNECTION_BINDING` stamp off `model` — `null` for a legacy,
 * unbound descriptor, the Model connection id otherwise. Throws when
 * `model` carries no stamp at all: it never passed through this bridge's
 * `resolveModel`, so there is no record of which key or runtime it is
 * entitled to, and neither `resolveRequestApiKey` nor
 * `resolveSubscriptionRuntime` (the two callers) may fall through to a
 * guess. Callers turn the throw into a rejected promise; see the comment in
 * `streamFn` for why that indirection exists.
 */
function connectionIdOf(model: PiModel): string | null {
  const boundModel = model as BoundPiModel
  if (!Object.prototype.hasOwnProperty.call(boundModel, CONNECTION_BINDING)) {
    throw new Error(
      'this model descriptor did not come from the provider bridge; refusing the turn',
    )
  }
  // `hasOwnProperty` above already proved the stamp is present, so the
  // value is `string | null` in practice; the cast just tells the compiler
  // what the runtime check already guarantees.
  return boundModel[CONNECTION_BINDING] as string | null
}

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

  /** The live connection roster, read at the point of use (issue #47) — same rationale as `readConfig`. */
  const liveConnections = (): ModelConnectionRuntime[] => options.connections?.() ?? []

  const findRuntime = (connectionId: string): ModelConnectionRuntime | undefined =>
    liveConnections().find((runtime) => runtime.connectionId === connectionId)

  const resolveModel = (model: ModelRef): PiModel => {
    if (model.provider === 'mock') {
      return stampConnection(mockModelDescriptor(model.modelId), model.connectionId ?? null)
    }
    // A connection-bound `ModelRef` whose runtime is `'subscription'`
    // transport (Codex) never resolves through pi-ai's builtin catalog at
    // all — it answers through the connection's own `stream` verb instead
    // (docs/adr/0014-subscription-inference-boundary.md). Checked before
    // the builtin lookup below so a subscription connection's `modelId`
    // (from its own `model/list` catalog, not pi-ai's) never has to exist
    // in pi-ai's catalog.
    const runtime = model.connectionId === undefined ? undefined : findRuntime(model.connectionId)
    if (runtime?.transport === 'subscription') {
      return stampConnection(
        subscriptionModelDescriptor(runtime, model.modelId),
        runtime.connectionId,
      )
    }
    // `descriptor.provider` is left exactly as `resolveBuiltinModel`
    // returned it — never rewritten to the connection id. pi-ai's compat
    // layer decides whether a call goes through its builtin provider
    // clients (with the provider's own baseUrl, headers and auth applied)
    // by matching `model.provider` against its own catalog; substituting a
    // connection id here would silently divert the request onto a
    // different, unauthenticated code path instead of just failing loudly.
    // The connection travels on `CONNECTION_BINDING` instead (`stampConnection`'s
    // own doc comment), precisely so `provider` can stay canonical.
    return stampConnection(resolveBuiltinModel(model), model.connectionId ?? null)
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
    // Never falls through to `streamOptions.apiKey` on a missing stamp —
    // that value could belong to any provider (`connectionIdOf`'s own fail-
    // closed doc comment).
    const connectionId = connectionIdOf(model)

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

  /**
   * The single point where a subscription-transport request's runtime is
   * decided (issue #47) — the `stream`-verb counterpart of
   * `resolveRequestApiKey` above. Reads the `CONNECTION_BINDING` stamp only
   * — never `model.provider` — and throws rather than falling through to
   * ANY other transport when it cannot yield a usable runtime. There is no
   * API key to resolve on this path by construction (a subscription
   * connection answers through its own adapter, never pi-ai's HTTP client),
   * so this fails closed on "no active runtime for this connection" instead
   * of the empty-key check `resolveRequestApiKey` uses — the fail-closed
   * guard that function embodies is not weakened by this branch existing
   * beside it, it simply has nothing to resolve here.
   */
  const resolveSubscriptionRuntime = (model: PiModel): ModelConnectionRuntime => {
    const connectionId = connectionIdOf(model)
    const runtime = connectionId === null ? undefined : findRuntime(connectionId)
    if (!runtime || runtime.transport !== 'subscription' || !runtime.stream) {
      throw new Error(
        connectionId === null
          ? 'a subscription-transport model descriptor carries no connection id — this is a daemon wiring bug'
          : `Model connection "${connectionId}" is not available to answer a subscription turn — reconnect it and try again`,
      )
    }
    return runtime
  }

  const streamFn: PiStreamFn = (model, context, streamOptions) => {
    if (model.provider === 'mock') return streamMock(model, context, streamOptions, mockResponder)
    if (model.api === 'veduta-subscription') {
      try {
        const runtime = resolveSubscriptionRuntime(model)
        const prompt = toSubscriptionPrompt(context)
        // `runtime.stream` was just proven present by `resolveSubscriptionRuntime`.
        return streamSubscription(model, prompt, streamOptions, runtime.stream!)
      } catch (error) {
        // Same rejected-promise rationale as the catch below: `toSubscriptionPrompt`'s
        // fail-closed refusal (a turn carrying Veduta tools) and a missing
        // runtime both throw synchronously here, before any stream exists.
        return Promise.reject(error)
      }
    }
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

/**
 * A hand-built descriptor for a `'subscription'`-transport runtime (issue
 * #47), the same footing as `mockModelDescriptor` above: `api:
 * 'veduta-subscription'` is a novel string pi-ai's `Api` type happily
 * accepts (`KnownApi | (string & {})`, verified against the installed
 * package — see docs/adr/0014-subscription-inference-boundary.md), and it
 * is what `streamFn` switches on to route the call through the connection's
 * own `stream` verb instead of pi-ai's compat `streamSimple`.
 *
 * pi-ai ships its own `openai-codex` provider and `openai-codex-responses`
 * api (`providers/all.js`) — deliberately NOT used here. They reproduce
 * Codex's own OAuth client identity, which
 * `issues/047-model-connections.md` records is not something Veduta may
 * do (ref-11's research: a third-party product may not present itself as
 * the pinned Codex client to obtain subscription credentials outside the
 * documented `codex app-server` device-code flow). `runtime.provider` here
 * is the canonical provider name (`'openai'`) purely for display and
 * egress-host lookup — never used to pick a pi-ai provider client.
 */
function subscriptionModelDescriptor(runtime: ModelConnectionRuntime, modelId: string): PiModel {
  return {
    id: modelId,
    name: modelId,
    api: 'veduta-subscription',
    provider: runtime.provider,
    baseUrl: 'http://localhost:0',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

/** Every field of a subscription turn's usage report — no token accounting happens on this path (issue #47: the connection's own adapter, not pi-ai, ran the call). */
const SUBSCRIPTION_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Builds the `'veduta-subscription'` branch's `AssistantMessageEventStream`
 * (issue #47) on `createAssistantMessageEventStream()` — pi-ai's own
 * extension seam (`utils/event-stream.d.ts`'s doc comment: "for use in
 * extensions") — rather than a faux queue: `runtimeStream` is a real,
 * incrementally-arriving async iterable of text deltas (the Codex
 * adapter's `stream`), not a canned response to replay. Emits exactly the
 * event sequence pi's own providers use for a text-only reply: `start` →
 * `text_start` → one `text_delta` per chunk → `text_end` → `done`; any
 * thrown error (including `toSubscriptionPrompt`'s tools refusal reaching
 * this far, or the runtime stream itself failing mid-turn) becomes the
 * `error` event pi's own faux/real providers use, carrying the message on
 * `errorMessage` — never a rejected promise once the stream object exists,
 * matching pi's contract that a provider failure is a resolved turn with
 * `stopReason: 'error'` (`pi-agent-runner.ts`'s own doc comments on
 * `TurnFailedError`/`turnFailureStatus`).
 */
function streamSubscription(
  model: PiModel,
  prompt: SubscriptionPrompt,
  streamOptions: SimpleStreamOptions | undefined,
  runtimeStream: (request: SubscriptionStreamRequest) => AsyncIterable<string>,
): PiAssistantMessageEventStream {
  const outer = createAssistantMessageEventStream()
  const base = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: SUBSCRIPTION_USAGE,
    timestamp: Date.now(),
  } as const
  queueMicrotask(async () => {
    try {
      let text = ''
      let partial: PiAssistantMessage = {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        ...base,
      }
      outer.push({ type: 'start', partial: { ...partial } })
      outer.push({ type: 'text_start', contentIndex: 0, partial: { ...partial } })
      for await (const delta of runtimeStream({
        modelId: model.id,
        prompt,
        ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
      })) {
        text += delta
        partial = { ...partial, content: [{ type: 'text', text }] }
        outer.push({ type: 'text_delta', contentIndex: 0, delta, partial: { ...partial } })
      }
      outer.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...partial } })
      const finalMessage: PiAssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        ...base,
      }
      outer.push({ type: 'done', reason: 'stop', message: finalMessage })
      outer.end(finalMessage)
    } catch (error) {
      const finalMessage: PiAssistantMessage = {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        ...base,
      }
      // The thrown error's class identity is otherwise dropped here — pi
      // resolves a provider failure as a completed turn carrying only a
      // bare `errorMessage` string (issue #47,
      // docs/adr/0014-subscription-inference-boundary.md amendment).
      // `markNonRetryable` stamps the exact message OBJECT pi's own agent
      // loop carries all the way to its `message_end` event, so
      // `pi-agent-runner.ts`'s `handlePiEvent` can recover the classification
      // `NonRetryableModelError` carried and refuse to fail this turn over
      // onto a metered fallback (`model-routing.ts`'s `isMarkedNonRetryable`).
      if (error instanceof NonRetryableModelError) markNonRetryable(finalMessage)
      outer.push({ type: 'error', reason: 'error', error: finalMessage })
      outer.end(finalMessage)
    }
  })
  return outer
}
