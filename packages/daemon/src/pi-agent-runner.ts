import {
  Agent,
  JsonlSessionRepo,
  type AgentEvent as PiEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type JsonlSessionMetadata,
  type SessionTreeEntry,
  type StreamFn,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { ChatTurnCorrelation } from '@veduta/protocol'
import {
  AgentEventBus,
  buildSessionBranch,
  computeContextHash,
  disabledContextPolicy,
  modelRefsEqual,
  type AgentEvent,
  type AgentPromptOptions,
  type AgentRunner,
  type ContextPolicy,
  type ModelRef,
  type SessionAppend,
  type SessionBranch,
  type SessionEntry,
  type SessionContextFilter,
  type SessionMessage,
  type SessionStore,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type TriggerRef,
} from './agent-runner.ts'
import { isMarkedNonRetryable, NonRetryableModelError } from './model-routing.ts'
import {
  effectiveOrigin,
  gateToolsForOrigins,
  isUntrusted,
  isValidOrigin,
  TurnTaintAccumulator,
  type Origin,
  type TurnTaint,
} from './taint.ts'

type PiInitialState = NonNullable<AgentOptions['initialState']>
/** pi's model shape, named here so the provider bridge (issue #37) can refer to it without importing pi-agent-core's internals directly. */
export type PiModel = NonNullable<PiInitialState['model']>
/** pi's stream-function shape; the provider bridge supplies the mock/test stream path through `PiAgentRunnerOptions.streamFn`. */
export type PiStreamFn = StreamFn
export type PiToolParameters = AgentTool['parameters']

const VEDUTA_MODEL_CHANGE = 'veduta:model-change'
const VEDUTA_MESSAGE_ORIGIN = 'veduta:message-origin'
const DEFAULT_USER_ORIGIN: Origin = 'trusted:user'

/**
 * A `VEDUTA_MESSAGE_ORIGIN` custom entry, as reconstructed from the pi
 * session tree. Never surfaces outside this module: `applyOriginEntries`
 * consumes it and attaches its provenance to the next message entry.
 */
export interface OriginMarkerEntry {
  kind: 'origin-marker'
  origin?: Origin
  origins?: Origin[]
}

/** The raw shape `applyOriginEntries` walks: real entries plus origin markers. */
export type RawSessionEntry = SessionEntry | OriginMarkerEntry

interface OriginEntryData {
  origin?: Origin
  origins?: Origin[]
}

/** Pure encode side of the `VEDUTA_MESSAGE_ORIGIN` custom-entry codec. */
export function originEntryData(origin?: Origin, origins?: Origin[]): OriginEntryData {
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(origins === undefined ? {} : { origins }),
  }
}

/** Pure decode side; `undefined` for anything that is not a valid origin payload. */
function parseOriginEntryData(value: unknown): OriginEntryData | undefined {
  if (!isRecord(value)) return undefined
  const rawOrigin = value['origin']
  const rawOrigins = value['origins']
  const origin = isValidOrigin(rawOrigin) ? rawOrigin : undefined
  const origins =
    Array.isArray(rawOrigins) && rawOrigins.length > 0 && rawOrigins.every(isValidOrigin)
      ? rawOrigins
      : undefined
  if (origin === undefined && origins === undefined) return undefined
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(origins === undefined ? {} : { origins }),
  }
}

/**
 * Annotates-next reconstruction: a `VEDUTA_MESSAGE_ORIGIN`
 * marker is appended immediately before the message entry it annotates.
 * This walks the raw entry list, attaching each marker's provenance to the
 * very next entry when that entry is a message, and dropping the marker
 * either way. A marker with no following entry (or whose next entry is
 * not a message — which forking cannot actually produce, since marker and
 * message are always appended adjacently) is a dangling marker and is
 * ignored, per spec. Pure function: no pi-agent-core types involved.
 */
export function applyOriginEntries(entries: RawSessionEntry[]): SessionEntry[] {
  const result: SessionEntry[] = []
  let pendingProvenance: OriginEntryData | undefined
  for (const entry of entries) {
    if (isOriginMarker(entry)) {
      pendingProvenance = {
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        ...(entry.origins === undefined ? {} : { origins: entry.origins }),
      }
      continue
    }
    if (pendingProvenance !== undefined && entry.type === 'message') {
      result.push({ ...entry, message: { ...entry.message, ...pendingProvenance } })
      pendingProvenance = undefined
      continue
    }
    pendingProvenance = undefined
    result.push(entry)
  }
  return result
}

function isOriginMarker(entry: RawSessionEntry): entry is OriginMarkerEntry {
  return 'kind' in entry && entry.kind === 'origin-marker'
}

/**
 * Rejects a `prompt()` call whose turn pi resolved as a provider error (see
 * `TurnFailedError` below). `status`, when present, is the HTTP status
 * `turnFailureStatus` recovered from pi's error text.
 */
