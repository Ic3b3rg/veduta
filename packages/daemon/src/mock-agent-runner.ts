import {
  AgentEventBus,
  computeContextHash,
  MemorySessionStore,
  type AgentEvent,
  type AgentPromptOptions,
  type AgentRunner,
  type ModelRef,
  type SessionStore,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type TriggerRef,
} from './agent-runner.ts'
import {
  effectiveOrigin,
  gateToolsForOrigins,
  isUntrusted,
  TurnTaintAccumulator,
  type Origin,
  type TurnTaint,
} from './taint.ts'

const MOCK_MODEL: ModelRef = { provider: 'mock', modelId: 'mock-agent-runner', tier: 'triage' }
const DEFAULT_USER_ORIGIN: Origin = 'trusted:user'
const CANNED_REPLY = 'Displayed the requested content.'

export interface MockAgentRunnerOptions {
  /**
   * Trust-layer wrapping predicate (D5/issue #14), forwarded to
   * `gateToolsForOrigins` as its third argument: when supplied, L1/L2 tools
   * pass the gate iff wrapped, regardless of taint (the wrapped handler
   * decides at execution time). Omit to keep the pre-trust-layer,
   * taint-only gating (issue #13).
   */
  isToolTrustWrapped?: (tool: ToolDef) => boolean
}

/**
 * Deterministic, zero-network `AgentRunner` (mock-first dev, same spirit as
 * `mockReply` and the scheduler's stub judge — dev works with no VPS,
 * domain, or provider key, by design). It honors the taint half of the
 * `AgentRunner` contract well enough to exercise the full-text flow and
 * chat wiring end-to-end without a real provider: it appends the user
 * message with its origin, gates the offered tools through
 * `gateToolsForOrigins` (exposing the gated list via `lastGatedTools` for
 * assertions), and emits a canned, content-free assistant reply that
 * inherits the untrusted origin per the derivation rule (v3 §B.5) — it
 * never echoes anything from inside the prompt, so it cannot itself be a
 * laundering vector.
 *
 * It never dispatches a tool call itself (the canned reply is the only
 * output); `runTool` is a test-support method that simulates the runner
 * invoking one gated tool mid-turn with the live `ToolContext` a real
 * runner would build (D10/A3), so the taint-accumulation and context-hash
 * contracts are exercisable without a real model loop.
 */
