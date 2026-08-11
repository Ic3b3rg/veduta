import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
} from './codex-app-server-fake.ts'
import { CODEX_TURN_TIMEOUT_MS, streamCodexToolTurn } from './codex-tool-turn.ts'
import { NonRetryableModelError } from './model-routing.ts'
import type { SubscriptionStreamEvent, SubscriptionStreamRequest } from './pi-provider-bridge.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000000'
const ROOT_DIR = '/tmp/veduta-codex-adapter-test'
const CODEX_HOME = join(ROOT_DIR, 'codex', CONNECTION_ID)

function subscriptionRequest(signal?: AbortSignal): SubscriptionStreamRequest {
  return {
    modelId: 'gpt-5-codex',
    prompt: {
      systemPrompt: 'You are Veduta.',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
    },
    ...(signal ? { signal } : {}),
  }
}

const ECHO_TOOL = {
  name: 'echo_value',
  description: 'Echo a value.',
  inputSchema: { type: 'object' },
}

function echoToolRequest(signal?: AbortSignal): SubscriptionStreamRequest {
  const request = subscriptionRequest(signal)
  return { ...request, prompt: { ...request.prompt, tools: [ECHO_TOOL] } }
}

function withEchoToolResult(
  request: SubscriptionStreamRequest,
  options: { toolCallId?: string; toolName?: string; text?: string; isError?: boolean } = {},
): SubscriptionStreamRequest {
  const toolCallId = options.toolCallId ?? 'call-1'
  const toolName = options.toolName ?? 'echo_value'
  return {
    ...request,
    prompt: {
      ...request.prompt,
      messages: [
        ...request.prompt.messages,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId,
              toolName,
              input: { value: 'hello' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId,
          toolName,
          text: options.text ?? 'hello',
          isError: options.isError ?? false,
        },
      ],
    },
  }
}

/** Drains a `stream()` generator, collecting every yielded delta; returns the thrown error (if any) instead of letting it escape, so a refusal test can assert both the collected deltas and the error in one place. */
async function drain(
  generator: AsyncIterable<SubscriptionStreamEvent>,
): Promise<{ deltas: string[]; error: unknown }> {
  const deltas: string[] = []
  try {
    for await (const event of generator) {
      if (event.type === 'text-delta') deltas.push(event.text)
    }
    return { deltas, error: undefined }
  } catch (error) {
    return { deltas, error }
  }
}

async function drainEvents(generator: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of generator) events.push(event)
  return events
}

async function captureEvents(
  generator: AsyncIterable<SubscriptionStreamEvent>,
): Promise<{ events: SubscriptionStreamEvent[]; error: unknown }> {
  const events: SubscriptionStreamEvent[] = []
  try {
    for await (const event of generator) events.push(event)
    return { events, error: undefined }
  } catch (error) {
    return { events, error }
  }
}

