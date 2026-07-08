import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  AgentEventBus,
  MemorySessionStore,
  defineTool,
  modelRefsEqual,
  type AgentEvent,
  type AgentPromptOptions,
  type AgentRunner,
  type ModelRef,
  type SessionStore,
  type ToolDef,
} from './agent-runner.ts'
import { ModelRouter } from './model-routing.ts'

const triageModel: ModelRef = { provider: 'mock', modelId: 'cheap', tier: 'triage' }
const reasoningModel: ModelRef = { provider: 'mock', modelId: 'strong', tier: 'reasoning' }

const rememberTool = defineTool({
  name: 'remember',
  description: 'Stores one value in the session transcript',
  schema: z.object({ value: z.string().min(1) }),
  handler: ({ value }) => ({ content: `remembered ${value}`, details: { value } }),
})

describe('AgentRunner contract', () => {
  it('persists a fake tool call and resumes the same session without runtime-specific imports', async () => {
    const store = new MemorySessionStore()
    const firstEvents: AgentEvent[] = []
    const firstRunner = new ContractAgentRunner(store)
    firstRunner.on((event) => {
      firstEvents.push(event)
    })

    await firstRunner.start('session-health')
    await firstRunner.prompt('remember milk', { model: triageModel, tools: [rememberTool] })

    expect(firstEvents.map((event) => event.type)).toEqual([
      'tool-start',
      'tool-result',
      'text-delta',
      'turn-end',
    ])

    const resumedEvents: AgentEvent[] = []
    const resumedRunner = new ContractAgentRunner(store)
    resumedRunner.on((event) => {
      resumedEvents.push(event)
    })

    await resumedRunner.start('session-health')
    await resumedRunner.prompt('what did I remember?', { model: reasoningModel })

    const finalTurn = findLastEvent(resumedEvents, 'turn-end')
    expect(finalTurn).toMatchObject({
      type: 'turn-end',
      model: reasoningModel,
      text: 'You remembered milk.',
    })

    const branch = await store.load('session-health')
    expect(branch.messages.map((message) => message.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'assistant',
    ])
  })

  it('records model switches between prompts in one session', async () => {
    const store = new MemorySessionStore()
    const runner = new ContractAgentRunner(store)

    await runner.start('session-work')
    await runner.prompt('hello', { model: triageModel })
    await runner.prompt('think harder', { model: reasoningModel })

    const branch = await store.load('session-work')
    expect(branch.model).toEqual(reasoningModel)
    expect(branch.entries.filter((entry) => entry.type === 'model-change')).toHaveLength(2)
  })

  it('branches from a concrete session entry without mutating the source session', async () => {
    const store = new MemorySessionStore()
    const runner = new ContractAgentRunner(store)

    await runner.start('session-home')
    await runner.prompt('first', { model: triageModel })
    const source = await store.load('session-home')
    const branchPoint = source.entries[source.entries.length - 1]?.id
    if (!branchPoint) throw new Error('expected a branch point')
    await runner.prompt('second', { model: triageModel })

    const branched = await store.branch('session-home', {
      fromEntryId: branchPoint,
      newSessionId: 'session-home-branch',
    })

    expect(branched.messages.map((message) => message.content)).toEqual([
      'first',
      'Nothing stored.',
    ])
    expect((await store.load('session-home')).messages.map((message) => message.content)).toContain(
      'second',
    )
  })

  it('continues the conversation on the fallback model without duplicating the user message', async () => {
    const store = new MemorySessionStore()
    const runner = new ContractAgentRunner(store, { failForProviders: new Set(['down']) })
    const router = new ModelRouter({
      config: {
        tiers: {
          reasoning: [
            { provider: 'down', modelId: 'primary' },
            { provider: 'mock', modelId: 'fallback' },
          ],
          triage: [{ provider: 'mock', modelId: 'cheap' }],
        },
        providerKeys: {},
        dailyCapUsd: { triage: 1, reasoning: 5 },
      },
      sleep: async () => {},
    })

    await runner.start('session-failover')
    await router.execute({ purpose: 'chat-turn', origin: 'user' }, (model) =>
      runner.prompt('hello', { model }),
    )

    const branch = await store.load('session-failover')
    expect(branch.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(branch.model).toEqual({ provider: 'mock', modelId: 'fallback', tier: 'reasoning' })
    expect(router.callLog().map((call) => call.outcome)).toEqual(['error', 'ok'])
  })

  it('appends two intentional identical user messages as separate turns', async () => {
    const store = new MemorySessionStore()
    const runner = new ContractAgentRunner(store)

    await runner.start('session-repeat')
    await runner.prompt('hello', { model: reasoningModel })
    await runner.prompt('hello', { model: reasoningModel })

    const branch = await store.load('session-repeat')
    expect(branch.messages.filter((message) => message.role === 'user')).toHaveLength(2)
  })
})

class ContractAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly store: SessionStore
  private readonly failForProviders: Set<string>
  private sessionId: string | undefined = undefined
  private currentModel: ModelRef | undefined = undefined
  private pendingInput: string | undefined = undefined

  constructor(store: SessionStore, options: { failForProviders?: Set<string> } = {}) {
    this.store = store
    this.failForProviders = options.failForProviders ?? new Set()
  }

  async start(sessionId: string): Promise<void> {
    this.sessionId = sessionId
    this.currentModel = (await this.store.load(sessionId)).model
    this.pendingInput = undefined
  }

  async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
    const sessionId = this.requireSessionId()
    const model = options.model ?? this.currentModel
    if (!model) throw new Error('model required')
    if (!modelRefsEqual(model, this.currentModel)) {
      await this.store.append(sessionId, { type: 'model-change', model })
      this.currentModel = model
    }

    // Retry-safe contract: a prompt retried after a failure (model
    // failover) must not append the user message a second time.
    if (this.pendingInput !== input) {
      await this.store.append(sessionId, {
        type: 'message',
        message: { role: 'user', content: input },
      })
      this.pendingInput = input
    }

    if (this.failForProviders.has(model.provider)) {
      throw new Error(`provider ${model.provider} is down`)
    }

    const tool = options.tools?.find((candidate) => candidate.name === 'remember')
    const answer =
      input.startsWith('remember ') && tool
        ? await this.runRememberTool(sessionId, input, tool)
        : await this.answerFromSession(sessionId)

    await this.store.append(sessionId, {
      type: 'message',
      message: { role: 'assistant', content: answer, model },
    })
    this.pendingInput = undefined
    await this.events.emit({ type: 'text-delta', text: answer })
    await this.events.emit({ type: 'turn-end', sessionId, model, text: answer })
  }

  abort(): void {}

  on(handler: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.events.on(handler)
  }

  private async runRememberTool(sessionId: string, input: string, tool: ToolDef): Promise<string> {
    const toolCallId = 'call-remember'
    const value = input.replace(/^remember\s+/, '')
    await this.events.emit({
      type: 'tool-start',
      toolCallId,
      toolName: tool.name,
      input: { value },
    })
    const parsed = tool.schema.parse({ value })
    const result = await tool.handler(parsed, { toolCallId })
    const message = {
      role: 'tool' as const,
      content: result.content,
      toolCallId,
      toolName: tool.name,
      ...(result.details === undefined ? {} : { details: result.details }),
    }
    await this.store.append(sessionId, {
      type: 'message',
      message,
    })
    await this.events.emit({
      type: 'tool-result',
      toolCallId,
      toolName: tool.name,
      content: result.content,
      details: result.details,
      isError: false,
    })
    return `Remembered ${value}.`
  }

  private async answerFromSession(sessionId: string): Promise<string> {
    const remembered = findLastMessage(
      (await this.store.load(sessionId)).messages,
      (message) => message.role === 'tool' && message.toolName === 'remember',
    )
    if (!remembered || !isRememberDetails(remembered.details)) return 'Nothing stored.'
    return `You remembered ${remembered.details.value}.`
  }

  private requireSessionId(): string {
    if (!this.sessionId) throw new Error('start required')
    return this.sessionId
  }
}

function findLastEvent<TType extends AgentEvent['type']>(
  events: AgentEvent[],
  type: TType,
): Extract<AgentEvent, { type: TType }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type) return event as Extract<AgentEvent, { type: TType }>
  }
  return undefined
}

function findLastMessage<TMessage>(
  messages: TMessage[],
  predicate: (message: TMessage) => boolean,
): TMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && predicate(message)) return message
  }
  return undefined
}

function isRememberDetails(value: unknown): value is { value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string'
  )
}
