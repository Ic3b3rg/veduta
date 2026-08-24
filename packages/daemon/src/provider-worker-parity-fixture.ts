import type { Surface } from '@veduta/protocol'
import type { AgentEvent } from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { createFakeProvider, fakeText } from './fake-provider.ts'
import type { PiChatContext, ProviderBridge } from './pi-provider-bridge.ts'
import {
  modelForConnectionMethod,
  parityTempDir,
  runProviderParityTurn,
  scriptedByokProvider,
  subscriptionProvider,
  type ModelConnectionMethod,
  type ScriptedToolCall,
} from './provider-parity-model-fixture.ts'
import {
  consistentProviderDefinitions,
  type ProviderToolDefinition,
} from './provider-parity-observation.ts'
import {
  normalizeAgentEvents,
  normalizeSessionEntries,
  normalizeStableValue,
} from './provider-parity-test-support.ts'
import type { ModelRouter } from './model-routing.ts'
import {
  buildWorkerParityHarness,
  createWorkerParityPool,
  isWorkerToolMessage,
  observeWorkerTool,
  requireWorkerSurface,
  requireWorkerTransport,
  stableWorkerToolResult,
  workerDynamicToolNames,
  workerEventsSinceStart,
  workerHandlerCounts,
  workerRecordValue,
  workerStringValue,
  workerThreadPurpose,
  WORKER_PARITY_BRIEFING,
  WORKER_PARITY_CHAT_FINAL_TEXT,
  WORKER_PARITY_CHAT_SESSION_ID,
  WORKER_PARITY_CONNECTION_ID,
  WORKER_PARITY_ID,
  WORKER_PARITY_NOW,
  WORKER_PARITY_REPORT,
  WORKER_PARITY_REVIEW_TEXT,
  WORKER_PARITY_SPACE_ID,
  type StableWorkerSpaceEvent,
  type WorkerParityToolResult,
  type WorkerProviderCallPurpose,
} from './provider-worker-parity-support.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { workerSurfaceId } from './worker-surface.ts'
import type { WorkerPool } from './worker.ts'

interface ProviderObservation {
  definitions: Record<WorkerProviderCallPurpose, ProviderToolDefinition[][]>
  contexts: Record<WorkerProviderCallPurpose, PiChatContext[]>
}

export interface WorkerParityOutcome {
  definitions: Record<WorkerProviderCallPurpose, ProviderToolDefinition[]>
  chatEvents: unknown[]
  workerEvents: unknown[]
  chatSessionEntries: unknown[]
  workerSessionEntries: unknown[]
  chatToolResult: WorkerParityToolResult
  workerToolResults: WorkerParityToolResult[]
  activeSurface: Surface
  terminalSurface: Surface
  eventLog: StableWorkerSpaceEvent[]
  returnedBeforeDelivery: boolean
  execution: {
    spawnCalls: number
    distinctSpawnCallIds: number
    maxSpawnCallsPerId: number
    workerToolCalls: number
    distinctWorkerToolCallIds: number
    maxWorkerToolCallsPerId: number
  }
  reviewContext: {
    messageCount: number
    messageRoles: string[]
    tools: string[]
  }
  routedCalls: Array<{
    purpose: string
    origin: string
    workerId?: string
    outcome: string
  }>
  usage: ReturnType<ModelRouter['usage']>
}

interface WorkerParityRun {
  outcome: WorkerParityOutcome
  toolResultTexts: [chat: string, worker: string]
  connectionIds?: string[]
  transport?: WorkerSubscriptionObservation
}

interface WorkerParityPair {
  byok: Pick<WorkerParityRun, 'outcome' | 'toolResultTexts'>
  subscription: WorkerParityRun & {
    connectionIds: string[]
    transport: WorkerSubscriptionObservation
  }
}

export interface WorkerSubscriptionObservation {
  threadStarts: Array<{
    purpose: WorkerProviderCallPurpose
    dynamicTools: string[]
    approvalPolicy: string
    sandbox: string
    webSearch: string
    nativeToolsDisabled: boolean
  }>
}

