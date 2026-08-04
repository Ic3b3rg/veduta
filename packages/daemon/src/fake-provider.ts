import type { ModelRef } from './agent-runner.ts'
import {
  createFauxStreamCore,
  piFauxAssistantMessage,
  piFauxText,
  piFauxToolCall,
  type PiAssistantMessage,
  type PiAssistantMessageEventStream,
  type PiChatContext,
  type PiFauxResponseStep,
  type PiUsage,
  type ProviderBridge,
} from './pi-provider-bridge.ts'
import type { PiModel, PiStreamFn } from './pi-agent-runner.ts'

/**
 * Test support module, same footing as `mock-provider.ts` (a normal `src`
 * module, not a `*.test.ts` file). It exists because `import-boundary.test.ts`
 * allows pi-ai's runtime in exactly two files (`pi-agent-runner.ts`,
 * `pi-provider-bridge.ts`) — everything this module needs from pi-ai's faux
 * machinery it gets by importing `./pi-provider-bridge.ts`, never
 * `@earendil-works/pi-ai` directly.
 */

const FAKE_PROVIDER = 'fake'
const DEFAULT_MODEL_ID = 'fake-model'

/** One scripted turn: a canned message, or a factory computed from the live turn context. */
export interface FakeResponseStep {
  message?: PiAssistantMessage
  factory?: (
    context: PiChatContext,
    state: { callCount: number },
  ) => PiAssistantMessage | Promise<PiAssistantMessage>
  /**
   * Overrides the final message's `usage` when this step's turn completes.
   * pi-ai's faux core always reports `usage.cost.total = 0`
   * (`withUsageEstimate` in `@earendil-works/pi-ai/providers/faux` hardcodes
   * it), so a test asserting `ModelRouter.recordSpend` picked up a nonzero
   * cost needs this override.
   */
  usage?: PiUsage
}

export interface FakeProvider extends ProviderBridge {
  setResponses: (steps: FakeResponseStep[]) => void
  appendResponses: (steps: FakeResponseStep[]) => void
  pendingCount: () => number
}

export function fakeText(text: string): PiAssistantMessage {
  return piFauxAssistantMessage(piFauxText(text))
}

export function fakeToolCall(name: string, args: Record<string, unknown>): PiAssistantMessage {
  return piFauxAssistantMessage(piFauxToolCall(name, args))
}

/** A single model call that both says something and calls a tool in the same message — the shape `mock-chat-model.ts`'s `toolCallMessage` produces, and the one that exercises the chat loop's inter-segment separator (`chat-loop.ts`'s `runTurn`: joining more than one model call's text with a blank line rather than concatenating them) when followed by a closing text-only call. */
export function fakeTextAndToolCall(
  text: string,
  name: string,
  args: Record<string, unknown>,
): PiAssistantMessage {
  return piFauxAssistantMessage([piFauxText(text), piFauxToolCall(name, args)], {
    stopReason: 'toolUse',
  })
}

/**
 * A resolved-but-failed turn (pi never rejects a stream; provider failures
 * surface as an assistant message with `stopReason: 'error'` — see
 * `pi-agent-runner.ts`'s `TurnFailedError`/`turnFailureStatus` doc comments).
 * The exact text `HTTP <status>: injected failure` is what
 * `turnFailureStatus` parses back into an HTTP status for
 * `ModelRouter`'s `defaultIsRetryable`.
 */
export function fakeFailure(status: number): PiAssistantMessage {
  return piFauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: `HTTP ${status}: injected failure`,
  })
}

/**
 * Same contract as `fakeFailure`, but the failed message carries real text
 * content instead of an empty string. pi-ai's faux core streams every
 * content block's text as `text-delta` events BEFORE it checks the
 * message's `stopReason` (`streamWithDeltas` in
 * `@earendil-works/pi-ai/providers/faux`) — so a retryable failure can
 * legitimately have streamed visible text to the client before it errors
 * out. Lets a test drive that exact sequence against the chat loop's
 * per-attempt accumulator reset (`chat-loop.ts`'s `resetPerAttemptAccumulation`),
 * proving a later attempt's real reply never concatenates onto this
 * discarded candidate's partial text.
 */