export class TurnFailedError extends Error {
  readonly status?: number

  constructor(message: string, options: { status?: number } = {}) {
    super(message)
    this.name = 'TurnFailedError'
    if (options.status !== undefined) this.status = options.status
  }
}

const HTTP_STATUS_PATTERN = /\bHTTP (\d{3})\b/

/**
 * Recovers the HTTP status pi's error text encodes, if any. pi converts
 * every provider failure into a resolved error turn carrying only text
 * (`Agent.runWithLifecycle` catches stream rejections), so the status the
 * ModelRouter's `defaultIsRetryable`/`statusOf` needs
 * (packages/daemon/src/model-routing.ts) survives only if re-parsed here;
 * providers whose messages carry no status stay retryable, the safe
 * default when `statusOf` finds no `status` property at all.
 */
export function turnFailureStatus(message: string): number | undefined {
  const match = HTTP_STATUS_PATTERN.exec(message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export interface PiAgentRunnerOptions {
  sessionStore: SessionStore
  resolveModel: (model: ModelRef) => PiModel
  defaultModel?: ModelRef
  systemPrompt?: string
  contextPolicy?: ContextPolicy
  toolParameters?: Record<string, PiToolParameters>
  /**
   * Trust-layer wrapping predicate (issue #14), forwarded to
   * `gateToolsForOrigins` as its third argument: when supplied, L1/L2 tools
   * pass the gate iff wrapped, regardless of taint (the wrapped handler
   * decides at execution time). Omit to keep the pre-trust-layer,
   * taint-only gating (issue #13).
   */
  isToolTrustWrapped?: (tool: ToolDef) => boolean
  /**
   * Resolves the API key for a model call just before pi issues it (pi's
   * `agent-loop.js` reads `config.getApiKey(config.model.provider)` per
   * call, not once up front). This is the BYOK vault route (docs/SECURITY.md
   * §4: keys stay out of LLM context) — the provider bridge (issue #37)
   * supplies a `SecretResolver`-backed implementation here.
   */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  /**
   * Overrides pi's model-call transport. The provider bridge (issue #37)
   * supplies the mock/test stream path through this; when omitted, pi falls
   * back to its compat `streamSimple`.
   */
  streamFn?: PiStreamFn
}

export class PiAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly sessionStore: SessionStore
  private readonly resolveModel: (model: ModelRef) => PiModel
  private readonly defaultModel: ModelRef | undefined
  private readonly systemPrompt: string | undefined
  private readonly defaultContextPolicy: ContextPolicy
  private readonly toolParameters: Record<string, PiToolParameters>
  private readonly isToolTrustWrapped: ((tool: ToolDef) => boolean) | undefined
  private readonly getApiKey:
    ((provider: string) => Promise<string | undefined> | string | undefined) | undefined
  private readonly streamFn: PiStreamFn | undefined
  private sessionId: string | undefined = undefined
  private currentModel: ModelRef | undefined = undefined
  private agent: Agent | undefined = undefined
  private unsubscribe: (() => void) | undefined = undefined
  private turnError: string | undefined = undefined
  /** Per session: input of a failed turn whose user message is already stored. */
  private readonly failedTurns = new Map<string, string>()
  /** The current turn's effective origin, threaded into every ToolContext it builds. */
  private currentTurnOrigin: Origin = DEFAULT_USER_ORIGIN
  /** The origin chain the current turn started with (`ToolContext.origins`). */
  private currentTurnOrigins: Origin[] = []
  /** Live per-turn taint accumulator, seeded at the start of `prompt()`, threaded into every ToolContext. */
  private currentTaint: TurnTaint = new TurnTaintAccumulator([])
  /** The current turn's raw input, part of the context-hash envelope. */
  private currentTurnInput = ''
  /**
   * The current turn's effective system prompt (`AgentPromptOptions.systemPrompt`
   * when supplied, else the constructor-level `systemPrompt`), threaded
   * live into `toPiContextTransform` so the context hash covers exactly
   * what crossed the wrapper boundary for this turn.
   */
  private currentSystemPrompt: string | undefined = undefined
  private currentSpaceId: string | undefined = undefined
  private currentTrigger: TriggerRef | undefined = undefined
  private currentInitiatingTurn: ChatTurnCorrelation | undefined = undefined
  /**
   * Hash of the model-visible context for the immediately preceding
   * inference, recomputed by the always-installed
   * context-transform wrapper on every model invocation.
   */
  private currentContextHash = ''
  /** Origins a tool's `ToolResult` reported, keyed by toolCallId, consumed once by `persistPiMessage` when that tool message is stored. */
  private readonly pendingToolOrigins = new Map<string, Origin[]>()
  /**
   * Whether a tool executed during the current `prompt()` attempt, reset at
   * its top and set in `handlePiEvent`'s `tool_execution_start` mapping.
   * Once a tool has run, this attempt's failure paths must reject with
   * `NonRetryableModelError` instead of the retryable `TurnFailedError`
   * (issue #37): a turn that already produced tool side effects must fail to
   * the user rather than fail over — replaying it could re-execute an
   * outbound action. Resumable mid-turn failover is future work.
   */
  private toolExecutedThisTurn = false
  /**
   * Whether the current turn's `turnError` (if any) came from a
   * `NonRetryableModelError` on the pi stream boundary — recovered from the
   * failed message object via `isMarkedNonRetryable`
   * (`model-routing.ts`, issue #47, docs/adr/0014-subscription-inference-boundary.md
   * amendment). Reset everywhere `turnError` is reset; set only in
   * `handlePiEvent`'s assistant-error branch. `prompt()`'s turnError branch
   * checks this the same way it already checks `toolExecutedThisTurn`: either
   * one forces a `NonRetryableModelError` rather than the retryable
   * `TurnFailedError`, so a revoked/expired subscription (or any other
   * classified-non-retryable failure) can never fail over onto a same-turn
   * metered fallback.
   */
  private turnErrorNonRetryable = false

  constructor(options: PiAgentRunnerOptions) {
    this.sessionStore = options.sessionStore
    this.resolveModel = options.resolveModel
    this.defaultModel = options.defaultModel
    this.systemPrompt = options.systemPrompt
    this.defaultContextPolicy = options.contextPolicy ?? disabledContextPolicy
    this.toolParameters = options.toolParameters ?? {}
    this.isToolTrustWrapped = options.isToolTrustWrapped
    this.getApiKey = options.getApiKey
    this.streamFn = options.streamFn
  }

  async start(sessionId: string): Promise<void> {
    this.unsubscribe?.()
    this.sessionId = sessionId
    const branch = await this.sessionStore.load(sessionId)
    this.currentModel = branch.model
    this.turnError = undefined
    this.turnErrorNonRetryable = false
    this.agent = undefined
    if (this.currentModel)
      this.agent = this.createAgent(branch, this.currentModel, [], this.defaultContextPolicy)
  }

  async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
    const sessionId = this.requireSessionId()
    this.toolExecutedThisTurn = false
    const model = options.model ?? this.currentModel ?? this.defaultModel
    if (!model)
      throw new Error('AgentRunner.prompt requires a model before issue 010 model routing')

    // Retry-safe contract: skip re-appending the user message only when
    // a failed attempt actually got as far as appending it — failures
    // before the append (tool mapping, agent setup) must not skip it.
    // The marker is scoped to the session and survives until the turn
    // completes successfully (including across a same-session restart).
    const userMessageAppended =
      options.retryOfFailedTurn === true && this.failedTurns.get(sessionId) === input

    if (!modelRefsEqual(model, this.currentModel)) {
      await this.sessionStore.append(sessionId, { type: 'model-change', model })
      this.currentModel = model
    }

    // Turn taint (docs/SECURITY.md §3.2, ADR-0007): the effective origin is
    // the most-untrusted of the prompt's own origin, its out-of-band
    // context origins, and every message origin already in the session —
    // untrusted state re-taints every future turn it enters.
    // Loaded fresh every turn (not only when (re)building the agent) so a
    // long-running session picks up origins appended since the last turn.
    const branch = await this.sessionStore.load(sessionId)
    const contextFilter = options.contextFilter
    const visibleBranchMessages = contextFilter
      ? contextFilter(branch.messages, { phase: 'history' })
      : branch.messages
    const promptOrigin = options.origin ?? DEFAULT_USER_ORIGIN
    const candidateOrigins: (Origin | undefined)[] = [
      promptOrigin,
      ...(options.contextOrigins ?? []),
      ...visibleBranchMessages.map((message) => message.origin),
    ]
    this.currentTurnOrigin = effectiveOrigin(candidateOrigins, promptOrigin)
    this.currentTurnOrigins = candidateOrigins.filter(
      (origin): origin is Origin => origin !== undefined,
    )
    this.currentTaint = new TurnTaintAccumulator(candidateOrigins)
    this.currentTurnInput = input
    this.currentSpaceId = options.spaceId
    this.currentTrigger = options.trigger
    this.currentInitiatingTurn = options.initiatingTurn
    const tools = this.toPiTools(
      gateToolsForOrigins(options.tools ?? [], candidateOrigins, this.isToolTrustWrapped),
    )
    const contextPolicy = options.contextPolicy ?? this.defaultContextPolicy
    if (!this.agent) {
      // Retry-safe contract (issue #37): when `userMessageAppended` is true,
      // the branch already carries this turn's persisted user message, yet
      // pi's `Agent.prompt(input)` always pushes `input` as a new message
      // onto whatever `initialState.messages` seeded the agent with (see
      // `agent.js`'s `prompt()`/`normalizePromptInput`) — so seeding from
      // the branch as-is would make the same user turn appear twice in the
      // context the model sees. Strip only the trailing persisted copy
      // before it seeds `createAgent`, without mutating what the session
      // store returned.
      this.agent = this.createAgent(
        {
          ...branch,
          messages: branchMessagesForPrompt(visibleBranchMessages, input, userMessageAppended),
        },
        model,
        tools,
        contextPolicy,
        contextFilter,
      )
    }

    this.agent.state.model = this.resolveModel(model)
    this.agent.state.tools = tools
    const effectiveSystemPrompt = options.systemPrompt ?? this.systemPrompt
    this.agent.state.systemPrompt = effectiveSystemPrompt ?? ''
    this.currentSystemPrompt = effectiveSystemPrompt
    // A transform wrapper is always installed, identity included, so
    // every model invocation has a hook to recompute `currentContextHash`
    // from exactly what crossed the wrapper boundary.
    this.agent.transformContext = this.toPiContextTransform(contextPolicy, contextFilter)

    if (!userMessageAppended) {
      await this.sessionStore.append(sessionId, {
        type: 'message',
        message: {
          role: 'user',
          content: input,
          ...(promptOrigin === DEFAULT_USER_ORIGIN ? {} : { origin: promptOrigin }),
        },
      })
      this.failedTurns.set(sessionId, input)
    }

    this.turnError = undefined
    this.turnErrorNonRetryable = false
    try {
      await this.agent.prompt(input)
    } catch (error) {
      // The live pi context already holds this turn's user message; a
      // retry rebuilds the agent from the session store instead.
      this.agent = undefined
      await this.events.emit({ type: 'error', message: errorMessage(error) })
      // A tool already executed during this attempt: this turn must fail to
      // the user rather than fail over (issue #37; see `toolExecutedThisTurn`
      // doc comment above) — a retried turn's `branchMessagesForPrompt` strip
      // is a no-op once the branch ends with tool messages, so failing over
      // here risks re-appending the user message into the model-visible
      // context and silently re-executing an already-executed side effect.
      if (this.toolExecutedThisTurn) throw new NonRetryableModelError(errorMessage(error))
      throw error
    }

    // pi reports provider failures as resolved turns whose assistant
    // message has stopReason "error". The routing contract needs a
    // rejection, with the poisoned agent state discarded for the retry.
    if (this.turnError !== undefined) {
      const message = this.turnError
      const nonRetryable = this.turnErrorNonRetryable
      this.turnError = undefined
      this.turnErrorNonRetryable = false
      this.agent = undefined
      // Same reasoning as the catch block above: a tool already ran this
      // attempt, so this failure must not fail over. `nonRetryable` covers
      // the other case that must never fail over even with no tool call at
      // all — the pi stream boundary's `NonRetryableModelError`
      // classification, recovered via `isMarkedNonRetryable` in
      // `handlePiEvent` below (issue #47).
      if (this.toolExecutedThisTurn || nonRetryable) throw new NonRetryableModelError(message)
      const status = turnFailureStatus(message)
      throw new TurnFailedError(message, status === undefined ? {} : { status })
    }

    this.failedTurns.delete(sessionId)
  }

  abort(): void {
    this.agent?.abort()
  }

  on(handler: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.events.on(handler)
  }

  private createAgent(
    branch: SessionBranch,
    model: ModelRef,
    tools: AgentTool[],
    contextPolicy: ContextPolicy,
    contextFilter?: SessionContextFilter,
  ): Agent {
    const initialState: PiInitialState = {
      model: this.resolveModel(model),
      messages: branch.messages.map((message) => toPiMessage(message, branch.model ?? model)),
      tools,
    }
    if (this.systemPrompt) initialState.systemPrompt = this.systemPrompt

    const agentOptions: AgentOptions = {
      sessionId: branch.sessionId,
      initialState,
      // Always installed, identity when no policy is configured — the
      // only hook available for recomputing `currentContextHash` on every
      // model invocation.
      transformContext: this.toPiContextTransform(contextPolicy, contextFilter),
      // pi executes batched tool calls in parallel by default; the trust
      // layer's `decide()` snapshots live turn taint at execution time
      // (docs/SECURITY.md §3.2), so a batched untrusted read plus an
      // allowlisted L1 action could race the snapshot — sequential
      // execution makes taint from call N visible to call N+1.
      toolExecution: 'sequential',
      ...(this.getApiKey ? { getApiKey: this.getApiKey } : {}),
      ...(this.streamFn ? { streamFn: this.streamFn } : {}),
    }

    const agent = new Agent(agentOptions)
    this.unsubscribe = agent.subscribe((event) => this.handlePiEvent(event))
    return agent
  }

  private toPiTools(tools: ToolDef[]): AgentTool[] {
    return tools.map((tool) => {
      const parameters = this.toolParameters[tool.name]
      if (!parameters) {
        throw new Error(`missing pi parameters for tool "${tool.name}"`)
      }
      return toPiAgentTool(
        tool,
        parameters,
        (toolCallId, signal) => this.buildToolContext(toolCallId, signal),
        (toolCallId, origins) => this.pendingToolOrigins.set(toolCallId, origins),
      )
    })
  }

  /** Builds the live `ToolContext` a tool call reads at execution time. */
  private buildToolContext(toolCallId: string, signal?: AbortSignal): ToolContext {
    const base: ToolContext = {
      toolCallId,
      origin: this.currentTurnOrigin,
      origins: this.currentTurnOrigins,
      taint: this.currentTaint,
      contextHash: this.currentContextHash,
    }
    return {
      ...base,
      ...(signal ? { signal } : {}),
      ...(this.currentSpaceId === undefined ? {} : { spaceId: this.currentSpaceId }),
      ...(this.currentTrigger === undefined ? {} : { trigger: this.currentTrigger }),
      ...(this.currentInitiatingTurn === undefined
        ? {}
        : { initiatingTurn: this.currentInitiatingTurn }),
    }
  }

  private toPiContextTransform(
    policy: ContextPolicy,
    contextFilter?: SessionContextFilter,
  ): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
    return (messages, signal) => {
      const sessionId = this.requireSessionId()
      const options: PiContextTransformOptions = {
        policy,
        sessionId,
        systemPrompt: this.currentSystemPrompt,
        input: this.currentTurnInput,
        fallbackModel: this.currentModel ?? this.defaultModel,
        ...(contextFilter === undefined ? {} : { contextFilter }),
        ...(signal ? { signal } : {}),
      }
      return transformPiContext(messages, options, (hash) => {
        this.currentContextHash = hash
      })
    }
  }

  private async handlePiEvent(event: PiEvent): Promise<void> {
    const sessionId = this.requireSessionId()
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          await this.events.emit({ type: 'text-delta', text: event.assistantMessageEvent.delta })
        }
        return
      case 'message_end':
        if (isAssistantError(event.message)) {
          // A failed assistant message never enters the session store:
          // the failover retry must not rebuild a poisoned context.
          this.turnError = event.message.errorMessage ?? 'Agent error'
          // Recovers the pi stream boundary's `NonRetryableModelError`
          // classification (issue #47): `event.message` is the exact object
          // `pi-provider-bridge.ts`'s `streamSubscription` marked, carried
          // here by reference through pi's own agent loop.
          this.turnErrorNonRetryable = isMarkedNonRetryable(event.message)
          await this.events.emit({ type: 'error', message: this.turnError })
          return
        }
        await this.persistPiMessage(event.message)
        return
      case 'tool_execution_start':
        this.toolExecutedThisTurn = true
        await this.events.emit({
          type: 'tool-start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
        })
        return
      case 'tool_execution_end': {
        const result = fromPiToolResult(event.result)
        await this.events.emit({
          type: 'tool-result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          content: result.content,
          details: result.details,
          isError: event.isError,
        })
        return
      }
      case 'turn_end': {
        // A failed turn rejects from prompt(); it is not a completed turn.
        if (this.turnError !== undefined) return
        const costUsd = piMessageCostUsd(event.message)
        const tokensUsed = piMessageTokens(event.message)
        await this.events.emit({
          type: 'turn-end',
          sessionId,
          model: this.currentModel ?? this.defaultModel!,
          text: piMessageText(event.message),
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(tokensUsed === undefined ? {} : { tokensUsed }),
          origins: this.currentTaint?.origins() ?? [],
        })
        return
      }
      default:
        return
    }
  }

  private async persistPiMessage(message: AgentMessage): Promise<void> {
    const sessionId = this.requireSessionId()
    const mapped = fromPiMessage(message, new Date().toISOString())
    if (!mapped || mapped.role === 'user') return
    // A tool message whose ToolResult reported `origins` carries its own
    // provenance, consumed once here. Every assistant/tool message also
    // inherits the live taint accumulated so far in this turn, including a
    // read that happened after the prompt began.
    const toolOrigins =
      mapped.role === 'tool' && mapped.toolCallId !== undefined
        ? this.pendingToolOrigins.get(mapped.toolCallId)
        : undefined
    if (toolOrigins && mapped.toolCallId !== undefined) {
      this.pendingToolOrigins.delete(mapped.toolCallId)
    }
    const liveOrigins = this.currentTaint?.origins() ?? [this.currentTurnOrigin]
    const singleOrigin = effectiveOrigin(
      toolOrigins ? [...liveOrigins, ...toolOrigins] : liveOrigins,
      this.currentTurnOrigin,
    )
    const stamped: SessionMessage = {
      ...mapped,
      ...(toolOrigins ? { origins: toolOrigins } : {}),
      ...(isUntrusted(singleOrigin) ? { origin: singleOrigin } : {}),
    }
    await this.sessionStore.append(sessionId, { type: 'message', message: stamped })
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('AgentRunner.start must be called before prompt')
    return this.sessionId
  }
}