export async function runWorkerParityPair(): Promise<WorkerParityPair> {
  const byok = await runWorkerParityScenario('byok')
  const subscription = await runWorkerParityScenario('chatgpt-subscription', byok.toolResultTexts)
  if (!subscription.connectionIds || !subscription.transport) {
    throw new Error('subscription Worker scenario produced no transport observations')
  }
  return {
    byok: { outcome: byok.outcome, toolResultTexts: byok.toolResultTexts },
    subscription: {
      ...subscription,
      connectionIds: subscription.connectionIds,
      transport: subscription.transport,
    },
  }
}

async function runWorkerParityScenario(
  method: ModelConnectionMethod,
  expectedResultTexts: string[] = [],
): Promise<WorkerParityRun> {
  const harness = buildWorkerParityHarness(method)
  const providerObservation = emptyProviderObservation()
  const workerEvents: AgentEvent[] = []
  let transport: FakeCodexTransport | undefined
  let pool: WorkerPool | undefined

  try {
    const provider = observeProvider(
      method === 'byok'
        ? byokWorkerProvider()
        : subscriptionProvider({
            connectionId: WORKER_PARITY_CONNECTION_ID,
            rootDir: parityTempDir(harness.directories, 'veduta-provider-worker-codex-'),
            now: WORKER_PARITY_NOW,
            transport: (transport = workerSubscriptionTransport(expectedResultTexts)),
          }),
      providerObservation,
    )
    pool = createWorkerParityPool({
      harness,
      provider,
      workerId: WORKER_PARITY_ID,
      onAgentEvent: (event) => workerEvents.push(event),
    })

    const spawnTool = observeWorkerTool(createSpawnWorkerTool(pool), harness.spawnObservations)
    const chatEvents = await harness.router.execute(
      { purpose: 'chat-turn', origin: 'user', spaceId: WORKER_PARITY_SPACE_ID },
      (model) =>
        runProviderParityTurn({
          provider,
          sessionStore: harness.sessionStore,
          sessionId: WORKER_PARITY_CHAT_SESSION_ID,
          input: 'Start the bounded high-risk Worker investigation.',
          model,
          tools: [spawnTool],
          promptOptions: {
            origin: 'trusted:user',
            spaceId: WORKER_PARITY_SPACE_ID,
            trigger: { kind: 'chat', summary: 'start the Worker investigation' },
          },
        }),
    )

    await harness.workerGate.waitUntilEntered
    const activeSurface = requireWorkerSurface(harness.store, workerSurfaceId(WORKER_PARITY_ID))
    const returnedBeforeDelivery =
      chatEvents.some((event) => event.type === 'turn-end') &&
      harness.store
        .eventLog(WORKER_PARITY_SPACE_ID)
        .every((event) => event.type !== 'worker.delivered') &&
      activeSurface.state['settled'] === false

    harness.workerGate.release()
    await pool.whenSettled(WORKER_PARITY_ID)

    const chatSession = await harness.sessionStore.load(WORKER_PARITY_CHAT_SESSION_ID)
    const workerSession = await harness.sessionStore.load(`worker-${WORKER_PARITY_ID}`)
    const chatToolMessages = chatSession.messages.filter(isWorkerToolMessage)
    const workerToolMessages = workerSession.messages.filter(isWorkerToolMessage)
    const chatToolResult = chatToolMessages.find((message) => message.toolName === 'spawn_worker')
    if (!chatToolResult) throw new Error('Worker parity chat produced no spawn_worker result')
    if (workerToolMessages.length !== 1) {
      throw new Error(`expected one Worker tool result, received ${workerToolMessages.length}`)
    }

    const reviewContexts = providerObservation.contexts.review
    const reviewContext = reviewContexts[0]
    if (!reviewContext || reviewContexts.length !== 1) {
      throw new Error('high-risk Worker parity scenario needs exactly one fresh review call')
    }
    const spawnCounts = workerHandlerCounts(harness.spawnObservations)
    const workerToolCounts = workerHandlerCounts(harness.workerToolObservations)

    return {
      outcome: {
        definitions: {
          chat: consistentProviderDefinitions(providerObservation.definitions.chat),
          worker: consistentProviderDefinitions(providerObservation.definitions.worker),
          review: consistentProviderDefinitions(providerObservation.definitions.review),
        },
        chatEvents: normalizeAgentEvents(chatEvents, { includeTurnOrigins: true }),
        workerEvents: normalizeAgentEvents(workerEvents, { includeTurnOrigins: true }),
        chatSessionEntries: normalizeSessionEntries(chatSession.entries),
        workerSessionEntries: normalizeSessionEntries(workerSession.entries),
        chatToolResult: stableWorkerToolResult(chatToolResult),
        workerToolResults: workerToolMessages.map(stableWorkerToolResult),
        activeSurface,
        terminalSurface: requireWorkerSurface(harness.store, workerSurfaceId(WORKER_PARITY_ID)),
        eventLog: workerEventsSinceStart(harness),
        returnedBeforeDelivery,
        execution: {
          spawnCalls: spawnCounts.calls,
          distinctSpawnCallIds: spawnCounts.distinctCallIds,
          maxSpawnCallsPerId: spawnCounts.maxCallsPerId,
          workerToolCalls: workerToolCounts.calls,
          distinctWorkerToolCallIds: workerToolCounts.distinctCallIds,
          maxWorkerToolCallsPerId: workerToolCounts.maxCallsPerId,
        },
        reviewContext: {
          messageCount: reviewContext.messages.length,
          messageRoles: reviewContext.messages.map((message) => message.role),
          tools: (reviewContext.tools ?? []).map((tool) => tool.name),
        },
        routedCalls: harness.router.callLog().map((call) => ({
          purpose: call.purpose,
          origin: call.origin,
          ...(call.workerId === undefined ? {} : { workerId: call.workerId }),
          outcome: call.outcome,
        })),
        usage: harness.router.usage(),
      },
      toolResultTexts: [chatToolResult.content, workerToolMessages[0]!.content],
      ...(method === 'chatgpt-subscription'
        ? {
            connectionIds: harness.router
              .callLog()
              .map((call) => call.model.connectionId)
              .filter((connectionId): connectionId is string => connectionId !== undefined),
            transport: observeWorkerSubscriptionTransport(requireWorkerTransport(transport)),
          }
        : {}),
    }
  } finally {
    harness.workerGate.release()
    pool?.dispose()
    transport?.close()
    harness.dispose()
  }
}