export function fakeFailureWithText(status: number, text: string): PiAssistantMessage {
  return piFauxAssistantMessage(text, {
    stopReason: 'error',
    errorMessage: `HTTP ${status}: injected failure`,
  })
}

/** A `Usage` envelope with the given total cost; every other field zeroed. */
export function fakeUsage(costTotalUsd: number): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: costTotalUsd, total: costTotalUsd },
  }
}

export interface FakeProviderOptions {
  modelId?: string
  /**
   * Extra model ids registered on the same faux core, alongside `modelId`
   * (issue #37's failover acceptance criterion: proving the session's model
   * marker reflects the candidate that actually completed the turn needs
   * two distinguishable models on one `ModelRouter` tier, not two candidates
   * that happen to share a modelId). Empty by default — every existing
   * caller keeps registering exactly the one model it always has.
   */
  additionalModelIds?: string[]
}

/**
 * Deterministic provider for integration tests (issue #37's acceptance
 * criteria run against this, not live keys): a single `createFauxCore`
 * (queue semantics, not per-call cores — tests script an exact sequence of
 * turns and want `appendResponses` to extend that same queue) plus the usage
 * override `streamFn` needs to make scripted cost assertions possible.
 */
export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID
  const modelIds = [modelId, ...(options.additionalModelIds ?? [])]
  const core = createFauxStreamCore({
    provider: FAKE_PROVIDER,
    models: modelIds.map((id) => ({
      id,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    })),
  })
  let usageQueue: (PiUsage | undefined)[] = []

  function toFauxStep(step: FakeResponseStep): PiFauxResponseStep {
    if (step.message) return step.message
    if (step.factory) {
      const factory = step.factory
      return async (context, _options, state) => factory(context, state)
    }
    throw new Error('fake provider step needs a `message` or a `factory`')
  }

  function setResponses(steps: FakeResponseStep[]): void {
    usageQueue = steps.map((step) => step.usage)
    core.setResponses(steps.map(toFauxStep))
  }

  function appendResponses(steps: FakeResponseStep[]): void {
    usageQueue.push(...steps.map((step) => step.usage))
    core.appendResponses(steps.map(toFauxStep))
  }

  const resolveModel = (model: ModelRef): PiModel => {
    if (model.provider !== FAKE_PROVIDER) {
      throw new Error(`fake provider cannot resolve provider "${model.provider}"`)
    }
    const found = core.getModel(model.modelId)
    if (!found) throw new Error(`fake provider has no model "${model.modelId}"`)
    return found
  }

  // Any non-empty string does: nothing downstream of this bridge inspects
  // it, and the fake provider never makes a real HTTP call.
  const getApiKey = (): string | undefined => 'fake-api-key'

  const streamFn: PiStreamFn = (model, context, streamOptions) => {
    const scriptedUsage = usageQueue.shift()
    const stream = core.stream(model, context, streamOptions)
    return withUsageOverride(stream, scriptedUsage)
  }

  return {
    resolveModel,
    getApiKey,
    streamFn,
    setResponses,
    appendResponses,
    pendingCount: () => core.getPendingResponseCount(),
  }
}

/**
 * pi-ai's `AssistantMessageEventStream` (see `EventStream` in
 * `@earendil-works/pi-ai/utils/event-stream`) carries private fields, so a
 * plain proxy object can only ever be assignable to it via `unknown` — there
 * is no structurally-typed way to build one. The proxy keeps async iteration
 * delegated untouched (deltas still stream through exactly as the underlying
 * faux stream produced them) and overrides only `result()`, which is what
 * pi-agent-core's `agent-loop.js` actually reads the final message from
 * (`const finalMessage = await response.result()`), so the scripted usage
 * lands on the message the runner persists and reports cost from.
 */
function withUsageOverride(
  stream: PiAssistantMessageEventStream,
  usage: PiUsage | undefined,
): PiAssistantMessageEventStream {
  if (!usage) return stream
  const proxy = {
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    result: async () => ({ ...(await stream.result()), usage }),
  }
  return proxy as unknown as PiAssistantMessageEventStream
}