export class MockAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly sessionStore: SessionStore
  private readonly isToolTrustWrapped: ((tool: ToolDef) => boolean) | undefined
  private sessionId: string | undefined = undefined
  private currentTurnOrigin: Origin = DEFAULT_USER_ORIGIN
  private currentTurnOrigins: Origin[] = []
  private currentTurnInput = ''
  private currentSpaceId: string | undefined = undefined
  private currentTrigger: TriggerRef | undefined = undefined

  /** The tools admitted to the most recent `prompt()` call, after the taint gate. */
  lastGatedTools: ToolDef[] = []
  /** Live per-turn taint accumulator (D10), seeded at the start of the most recent `prompt()` call. */
  taint: TurnTaint = new TurnTaintAccumulator([])
  /** Hash of the model-visible context: recomputed at turn start and before each `runTool` dispatch (A3). */
  contextHash = ''

  constructor(
    sessionStore: SessionStore = new MemorySessionStore(),
    options: MockAgentRunnerOptions = {},
  ) {
    this.sessionStore = sessionStore
    this.isToolTrustWrapped = options.isToolTrustWrapped
  }

  async start(sessionId: string): Promise<void> {
    this.sessionId = sessionId
  }

  async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
    if (!this.sessionId) {
      const message = 'MockAgentRunner.start must be called before prompt'
      await this.events.emit({ type: 'error', message })
      throw new Error(message)
    }
    const sessionId = this.sessionId
    const promptOrigin = options.origin ?? DEFAULT_USER_ORIGIN
    // Session-message origins count too, mirroring PiAgentRunner: a session
    // tainted by an earlier turn keeps gating later ones ("swap the runner
    // instance, nothing else" must hold for re-taint semantics as well).
    const sessionOrigins = (await this.sessionStore.load(sessionId)).messages.map(
      (message) => message.origin,
    )
    const candidateOrigins: (Origin | undefined)[] = [
      promptOrigin,
      ...(options.contextOrigins ?? []),
      ...sessionOrigins,
    ]
    const turnOrigin = effectiveOrigin(candidateOrigins, promptOrigin)
    this.currentTurnOrigin = turnOrigin
    this.currentTurnOrigins = candidateOrigins.filter(
      (origin): origin is Origin => origin !== undefined,
    )
    this.taint = new TurnTaintAccumulator(candidateOrigins)
    this.currentTurnInput = input
    this.currentSpaceId = options.spaceId
    this.currentTrigger = options.trigger
    this.lastGatedTools = gateToolsForOrigins(
      options.tools ?? [],
      candidateOrigins,
      this.isToolTrustWrapped,
    )
    await this.recomputeContextHash(sessionId)

    if (options.retryOfFailedTurn !== true) {
      await this.sessionStore.append(sessionId, {
        type: 'message',
        message: {
          role: 'user',
          content: input,
          ...(promptOrigin === DEFAULT_USER_ORIGIN ? {} : { origin: promptOrigin }),
        },
      })
    }

    await this.sessionStore.append(sessionId, {
      type: 'message',
      message: {
        role: 'assistant',
        content: CANNED_REPLY,
        ...(isUntrusted(turnOrigin) ? { origin: turnOrigin } : {}),
      },
    })

    await this.events.emit({
      type: 'turn-end',
      sessionId,
      model: options.model ?? MOCK_MODEL,
      text: CANNED_REPLY,
    })
  }

  abort(): void {}

  on(handler: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.events.on(handler)
  }

  /**
   * Test-support: simulates the runner dispatching one gated tool mid-turn
   * (this class never does so on its own). Builds the live `ToolContext`
   * (D10/A3) from the current turn's seed `origins`, the shared `taint`
   * accumulator, `spaceId`/`trigger`, and a freshly recomputed
   * `contextHash`; when the tool reports `ToolResult.origins`, folds them
   * into `taint` and persists them on the tool's `SessionMessage`
   * (`origins` array plus the most-untrusted single `origin` mark).
   */
  async runTool(tool: ToolDef, input: unknown, toolCallId: string): Promise<ToolResult> {
    const sessionId = this.requireSessionId()
    await this.recomputeContextHash(sessionId)
    const parsed = tool.schema.parse(input)
    const context: ToolContext = {
      toolCallId,
      origin: this.currentTurnOrigin,
      origins: this.currentTurnOrigins,
      taint: this.taint,
      contextHash: this.contextHash,
      ...(this.currentSpaceId === undefined ? {} : { spaceId: this.currentSpaceId }),
      ...(this.currentTrigger === undefined ? {} : { trigger: this.currentTrigger }),
    }
    const result = await tool.handler(parsed, context)
    if (result.origins && result.origins.length > 0) {
      for (const origin of result.origins) this.taint.add(origin)
      const singleOrigin = effectiveOrigin(
        [this.currentTurnOrigin, ...result.origins],
        this.currentTurnOrigin,
      )
      await this.sessionStore.append(sessionId, {
        type: 'message',
        message: {
          role: 'tool',
          content: result.content,
          toolCallId,
          toolName: tool.name,
          ...(result.details === undefined ? {} : { details: result.details }),
          origins: result.origins,
          ...(isUntrusted(singleOrigin) ? { origin: singleOrigin } : {}),
        },
      })
    }
    await this.recomputeContextHash(sessionId)
    return result
  }

  /** A3: the model-visible envelope for the mock runner is its full session message list plus the turn's input. */
  private async recomputeContextHash(sessionId: string): Promise<void> {
    const messages = (await this.sessionStore.load(sessionId)).messages
    this.contextHash = computeContextHash({ messages, input: this.currentTurnInput })
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('MockAgentRunner.start must be called before prompt')
    return this.sessionId
  }
}