function byokWorkerProvider(): ProviderBridge {
  const chatCalls: ScriptedToolCall[] = [
    { toolName: 'spawn_worker', input: WORKER_PARITY_BRIEFING, resultText: '' },
  ]
  const workerCalls: ScriptedToolCall[] = [
    { toolName: 'read_recent', input: { limit: 20 }, resultText: '' },
  ]
  const chat = scriptedByokProvider(chatCalls, WORKER_PARITY_CHAT_FINAL_TEXT)
  const worker = scriptedByokProvider(workerCalls, JSON.stringify(WORKER_PARITY_REPORT))
  const review = createFakeProvider()
  review.setResponses([{ message: fakeText(WORKER_PARITY_REVIEW_TEXT) }])
  const modelRef = modelForConnectionMethod('byok', WORKER_PARITY_CONNECTION_ID)

  return {
    resolveModel: chat.resolveModel,
    getApiKey: chat.getApiKey,
    streamFn(_model, context, options) {
      const target =
        providerPurpose(context) === 'chat'
          ? chat
          : providerPurpose(context) === 'worker'
            ? worker
            : review
      return target.streamFn(target.resolveModel(modelRef), context, options)
    },
  }
}

function workerSubscriptionTransport(resultTexts: string[]): FakeCodexTransport {
  const chatResultText = resultTexts[0]
  const workerResultText = resultTexts[1]
  if (resultTexts.length !== 2 || chatResultText === undefined || workerResultText === undefined) {
    throw new Error('subscription Worker fixture needs the observed chat and Worker tool results')
  }
  const chatRoundTrip = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-worker-chat',
    turnId: 'turn-worker-chat',
    callId: 'call-spawn-worker',
    reverseRequestId: 0,
    tool: 'spawn_worker',
    input: WORKER_PARITY_BRIEFING,
    resultText: chatResultText,
    finalText: WORKER_PARITY_CHAT_FINAL_TEXT,
  })
  const workerRoundTrip = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-worker-run',
    turnId: 'turn-worker-run',
    callId: 'call-read-recent',
    reverseRequestId: 1,
    tool: 'read_recent',
    input: { limit: 20 },
    resultText: workerResultText,
    finalText: JSON.stringify(WORKER_PARITY_REPORT),
  })
  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': (params: unknown) =>
        fakeCodexThreadStartResponse(threadIdForPurpose(workerThreadPurpose(params))),
      'turn/start': (params: unknown) => {
        const values = workerRecordValue(params, 'turn/start params')
        const threadId = workerStringValue(values['threadId'], 'turn/start threadId')
        if (threadId === 'thread-worker-chat') {
          transport.emit(chatRoundTrip.startNotification)
          transport.emitServerRequest(chatRoundTrip.serverRequest)
          return fakeCodexTurnStartResponse('turn-worker-chat')
        }
        if (threadId === 'thread-worker-run') {
          transport.emit(workerRoundTrip.startNotification)
          transport.emitServerRequest(workerRoundTrip.serverRequest)
          return fakeCodexTurnStartResponse('turn-worker-run')
        }
        if (threadId === 'thread-worker-review') {
          transport.emit({
            method: 'item/agentMessage/delta',
            params: {
              threadId,
              turnId: 'turn-worker-review',
              itemId: 'review-message',
              delta: WORKER_PARITY_REVIEW_TEXT,
            },
          })
          transport.emit({
            method: 'turn/completed',
            params: {
              threadId,
              turn: { id: 'turn-worker-review', status: 'completed' },
            },
          })
          return fakeCodexTurnStartResponse('turn-worker-review')
        }
        throw new Error(`unexpected Worker parity thread "${threadId}"`)
      },
    },
    serverResponseStages: [
      { notifications: chatRoundTrip.continuationNotifications },
      { notifications: workerRoundTrip.continuationNotifications },
    ],
  })
  return transport
}

