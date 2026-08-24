import type { Surface } from '@veduta/protocol'
import type { ToolDef } from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import {
  parityTempDir,
  runProviderParityTurn,
  subscriptionProvider,
} from './provider-parity-model-fixture.ts'
import { observeSubscriptionTransport } from './provider-parity-observation.ts'
import { normalizeSessionEntries } from './provider-parity-test-support.ts'
import {
  buildWorkerParityHarness,
  createWorkerParityPool,
  observeWorkerTool,
  requireWorkerSurface,
  workerEventsSinceStart,
  workerRecordValue,
  workerStringValue,
  workerThreadPurpose,
  WORKER_PARITY_BRIEFING,
  WORKER_PARITY_CHAT_FINAL_TEXT,
  WORKER_PARITY_CONNECTION_ID,
  WORKER_PARITY_NOW,
  WORKER_PARITY_SOURCE_NOTE,
  WORKER_PARITY_SPACE_ID,
  type StableWorkerSpaceEvent,
} from './provider-worker-parity-support.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import type { WorkerBriefing } from './worker-briefing.ts'
import { workerSurfaceId } from './worker-surface.ts'
import type { WorkerPool } from './worker.ts'

const ITERATION_LIMIT = 5

export interface WorkerIterationBudgetOutcome {
  spawnCalls: number
  workerToolCalls: number
  interruptCalls: number
  dynamicToolSuccess: boolean[]
  connectionIds: string[]
  terminalSurface: Surface
  chatSessionEntries: unknown[]
  workerSessionEntries: unknown[]
  workerEvents: StableWorkerSpaceEvent[]
}

export async function runSubscriptionWorkerIterationBudgetScenario(): Promise<WorkerIterationBudgetOutcome> {
  const harness = buildWorkerParityHarness('chatgpt-subscription')
  const workerId = 'wrk-budget'
  const budgetBriefing: WorkerBriefing = {
    ...WORKER_PARITY_BRIEFING,
    maxIterations: ITERATION_LIMIT,
    highRisk: false,
  }
  harness.workerTools = harness.workerTools.map(stabilizeReadRecentResult)
  const spawnResult =
    `spawned worker ${workerId}, researching: ` + 'Investigate the Worker parity source note'
  const chatRoundTrip = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-worker-budget-chat',
    turnId: 'turn-worker-budget-chat',
    callId: 'call-worker-budget-spawn',
    reverseRequestId: 0,
    tool: 'spawn_worker',
    input: budgetBriefing,
    resultText: spawnResult,
    finalText: WORKER_PARITY_CHAT_FINAL_TEXT,
  })
  const workerRoundTrips = Array.from({ length: ITERATION_LIMIT }, (_, index) =>
    fakeCodexDynamicToolRoundTrip({
      threadId: 'thread-worker-budget-run',
      turnId: 'turn-worker-budget-run',
      callId: `call-worker-budget-read-${index + 1}`,
      reverseRequestId: index + 1,
      tool: 'read_recent',
      input: { limit: 20 },
      resultText: WORKER_PARITY_SOURCE_NOTE,
    }),
  )
  const transport = budgetTransport(chatRoundTrip, workerRoundTrips)
  const provider = subscriptionProvider({
    connectionId: WORKER_PARITY_CONNECTION_ID,
    rootDir: parityTempDir(harness.directories, 'veduta-provider-worker-budget-codex-'),
    now: WORKER_PARITY_NOW,
    transport,
  })
  let pool: WorkerPool | undefined

  try {
    pool = createWorkerParityPool({ harness, provider, workerId })
    const spawnTool = observeWorkerTool(createSpawnWorkerTool(pool), harness.spawnObservations)
    await harness.router.execute(
      { purpose: 'chat-turn', origin: 'user', spaceId: WORKER_PARITY_SPACE_ID },
      (model) =>
        runProviderParityTurn({
          provider,
          sessionStore: harness.sessionStore,
          sessionId: 'provider-worker-budget-chat',
          input: 'Start a Worker whose bounded investigation will hit its iteration budget.',
          model,
          tools: [spawnTool],
          promptOptions: { origin: 'trusted:user', spaceId: WORKER_PARITY_SPACE_ID },
        }),
    )
    harness.workerGate.release()
    await pool.whenSettled(workerId)

    const chatSession = await harness.sessionStore.load('provider-worker-budget-chat')
    const workerSession = await harness.sessionStore.load(`worker-${workerId}`)
    return {
      spawnCalls: harness.spawnObservations.length,
      workerToolCalls: harness.workerToolObservations.length,
      interruptCalls: transport.requests.filter((request) => request.method === 'turn/interrupt')
        .length,
      dynamicToolSuccess: observeSubscriptionTransport(transport).toolResultSuccess,
      connectionIds: harness.router
        .callLog()
        .map((call) => call.model.connectionId)
        .filter((connectionId): connectionId is string => connectionId !== undefined),
      terminalSurface: requireWorkerSurface(harness.store, workerSurfaceId(workerId)),
      chatSessionEntries: normalizeSessionEntries(chatSession.entries),
      workerSessionEntries: normalizeSessionEntries(workerSession.entries),
      workerEvents: workerEventsSinceStart(harness),
    }
  } finally {
    harness.workerGate.release()
    pool?.dispose()
    transport.close()
    harness.dispose()
  }
}