/**
 * Pure half of the retry-safe seeding fix (issue #37): when
 * `userMessageAppended` is true, the branch loaded from the session store
 * already contains this turn's persisted user message, but pi's
 * `Agent.prompt(input)` always pushes `input` as a new message onto
 * whatever `initialState.messages` seeded the agent with — so seeding an
 * agent from the branch unchanged would make the same user turn appear
 * twice in the context the model sees. Strips only a trailing message that
 * is `role: 'user'` with `content === input`; leaves everything else
 * (a non-matching trailing message, a trailing assistant/tool message, an
 * empty branch) untouched, and is a no-op whenever `userMessageAppended`
 * is false. Exported so this is testable without a live pi `Agent`.
 */
export function branchMessagesForPrompt(
  messages: SessionMessage[],
  input: string,
  userMessageAppended: boolean,
): SessionMessage[] {
  if (!userMessageAppended) return messages
  const last = messages.at(-1)
  if (!last || last.role !== 'user' || last.content !== input) return messages
  return messages.slice(0, -1)
}

export interface PiJsonlSessionStoreOptions {
  cwd: string
  sessionsRoot: string
  env?: NodeExecutionEnv
}

export class PiJsonlSessionStore implements SessionStore {
  private readonly cwd: string
  private readonly repo: JsonlSessionRepo

