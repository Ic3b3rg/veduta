import {
  Agent,
  JsonlSessionRepo,
  type AgentEvent as PiEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type JsonlSessionMetadata,
  type SessionTreeEntry,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import {
  AgentEventBus,
  buildSessionBranch,
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
  type SessionMessage,
  type SessionStore,
  type ToolDef,
  type ToolResult,
} from './agent-runner.ts'

type PiInitialState = NonNullable<AgentOptions['initialState']>
type PiModel = NonNullable<PiInitialState['model']>
type PiToolParameters = AgentTool['parameters']

const VEDUTA_MODEL_CHANGE = 'veduta:model-change'

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
}

export class PiAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly sessionStore: SessionStore
  private readonly resolveModel: (model: ModelRef) => PiModel
  private readonly defaultModel: ModelRef | undefined
  private readonly systemPrompt: string | undefined
  private readonly defaultContextPolicy: ContextPolicy
  private readonly toolParameters: Record<string, PiToolParameters>
  private sessionId: string | undefined = undefined
  private currentModel: ModelRef | undefined = undefined
  private agent: Agent | undefined = undefined
  private unsubscribe: (() => void) | undefined = undefined
  private turnError: string | undefined = undefined
  /** Failed turn whose user message is already in that session's store. */
  private failedTurn: { sessionId: string; input: string } | undefined = undefined

  constructor(options: PiAgentRunnerOptions) {
    this.sessionStore = options.sessionStore
    this.resolveModel = options.resolveModel
    this.defaultModel = options.defaultModel
    this.systemPrompt = options.systemPrompt
    this.defaultContextPolicy = options.contextPolicy ?? disabledContextPolicy
    this.toolParameters = options.toolParameters ?? {}
  }

  async start(sessionId: string): Promise<void> {
    this.unsubscribe?.()
    this.sessionId = sessionId
    const branch = await this.sessionStore.load(sessionId)
    this.currentModel = branch.model
    this.turnError = undefined
    this.agent = undefined
    if (this.currentModel)
      this.agent = this.createAgent(branch, this.currentModel, [], this.defaultContextPolicy)
  }

  async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
    const sessionId = this.requireSessionId()
    const model = options.model ?? this.currentModel ?? this.defaultModel
    if (!model)
      throw new Error('AgentRunner.prompt requires a model before issue 010 model routing')

    // Retry-safe contract: skip re-appending the user message only when
    // a failed attempt actually got as far as appending it — failures
    // before the append (tool mapping, agent setup) must not skip it.
    // The marker is scoped to the session and survives until the turn
    // completes successfully (including across a same-session restart).
    const userMessageAppended =
      options.retryOfFailedTurn === true &&
      this.failedTurn?.sessionId === sessionId &&
      this.failedTurn.input === input

    if (!modelRefsEqual(model, this.currentModel)) {
      await this.sessionStore.append(sessionId, { type: 'model-change', model })
      this.currentModel = model
    }

    const tools = this.toPiTools(options.tools ?? [])
    const contextPolicy = options.contextPolicy ?? this.defaultContextPolicy
    if (!this.agent) {
      const branch = await this.sessionStore.load(sessionId)
      this.agent = this.createAgent(branch, model, tools, contextPolicy)
    }

    this.agent.state.model = this.resolveModel(model)
    this.agent.state.tools = tools
    const transformContext = this.toPiContextTransform(contextPolicy)
    if (transformContext) {
      this.agent.transformContext = transformContext
    } else {
      delete this.agent.transformContext
    }

    if (!userMessageAppended) {
      await this.sessionStore.append(sessionId, {
        type: 'message',
        message: { role: 'user', content: input },
      })
      this.failedTurn = { sessionId, input }
    }

    this.turnError = undefined
    try {
      await this.agent.prompt(input)
    } catch (error) {
      // The live pi context already holds this turn's user message; a
      // retry rebuilds the agent from the session store instead.
      this.agent = undefined
      await this.events.emit({ type: 'error', message: errorMessage(error) })
      throw error
    }

    // pi reports provider failures as resolved turns whose assistant
    // message has stopReason "error". The routing contract needs a
    // rejection, with the poisoned agent state discarded for the retry.
    if (this.turnError !== undefined) {
      const message = this.turnError
      this.turnError = undefined
      this.agent = undefined
      throw new Error(message)
    }

    this.failedTurn = undefined
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
  ): Agent {
    const initialState: PiInitialState = {
      model: this.resolveModel(model),
      messages: branch.messages.map((message) => toPiMessage(message, branch.model ?? model)),
      tools,
    }
    if (this.systemPrompt) initialState.systemPrompt = this.systemPrompt

    const transformContext = this.toPiContextTransform(contextPolicy)
    const agentOptions: AgentOptions = {
      sessionId: branch.sessionId,
      initialState,
    }
    if (transformContext) agentOptions.transformContext = transformContext

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
      return toPiAgentTool(tool, parameters)
    })
  }

  private toPiContextTransform(
    policy: ContextPolicy,
  ): ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined {
    if (!policy.enabled) return undefined
    return async (messages, signal) => {
      const sessionId = this.requireSessionId()
      const sessionMessages = messages.flatMap((message) => {
        const mapped = fromPiMessage(message, new Date().toISOString())
        return mapped ? [mapped] : []
      })
      const context = signal ? { sessionId, signal } : { sessionId }
      const transformed = await policy.transform(sessionMessages, context)
      return transformed.map((message) =>
        toPiMessage(message, this.currentModel ?? this.defaultModel),
      )
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
          await this.events.emit({ type: 'error', message: this.turnError })
          return
        }
        await this.persistPiMessage(event.message)
        return
      case 'tool_execution_start':
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
        await this.events.emit({
          type: 'turn-end',
          sessionId,
          model: this.currentModel ?? this.defaultModel!,
          text: piMessageText(event.message),
          ...(costUsd === undefined ? {} : { costUsd }),
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
    await this.sessionStore.append(sessionId, { type: 'message', message: mapped })
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('AgentRunner.start must be called before prompt')
    return this.sessionId
  }
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
    return mapped
  }

  async load(sessionId: string): Promise<SessionBranch> {
    const metadata = await this.findMetadata(sessionId)
    if (!metadata) return { sessionId, entries: [], messages: [] }
    const session = await this.repo.open(metadata)
    const entries = (await session.getEntries()).flatMap((entry) => {
      const mapped = fromPiEntry(entry)
      return mapped ? [mapped] : []
    })
    return buildSessionBranch(sessionId, entries)
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

export function toPiAgentTool(tool: ToolDef, parameters: PiToolParameters): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (toolCallId, params, signal) => {
      const parsed = tool.schema.safeParse(params)
      if (!parsed.success) throw new Error(parsed.error.message)
      const context = signal ? { toolCallId, signal } : { toolCallId }
      const result = await tool.handler(parsed.data, context)
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
  return { provider, modelId, tier }
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