function stabilizeReadRecentResult(tool: ToolDef): ToolDef {
  if (tool.name !== 'read_recent') return tool
  return {
    ...tool,
    async handler(input, context) {
      const result = await tool.handler(input, context)
      return { ...result, content: WORKER_PARITY_SOURCE_NOTE }
    },
  }
}

function budgetTransport(
  chatRoundTrip: ReturnType<typeof fakeCodexDynamicToolRoundTrip>,
  workerRoundTrips: ReturnType<typeof fakeCodexDynamicToolRoundTrip>[],
): FakeCodexTransport {
  const firstWorkerRoundTrip = workerRoundTrips[0]
  if (!firstWorkerRoundTrip) throw new Error('Worker budget fixture needs one Worker tool call')

  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': (params: unknown) =>
        fakeCodexThreadStartResponse(
          workerThreadPurpose(params) === 'chat'
            ? 'thread-worker-budget-chat'
            : 'thread-worker-budget-run',
        ),
      'turn/start': (params: unknown) => {
        const values = workerRecordValue(params, 'turn/start params')
        const threadId = workerStringValue(values['threadId'], 'turn/start threadId')
        if (threadId === 'thread-worker-budget-chat') {
          transport.emit(chatRoundTrip.startNotification)
          transport.emitServerRequest(chatRoundTrip.serverRequest)
          return fakeCodexTurnStartResponse('turn-worker-budget-chat')
        }
        if (threadId === 'thread-worker-budget-run') {
          transport.emit(firstWorkerRoundTrip.startNotification)
          transport.emitServerRequest(firstWorkerRoundTrip.serverRequest)
          return fakeCodexTurnStartResponse('turn-worker-budget-run')
        }
        throw new Error(`unexpected Worker budget thread "${threadId}"`)
      },
      'turn/interrupt': {},
    },
    serverResponseStages: [
      { notifications: chatRoundTrip.continuationNotifications },
      ...intermediateWorkerStages(workerRoundTrips),
    ],
  })
  return transport
}

function intermediateWorkerStages(
  roundTrips: ReturnType<typeof fakeCodexDynamicToolRoundTrip>[],
): Array<{
  notifications: { method: string; params: unknown }[]
  serverRequests: Array<{ id: string | number; method: string; params: unknown }>
}> {
  return roundTrips.slice(0, -1).map((roundTrip, index) => {
    const next = roundTrips[index + 1]
    if (!next) throw new Error('Worker budget fixture lost its next tool call')
    return {
      notifications: [roundTrip.continuationNotifications[0]!, next.startNotification],
      serverRequests: [next.serverRequest],
    }
  })
}