  constructor(options: PiJsonlSessionStoreOptions) {
    this.cwd = options.cwd
    const env = options.env ?? new NodeExecutionEnv({ cwd: options.cwd })
    this.repo = new JsonlSessionRepo({ fs: env, sessionsRoot: options.sessionsRoot })
  }

  async append(sessionId: string, append: SessionAppend): Promise<SessionEntry> {
    const session = await this.getOrCreate(sessionId)
    const entryId = await this.appendToPiSession(session, append)
    const entry = await session.getEntry(entryId)
    if (!entry) throw new Error(`session append did not return entry: ${entryId}`)
    const mapped = fromPiEntry(entry)
    if (!mapped) throw new Error(`session append returned an unsupported entry: ${entryId}`)
    // The provenance marker (if any) was just written by appendToPiSession and
    // is already known here — no need to read it back through the marker
    // reconstruction pipeline, which only `load`/`branch` require.
    if (
      append.type === 'message' &&
      (append.message.origin !== undefined || append.message.origins !== undefined) &&
      mapped.type === 'message'
    ) {
      return {
        ...mapped,
        message: {
          ...mapped.message,
          ...(append.message.origin === undefined ? {} : { origin: append.message.origin }),
          ...(append.message.origins === undefined ? {} : { origins: append.message.origins }),
        },
      }
    }
    return mapped
  }