function observeProvider(
  provider: ProviderBridge,
  observation: ProviderObservation,
): ProviderBridge {
  return {
    ...provider,
    streamFn(model, context, options) {
      const purpose = providerPurpose(context)
      observation.contexts[purpose].push(context)
      observation.definitions[purpose].push(
        (context.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: normalizeStableValue(tool.parameters),
        })),
      )
      return provider.streamFn(model, context, options)
    },
  }
}

function emptyProviderObservation(): ProviderObservation {
  return {
    definitions: { chat: [], worker: [], review: [] },
    contexts: { chat: [], worker: [], review: [] },
  }
}

function providerPurpose(context: PiChatContext): WorkerProviderCallPurpose {
  const names = (context.tools ?? []).map((tool) => tool.name)
  if (names.includes('spawn_worker')) return 'chat'
  if (names.includes('read_recent')) return 'worker'
  if (names.length === 0) return 'review'
  throw new Error(`unexpected Worker parity provider tools: ${names.join(', ')}`)
}

function observeWorkerSubscriptionTransport(
  transport: FakeCodexTransport,
): WorkerSubscriptionObservation {
  return {
    threadStarts: transport.requests
      .filter((request) => request.method === 'thread/start')
      .map((request) => {
        const params = workerRecordValue(request.params, 'thread/start params')
        const config = workerRecordValue(params['config'], 'thread/start config')
        return {
          purpose: workerThreadPurpose(params),
          dynamicTools: workerDynamicToolNames(params),
          approvalPolicy: workerStringValue(params['approvalPolicy'], 'approval policy'),
          sandbox: workerStringValue(params['sandbox'], 'sandbox'),
          webSearch: workerStringValue(config['web_search'], 'web-search policy'),
          nativeToolsDisabled: config['disabled_tools'] === true,
        }
      }),
  }
}

function threadIdForPurpose(purpose: WorkerProviderCallPurpose): string {
  if (purpose === 'chat') return 'thread-worker-chat'
  if (purpose === 'worker') return 'thread-worker-run'
  return 'thread-worker-review'
}