describe('stream', () => {
  it('round-trips one dynamic tool result through the same Codex turn', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
      notificationsAfterServerResponse: fixture.continuationNotifications,
    })
    const firstRequest: SubscriptionStreamRequest = {
      modelId: 'gpt-5-codex',
      prompt: {
        systemPrompt: 'You are Veduta.',
        messages: [{ role: 'user', text: 'echo hello' }],
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
      },
    }

    const firstEvents = await drainEvents(streamCodexToolTurn(transport, CODEX_HOME, firstRequest))

    expect(firstEvents).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'echo_value',
        input: { value: 'hello' },
      },
    ])
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        dynamicTools: [
          {
            type: 'function',
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          },
        ],
      },
    })

    const secondEvents = await drainEvents(
      streamCodexToolTurn(transport, CODEX_HOME, {
        ...firstRequest,
        prompt: {
          ...firstRequest.prompt,
          messages: [
            ...firstRequest.prompt.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'echo_value',
                  input: { value: 'hello' },
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              toolName: 'echo_value',
              text: 'hello',
              isError: false,
            },
          ],
        },
      }),
    )

    expect(secondEvents).toEqual([{ type: 'text-delta', text: 'tool result: hello' }])
    expect(transport.serverResponses).toEqual([
      {
        id: 0,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: 'hello' }],
        },
      },
    ])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
  })

  it('accepts two sequential calls with distinct ids in one Codex turn', async () => {
    const first = fakeCodexDynamicToolRoundTrip({
      callId: 'call-1',
      reverseRequestId: 0,
      input: { value: 'one' },
      resultText: 'one',
    })
    const second = fakeCodexDynamicToolRoundTrip({
      callId: 'call-2',
      reverseRequestId: 1,
      input: { value: 'two' },
      resultText: 'two',
      finalText: 'two calls complete',
    })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [first.startNotification],
      serverRequests: [first.serverRequest],
      serverResponseStages: [
        {
          notifications: [first.continuationNotifications[0]!, second.startNotification],
          serverRequests: [second.serverRequest],
        },
        { notifications: second.continuationNotifications },
      ],
    })
    const request: SubscriptionStreamRequest = {
      ...subscriptionRequest(),
      prompt: {
        ...subscriptionRequest().prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }

    const firstEvents = await drainEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
    expect(firstEvents).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'echo_value',
        input: { value: 'one' },
      },
    ])

    const secondRequest: SubscriptionStreamRequest = {
      ...request,
      prompt: {
        ...request.prompt,
        messages: [
          ...request.prompt.messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'echo_value',
                input: { value: 'one' },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            toolName: 'echo_value',
            text: 'one',
            isError: false,
          },
        ],
      },
    }
    const secondEvents = await drainEvents(
      streamCodexToolTurn(transport, CODEX_HOME, secondRequest),
    )
    expect(secondEvents).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'echo_value',
        input: { value: 'two' },
      },
    ])

    const finalEvents = await drainEvents(
      streamCodexToolTurn(transport, CODEX_HOME, {
        ...secondRequest,
        prompt: {
          ...secondRequest.prompt,
          messages: [
            ...secondRequest.prompt.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-2',
                  toolName: 'echo_value',
                  input: { value: 'two' },
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-2',
              toolName: 'echo_value',
              text: 'two',
              isError: false,
            },
          ],
        },
      }),
    )

    expect(finalEvents).toEqual([{ type: 'text-delta', text: 'two calls complete' }])
    expect(transport.serverResponses).toEqual([
      {
        id: 0,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: 'one' }],
        },
      },
      {
        id: 1,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: 'two' }],
        },
      },
    ])
    expect(transport.requests.map((entry) => entry.method)).toEqual(['thread/start', 'turn/start'])
  })

  it('interrupts an unoffered dynamic tool before exposing a call to AgentRunner', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ tool: 'unknown_tool' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
      notificationsAfterServerResponse: fixture.continuationNotifications,
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toEqual([
      'thread/start',
      'turn/start',
      'turn/interrupt',
    ])
  })

  it('interrupts malformed dynamic arguments before exposing a call to AgentRunner', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ input: 'not-an-object' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toEqual([
      'thread/start',
      'turn/start',
      'turn/interrupt',
    ])
  })

  it('interrupts a reverse request missing required protocol fields', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [
        {
          id: 0,
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'call-1',
            namespace: null,
            tool: 'echo_value',
          },
        },
      ],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('fails closed when thread/start omits its required thread id', async () => {
    const transport = createFakeCodexTransport({
      responses: { 'thread/start': { thread: {} } },
    })

    const result = await captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.requests.map((entry) => entry.method)).toEqual(['thread/start'])
  })

  it('interrupts a provider-namespaced dynamic call before exposing it to AgentRunner', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ namespace: 'provider.native' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('interrupts a reverse tool request correlated to another thread', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ requestThreadId: 'other-thread' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const resultPromise = captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
    await vi.waitFor(() => {
      expect(transport.requests.map((entry) => entry.method)).toContain('turn/start')
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    const result = await resultPromise

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it.each([
    ['thread', { startedThreadId: 'other-thread' }],
    ['turn', { startedTurnId: 'other-turn' }],
  ] as const)(
    'interrupts a live dynamic start with an orphaned %s correlation',
    async (_field, fixtureOptions) => {
      const fixture = fakeCodexDynamicToolRoundTrip(fixtureOptions)
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
      })

      const resultPromise = captureEvents(
        streamCodexToolTurn(transport, CODEX_HOME, echoToolRequest()),
      )
      await vi.waitFor(() => {
        expect(transport.requests.map((entry) => entry.method)).toContain('turn/start')
      })
      transport.emit(fixture.startNotification)
      transport.emit({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      })

      const result = await resultPromise
      expect(result.events).toEqual([])
      expect(result.error).toBeInstanceOf(NonRetryableModelError)
      expect(transport.serverResponses).toEqual([])
      expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
    },
  )

  it.each([
    ['turn id', { requestTurnId: 'other-turn' }],
    ['namespace', { requestNamespace: 'provider.native' }],
    ['arguments', { requestInput: { value: 'changed' } }],
  ] as const)(
    'interrupts a reverse request whose %s differs from the announced call',
    async (_field, fixtureOptions) => {
      const fixture = fakeCodexDynamicToolRoundTrip(fixtureOptions)
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
        notifications: [fixture.startNotification],
        serverRequests: [fixture.serverRequest],
      })

      const result = await captureEvents(
        streamCodexToolTurn(transport, CODEX_HOME, echoToolRequest()),
      )

      expect(result.events).toEqual([])
      expect(result.error).toBeInstanceOf(NonRetryableModelError)
      expect(transport.serverResponses).toEqual([])
      expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
    },
  )

  it('ignores a reverse request that is correctly correlated to another active turn', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': (_params: unknown, callIndex: number) =>
          fakeCodexThreadStartResponse(callIndex === 0 ? 'thread-a' : 'thread-b'),
        'turn/start': (params: unknown) => {
          const threadId =
            typeof params === 'object' && params !== null && 'threadId' in params
              ? params.threadId
              : undefined
          if (typeof threadId !== 'string') throw new Error('expected a threadId')
          return fakeCodexTurnStartResponse(threadId === 'thread-a' ? 'turn-a' : 'turn-b')
        },
        'turn/interrupt': {},
      },
    })
    const controllerA = new AbortController()
    const requestFor = (signal: AbortSignal): SubscriptionStreamRequest => ({
      ...subscriptionRequest(signal),
      prompt: {
        ...subscriptionRequest(signal).prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    })
    const firstResult = captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, requestFor(controllerA.signal)),
    )
    const secondResult = captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, requestFor(new AbortController().signal)),
    )
    await vi.waitFor(() => {
      expect(transport.requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    })
    const call = fakeCodexDynamicToolRoundTrip({
      threadId: 'thread-a',
      turnId: 'turn-a',
      callId: 'call-a',
    })
    transport.emit(call.startNotification)
    transport.emitServerRequest(call.serverRequest)

    expect(await firstResult).toMatchObject({
      events: [{ type: 'tool-call', toolCallId: 'call-a' }],
      error: undefined,
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-b', turn: { id: 'turn-b' } },
    })
    expect(await secondResult).toEqual({ events: [], error: undefined })

    controllerA.abort()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  })

  it('interrupts when the reverse request call id differs from the announced dynamic item', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ requestCallId: 'different-call' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('interrupts when a reverse request changes the announced tool name', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ requestTool: 'second_tool' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request = subscriptionRequest()
    request.prompt.tools = [
      {
        name: 'echo_value',
        description: 'Echo a value.',
        inputSchema: { type: 'object' },
      },
      {
        name: 'second_tool',
        description: 'Another offered tool.',
        inputSchema: { type: 'object' },
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('interrupts a duplicate semantic call id before exposing it a second time', async () => {
    const first = fakeCodexDynamicToolRoundTrip()
    const duplicate = fakeCodexDynamicToolRoundTrip({ reverseRequestId: 1 })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [first.startNotification],
      serverRequests: [first.serverRequest],
      serverResponseStages: [
        {
          notifications: [first.continuationNotifications[0]!, duplicate.startNotification],
          serverRequests: [duplicate.serverRequest],
        },
      ],
    })
    const request: SubscriptionStreamRequest = {
      ...subscriptionRequest(),
      prompt: {
        ...subscriptionRequest().prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }
    const firstResult = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
    expect(firstResult.events).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'echo_value',
        input: { value: 'hello' },
      },
    ])

    const secondResult = await captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, {
        ...request,
        prompt: {
          ...request.prompt,
          messages: [
            ...request.prompt.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'echo_value',
                  input: { value: 'hello' },
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              toolName: 'echo_value',
              text: 'hello',
              isError: false,
            },
          ],
        },
      }),
    )

    expect(secondResult.events).toEqual([])
    expect(secondResult.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toHaveLength(1)
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('interrupts when a tool result changes the accepted call name', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
      notificationsAfterServerResponse: fixture.continuationNotifications,
    })
    const request: SubscriptionStreamRequest = {
      ...subscriptionRequest(),
      prompt: {
        ...subscriptionRequest().prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }
    await drainEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    const result = await captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, {
        ...request,
        prompt: {
          ...request.prompt,
          messages: [
            ...request.prompt.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'echo_value',
                  input: { value: 'hello' },
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              toolName: 'different_tool',
              text: 'hello',
              isError: false,
            },
          ],
        },
      }),
    )

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it('interrupts a dynamic completion correlated to an unaccepted call id', async () => {
    const fixture = fakeCodexDynamicToolRoundTrip({ completedCallId: 'other-call' })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
      notificationsAfterServerResponse: fixture.continuationNotifications,
    })
    const request: SubscriptionStreamRequest = {
      ...subscriptionRequest(),
      prompt: {
        ...subscriptionRequest().prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }
    await drainEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
    request.prompt.messages = [
      ...request.prompt.messages,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'echo_value',
            input: { value: 'hello' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'echo_value',
        text: 'hello',
        isError: false,
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toHaveLength(1)
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
  })

  it.each([
    ['thread id', { completedThreadId: 'other-thread' }],
    ['turn id', { completedTurnId: 'other-turn' }],
    ['namespace', { completedNamespace: 'provider.native' }],
    ['tool name', { completedTool: 'other_tool' }],
    ['arguments', { completedInput: { value: 'changed' } }],
    ['status', { completedStatus: 'failed' as const }],
    ['success', { completedSuccess: false }],
    ['content', { completedContentItems: [{ type: 'inputText', text: 'changed' }] }],
    ['required status', { omitCompletedField: 'status' as const }],
    ['required success', { omitCompletedField: 'success' as const }],
    ['required content', { omitCompletedField: 'contentItems' as const }],
  ] as const)(
    'interrupts when a dynamic completion changes its %s',
    async (_field, fixtureOptions) => {
      const fixture = fakeCodexDynamicToolRoundTrip(fixtureOptions)
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
        notifications: [fixture.startNotification],
        serverRequests: [fixture.serverRequest],
        notificationsAfterServerResponse: fixture.continuationNotifications,
      })
      const request = echoToolRequest()
      await drainEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

      const result = await captureEvents(
        streamCodexToolTurn(transport, CODEX_HOME, withEchoToolResult(request)),
      )

      expect(result.events).toEqual([])
      expect(result.error).toBeInstanceOf(NonRetryableModelError)
      expect(transport.serverResponses).toHaveLength(1)
      expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')
    },
  )

  it('refuses an orphaned tool result without starting a replacement Codex turn', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })
    const request = subscriptionRequest()
    request.prompt.messages = [
      ...request.prompt.messages,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'echo_value',
            input: { value: 'hello' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'echo_value',
        text: 'late result',
        isError: false,
      },
    ]

    const result = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

    expect(result.events).toEqual([])
    expect(result.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.requests).toEqual([])
    expect(transport.serverResponses).toEqual([])
  })

  it('interrupts while an accepted call is in flight and refuses its late result', async () => {
    const controller = new AbortController()
    const fixture = fakeCodexDynamicToolRoundTrip()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
        'turn/interrupt': {},
      },
      notifications: [fixture.startNotification],
      serverRequests: [fixture.serverRequest],
    })
    const request: SubscriptionStreamRequest = {
      ...subscriptionRequest(controller.signal),
      prompt: {
        ...subscriptionRequest(controller.signal).prompt,
        tools: [
          {
            name: 'echo_value',
            description: 'Echo a value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }

    const accepted = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
    expect(accepted.events).toHaveLength(1)

    controller.abort()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')

    const lateResult = await captureEvents(
      streamCodexToolTurn(transport, CODEX_HOME, {
        ...request,
        prompt: {
          ...request.prompt,
          messages: [
            ...request.prompt.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'echo_value',
                  input: { value: 'hello' },
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'call-1',
              toolName: 'echo_value',
              text: 'late',
              isError: false,
            },
          ],
        },
      }),
    )

    expect(lateResult.events).toEqual([])
    expect(lateResult.error).toBeInstanceOf(NonRetryableModelError)
    expect(transport.serverResponses).toEqual([])
    expect(transport.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
  })

  it('times out while an accepted call is in flight and refuses its late result', async () => {
    vi.useFakeTimers()
    try {
      const fixture = fakeCodexDynamicToolRoundTrip()
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
        notifications: [fixture.startNotification],
        serverRequests: [fixture.serverRequest],
      })
      const request: SubscriptionStreamRequest = {
        ...subscriptionRequest(),
        prompt: {
          ...subscriptionRequest().prompt,
          tools: [
            {
              name: 'echo_value',
              description: 'Echo a value.',
              inputSchema: { type: 'object' },
            },
          ],
        },
      }

      const accepted = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))
      expect(accepted.events).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(CODEX_TURN_TIMEOUT_MS)
      expect(transport.requests.map((entry) => entry.method)).toContain('turn/interrupt')

      request.prompt.messages = [
        ...request.prompt.messages,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'echo_value',
              input: { value: 'hello' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          toolName: 'echo_value',
          text: 'late',
          isError: false,
        },
      ]
      const lateResult = await captureEvents(streamCodexToolTurn(transport, CODEX_HOME, request))

      expect(lateResult.events).toEqual([])
      expect(lateResult.error).toBeInstanceOf(NonRetryableModelError)
      expect(transport.serverResponses).toEqual([])
      expect(transport.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('streams observed agent-message deltas without repeating the completed text', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { thread: { id: 'thread-1' } },
        'turn/start': { turn: { id: 'turn-1' } },
      },
      notifications: [
        {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: 1,
            item: { id: 'item-1', type: 'agentMessage', text: '' },
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'hel',
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: 'lo',
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 2,
            item: { id: 'item-1', type: 'agentMessage', text: 'hello' },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['hel', 'lo'])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
    expect(transport.requests[0]?.params).toMatchObject({ approvalPolicy: 'never' })
    expect(transport.requests.some((request) => request.method === 'turn/interrupt')).toBe(false)
  })

  it('ignores the observed user-message echo and keeps the completed text fallback', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { thread: { id: 'thread-1' } },
        'turn/start': { turn: { id: 'turn-1' } },
        'turn/interrupt': {},
      },
      notifications: [
        {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: 1,
            item: { id: 'user-1', type: 'userMessage', content: [] },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 2,
            item: { id: 'user-1', type: 'userMessage', content: [] },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 3,
            item: { id: 'agent-1', type: 'agentMessage', text: 'pong' },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['pong'])
    expect(transport.requests.some((request) => request.method === 'turn/interrupt')).toBe(false)
  })

  it('drops a reasoning item and forwards only text', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 1,
            item: { id: 'reasoning-1', type: 'reasoning', text: 'let me think' },
          },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 2,
            item: { id: 'agent-1', type: 'agentMessage', text: 'the answer' },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['the answer'])
  })

  it.each(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'futureNativeTool'])(
    'interrupts and refuses a provider-native %s item',
    async (itemType) => {
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': { thread: { id: 'thread-1' } },
          'turn/start': { turn: { id: 'turn-1' } },
          'turn/interrupt': {},
        },
        notifications: [
          {
            method: 'item/started',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              startedAtMs: 1,
              item: { id: 'item-1', type: itemType, command: 'must not run' },
            },
          },
          {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
          },
        ],
      })

      const { deltas, error } = await drain(
        streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
      )

      expect(deltas).toEqual([])
      expect(error).toBeInstanceOf(NonRetryableModelError)
      expect(error).toMatchObject({ message: expect.stringContaining('outside Veduta') })
      expect(transport.requests.map((request) => request.method)).toEqual([
        'thread/start',
        'turn/start',
        'turn/interrupt',
      ])
      expect(
        transport.requests.find((request) => request.method === 'turn/interrupt')?.params,
      ).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    },
  )

  it('does not send an invalid turn/interrupt before a turn exists', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { thread: { id: 'thread-1' } },
      },
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest(controller.signal)),
    )

    expect(deltas).toEqual([])
    expect(error).toMatchObject({ code: 'unsupported' })
    // `turn/start` is never reached, so the app-server has no turn id an
    // interruption request could validly name.
    expect(transport.requests.map((request) => request.method)).toEqual(['thread/start'])
  })

  it('uses the capability-compatible 0.146.1 thread/start and turn/start params', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { thread: { id: 'thread-1' } },
        'turn/start': (params: unknown) => {
          expect(params).toMatchObject({ threadId: 'thread-1' })
          return { turn: { id: 'turn-1' } }
        },
      },
      notifications: [
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    await drain(streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()))

    expect(transport.requests[0]).toEqual({
      method: 'thread/start',
      params: {
        model: 'gpt-5-codex',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: { web_search: 'disabled', disabled_tools: true },
        dynamicTools: [],
        cwd: join(ROOT_DIR, 'codex', CONNECTION_ID),
      },
    })
    expect(transport.requests[1]).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'You are Veduta.\n\n---\n\nUser:\nhi' }],
      },
    })
  })

  it('ignores item notifications for another thread', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'some-other-thread',
            turnId: 'some-other-turn',
            itemId: 'other-item',
            delta: 'nope',
          },
        },
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'agent-1',
            delta: 'yes',
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'some-other-thread', turn: { id: 'some-other-turn' } },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['yes'])
  })

  it('ignores retained dynamic history from a completed earlier turn', async () => {
    const historical = fakeCodexDynamicToolRoundTrip({
      threadId: 'old-thread',
      turnId: 'old-turn',
      callId: 'old-call',
    })
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [
        historical.startNotification,
        historical.continuationNotifications[0]!,
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'agent-1',
            delta: 'current',
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['current'])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
  })

  it("a device-code poll never consumes a live turn's items", async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': fakeCodexTurnStartResponse(),
      },
      notifications: [
        {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: 1,
            item: { id: 'agent-1', type: 'agentMessage', text: 'hello' },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
      ],
    })

    // A concurrent device-code poll on the same pooled transport reads via
    // `recentNotifications()` — the way `refresh()`'s login-completed check
    // does — before the turn's own subscription ever gets a chance to run.
    // It must never drain what that subscription still needs.
    transport.recentNotifications()

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['hello'])
  })

  it('a failed turn/start releases the notification subscription (the transport returns to idle)', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': fakeCodexThreadStartResponse(),
        'turn/start': new Error('the app-server rejected turn/start'),
      },
    })

    const { deltas, error } = await drain(
      streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()),
    )

    expect(deltas).toEqual([])
    expect(error).toBeDefined()
    // The subscription acquired before `turn/start` must still be released
    // on this failure path — otherwise the transport never reports idle
    // again, and a pooled transport with a leaked subscriber is never
    // reused cleanly.
    expect(transport.idle()).toBe(true)
  })

  it('an abort during a silent turn interrupts immediately', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
        // No notification ever arrives — a silent turn: `subscription.next()`
        // would otherwise hang until this connection's own turn bound.
      })

      const drainPromise = drain(
        streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest(controller.signal)),
      )

      await vi.advanceTimersByTimeAsync(0) // let thread/start + turn/start settle
      controller.abort()
      // No further time advance: the abort must be noticed as soon as it
      // fires — raced directly against the notification wait — not only
      // once a further frame arrives or the `CODEX_TURN_TIMEOUT_MS` bound
      // does.
      const { deltas, error } = await drainPromise

      expect(deltas).toEqual([])
      expect(error).toMatchObject({ code: 'unsupported' })
      expect(transport.requests.map((request) => request.method)).toEqual([
        'thread/start',
        'turn/start',
        'turn/interrupt',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a turn that exceeds the turn bound', async () => {
    vi.useFakeTimers()
    try {
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': fakeCodexThreadStartResponse(),
          'turn/start': fakeCodexTurnStartResponse(),
          'turn/interrupt': {},
        },
        // No `turn/completed` ever arrives — the turn bound is what ends this.
      })

      const drainPromise = drain(streamCodexToolTurn(transport, CODEX_HOME, subscriptionRequest()))
      await vi.advanceTimersByTimeAsync(CODEX_TURN_TIMEOUT_MS)
      const { deltas, error } = await drainPromise

      expect(deltas).toEqual([])
      expect(error).toMatchObject({ code: 'unreachable' })
      expect(transport.requests.some((request) => request.method === 'turn/interrupt')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