  async load(sessionId: string): Promise<SessionBranch> {
    const metadata = await this.findMetadata(sessionId)
    if (!metadata) return { sessionId, entries: [], messages: [] }
    const session = await this.repo.open(metadata)
    const rawEntries = (await session.getEntries()).flatMap((entry) => {
      const mapped = fromPiEntryOrMarker(entry)
      return mapped ? [mapped] : []
    })
    return buildSessionBranch(sessionId, applyOriginEntries(rawEntries))
  }

  async branch(
    sessionId: string,
    options: { fromEntryId?: string; newSessionId?: string } = {},
  ): Promise<SessionBranch> {
    const metadata = await this.findMetadata(sessionId)
    if (!metadata) {
      const newSessionId = options.newSessionId ?? `${sessionId}-branch-${Date.now()}`
      await this.repo.create({ id: newSessionId, cwd: this.cwd })
      return { sessionId: newSessionId, entries: [], messages: [] }
    }
    const forkOptions = {
      cwd: this.cwd,
      position: 'at' as const,
      ...(options.newSessionId === undefined ? {} : { id: options.newSessionId }),
      ...(options.fromEntryId === undefined ? {} : { entryId: options.fromEntryId }),
    }
    const forked = await this.repo.fork(metadata, forkOptions)
    return this.load((await forked.getMetadata()).id)
  }

  private async appendToPiSession(
    session: Awaited<ReturnType<JsonlSessionRepo['create']>>,
    append: SessionAppend,
  ): Promise<string> {
    if (append.type === 'message') {
      // Annotates-next: pi's AgentMessage has no metadata
      // slot, so non-default provenance is recorded as a custom entry
      // immediately before the message it annotates.
      if (append.message.origin !== undefined || append.message.origins !== undefined) {
        await session.appendCustomEntry(
          VEDUTA_MESSAGE_ORIGIN,
          originEntryData(append.message.origin, append.message.origins),
        )
      }
      return session.appendMessage(
        toPiMessage({ ...append.message, at: append.message.at ?? nowIso() }),
      )
    }
    if (append.type === 'model-change') {
      return session.appendCustomEntry(VEDUTA_MODEL_CHANGE, append.model)
    }
    return session.appendCompaction(
      append.summary,
      append.firstKeptEntryId ?? '',
      0,
      append.details,
      true,
    )
  }

  private async getOrCreate(
    sessionId: string,
  ): Promise<Awaited<ReturnType<JsonlSessionRepo['create']>>> {
    const metadata = await this.findMetadata(sessionId)
    return metadata ? this.repo.open(metadata) : this.repo.create({ id: sessionId, cwd: this.cwd })
  }

  private async findMetadata(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return (await this.repo.list({ cwd: this.cwd })).find((metadata) => metadata.id === sessionId)
  }
}

/**
 * Options for `transformPiContext`, the always-installed context-transform
 * wrapper: identity when `policy.enabled` is false,
 * purely so every model invocation has a hook to recompute the context
 * hash from exactly what crossed the wrapper boundary.
 */
export interface PiContextTransformOptions {
  policy: ContextPolicy
  contextFilter?: SessionContextFilter
  sessionId: string
  systemPrompt: string | undefined
  input: string
  fallbackModel: ModelRef | undefined
  signal?: AbortSignal
}

/**
 * Pure(ish) transform-and-hash step, exported so it is unit-testable
 * without a live pi `Agent` (constructing one needs a working provider,
 * impractical to unit-test — see the module doc comment on
 * `applyOriginEntries`). Maps pi's outgoing `AgentMessage[]` to
 * `SessionMessage[]`, applies the `ContextPolicy` transform when enabled
 * (identity otherwise), reports the sha256 of the canonical envelope
 * (`systemPrompt` + the transformed messages + `input`) via `onHash`, then
 * maps back to pi's message shape.
 */
export async function transformPiContext(
  messages: AgentMessage[],
  options: PiContextTransformOptions,
  onHash: (hash: string) => void,
): Promise<AgentMessage[]> {
  const mappedMessages = messages.flatMap((message) => {
    const mapped = fromPiMessage(message, new Date().toISOString())
    return mapped ? [{ pi: message, session: mapped }] : []
  })
  const sessionMessages = mappedMessages.map(({ session }) => session)
  const originalBySession = new Map(mappedMessages.map(({ pi, session }) => [session, pi] as const))
  const filtered = options.contextFilter
    ? options.contextFilter(sessionMessages, { phase: 'turn' })
    : sessionMessages
  const policyContext = options.signal
    ? { sessionId: options.sessionId, signal: options.signal }
    : { sessionId: options.sessionId }
  const transformed = options.policy.enabled
    ? await options.policy.transform(filtered, policyContext)
    : filtered
  onHash(
    computeContextHash({
      systemPrompt: options.systemPrompt,
      messages: transformed,
      input: options.input,
    }),
  )
  return transformed.map(
    (message) => originalBySession.get(message) ?? toPiMessage(message, options.fallbackModel),
  )
}

export function toPiAgentTool(
  tool: ToolDef,
  parameters: PiToolParameters,
  buildContext: (toolCallId: string, signal?: AbortSignal) => ToolContext,
  recordToolOrigins: (toolCallId: string, origins: Origin[]) => void,
): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (toolCallId, params, signal) => {
      const parsed = tool.schema.safeParse(params)
      if (!parsed.success) throw new Error(parsed.error.message)
      const context = buildContext(toolCallId, signal)
      const result = await tool.handler(parsed.data, context)
      if (result.origins && result.origins.length > 0) {
        for (const origin of result.origins) context.taint.add(origin)
        recordToolOrigins(toolCallId, result.origins)
      }
      return toPiToolResult(result)
    },
  }
}

function toPiToolResult(result: ToolResult): {
  content: { type: 'text'; text: string }[]
  details: unknown
  terminate?: boolean
} {
  const piResult = {
    content: [{ type: 'text' as const, text: result.content }],
    details: result.details ?? {},
  }
  return result.terminate === undefined ? piResult : { ...piResult, terminate: result.terminate }
}

function fromPiToolResult(result: unknown): { content: string; details: unknown } {
  if (!isRecord(result)) return { content: '', details: {} }
  const content = Array.isArray(result['content']) ? textFromContent(result['content']) : ''
  return { content, details: result['details'] ?? {} }
}

function toPiMessage(message: SessionMessage, fallbackModel?: ModelRef): AgentMessage {
  const timestamp = Date.parse(message.at)
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now()
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: safeTimestamp }
  }
  if (message.role === 'tool') {
    const toolMessage = {
      role: 'toolResult' as const,
      toolCallId: message.toolCallId ?? 'tool-call',
      toolName: message.toolName ?? 'tool',
      content: [{ type: 'text' as const, text: message.content }],
      isError: message.isError ?? false,
      timestamp: safeTimestamp,
    }
    return message.details === undefined
      ? toolMessage
      : { ...toolMessage, details: message.details }
  }
  const model = message.model ?? fallbackModel
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message.content }],
    api: 'unknown',
    provider: model?.provider ?? 'unknown',
    model: model?.modelId ?? 'unknown',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: safeTimestamp,
  } as AgentMessage
}

function fromPiMessage(message: AgentMessage, fallbackAt: string): SessionMessage | undefined {
  if (!isRecord(message) || typeof message['role'] !== 'string') return undefined
  const at =
    typeof message['timestamp'] === 'number'
      ? new Date(message['timestamp']).toISOString()
      : fallbackAt
  if (message['role'] === 'user') {
    return { role: 'user', content: piMessageText(message), at }
  }
  if (message['role'] === 'toolResult') {
    const toolCallId = stringValue(message['toolCallId'])
    const toolName = stringValue(message['toolName'])
    const toolMessage: SessionMessage = {
      role: 'tool',
      content: piMessageText(message),
      at,
      isError: message['isError'] === true,
    }
    return {
      ...toolMessage,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(message['details'] === undefined ? {} : { details: message['details'] }),
    }
  }
  if (message['role'] === 'assistant') {
    const model = assistantModel(message)
    const base = { role: 'assistant' as const, content: piMessageText(message), at }
    return model ? { ...base, model } : base
  }
  return undefined
}

function fromPiEntry(entry: SessionTreeEntry): SessionEntry | undefined {
  if (entry.type === 'message') {
    const message = fromPiMessage(entry.message, entry.timestamp)
    return message
      ? { id: entry.id, parentId: entry.parentId, at: entry.timestamp, type: 'message', message }
      : undefined
  }
  if (entry.type === 'custom' && entry.customType === VEDUTA_MODEL_CHANGE) {
    const model = parseModelRef(entry.data)
    return model
      ? { id: entry.id, parentId: entry.parentId, at: entry.timestamp, type: 'model-change', model }
      : undefined
  }
  if (entry.type === 'model_change') {
    return {
      id: entry.id,
      parentId: entry.parentId,
      at: entry.timestamp,
      type: 'model-change',
      model: { provider: entry.provider, modelId: entry.modelId, tier: 'reasoning' },
    }
  }
  if (entry.type === 'compaction') {
    const compacted: SessionEntry = {
      id: entry.id,
      parentId: entry.parentId,
      at: entry.timestamp,
      type: 'compaction',
      summary: entry.summary,
    }
    return {
      ...compacted,
      ...(entry.firstKeptEntryId ? { firstKeptEntryId: entry.firstKeptEntryId } : {}),
      ...(entry.details === undefined ? {} : { details: entry.details }),
    }
  }
  return undefined
}

/** Like `fromPiEntry`, but also surfaces `VEDUTA_MESSAGE_ORIGIN` markers for `applyOriginEntries`. */
function fromPiEntryOrMarker(entry: SessionTreeEntry): RawSessionEntry | undefined {
  if (entry.type === 'custom' && entry.customType === VEDUTA_MESSAGE_ORIGIN) {
    const provenance = parseOriginEntryData(entry.data)
    return provenance ? { kind: 'origin-marker', ...provenance } : undefined
  }
  return fromPiEntry(entry)
}

function assistantModel(message: Record<string, unknown>): ModelRef | undefined {
  const provider = stringValue(message['provider'])
  const modelId = stringValue(message['model'])
  return provider && modelId ? { provider, modelId, tier: 'reasoning' } : undefined
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined
  const provider = stringValue(value['provider'])
  const modelId = stringValue(value['modelId'])
  const tier = value['tier']
  if (!provider || !modelId || (tier !== 'triage' && tier !== 'reasoning')) return undefined
  const connectionId = stringValue(value['connectionId'])
  return connectionId === undefined
    ? { provider, modelId, tier }
    : { provider, modelId, tier, connectionId }
}

function isAssistantError(
  message: AgentMessage,
): message is AgentMessage & { errorMessage?: string } {
  return isRecord(message) && message['role'] === 'assistant' && message['stopReason'] === 'error'
}

/** Provider-reported cost; undefined (unreported) when missing or invalid. */
function piMessageCostUsd(message: unknown): number | undefined {
  if (!isRecord(message)) return undefined
  const usage = message['usage']
  if (!isRecord(usage) || !isRecord(usage['cost'])) return undefined
  const total = usage['cost']['total']
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined
}

/** Provider-reported total token count; undefined (unreported) when missing or invalid. */
export function piMessageTokens(message: unknown): number | undefined {
  if (!isRecord(message)) return undefined
  const usage = message['usage']
  if (!isRecord(usage)) return undefined
  const total = usage['totalTokens']
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : undefined
}

function piMessageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return textFromContent(content)
  return ''
}

function textFromContent(content: unknown[]): string {
  return content
    .flatMap((part) =>
      isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string'
        ? [part['text']]
        : [],
    )
    .join('')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nowIso(): string {
  return new Date().toISOString()
}
