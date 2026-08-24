import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
} from './codex-app-server-fake.ts'
import { normalizeSessionEntries } from './provider-parity-test-support.ts'
import {
  parityTempDir,
  runProviderParityTurn,
  subscriptionProvider,
} from './provider-parity-model-fixture.ts'
import { observeSubscriptionTransport } from './provider-parity-observation.ts'
import {
  buildWorkerParityHarness,
  createWorkerParityPool,
  isWorkerToolMessage,
  observeWorkerTool,
  stableWorkerToolResult,
  workerEventsSinceStart,
  WORKER_PARITY_BRIEFING,
  WORKER_PARITY_CONNECTION_ID,
  WORKER_PARITY_NOW,
  WORKER_PARITY_SPACE_ID,
  type StableWorkerSpaceEvent,
  type WorkerParityToolResult,
} from './provider-worker-parity-support.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import type { WorkerPool } from './worker.ts'

export interface WorkerFailureNoReplayOutcome {
  attemptedConnectionIds: string[]
  fallbackCalls: number
  spawnCalls: number
  chatError: string
  dynamicToolSuccess: boolean[]
  chatToolResults: WorkerParityToolResult[]
  chatSessionEntries: unknown[]
  workerSessionEntries: unknown[]
  workerEvents: StableWorkerSpaceEvent[]
}

export async function runSubscriptionWorkerFailureNoReplayScenario(): Promise<WorkerFailureNoReplayOutcome> {
  const fallbackConnectionId = 'c0ffee00-0000-4000-8000-000000000079'
  const harness = buildWorkerParityHarness('chatgpt-subscription', {
    tiers: {
      triage: [],
      reasoning: [
        {
          provider: 'openai',
          modelId: 'gpt-5-codex',
          connectionId: WORKER_PARITY_CONNECTION_ID,
        },
        {
          provider: 'openai',
          modelId: 'gpt-5-codex-fallback',
          connectionId: fallbackConnectionId,
        },
      ],
    },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 20 },
  })
  const workerId = 'wrk-failure'
  const spawnResult =
    `spawned worker ${workerId}, researching: ` + 'Investigate the Worker parity source note'
  const roundTrip = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-worker-failure',
    turnId: 'turn-worker-failure',
    callId: 'call-worker-failure',
    tool: 'spawn_worker',
    input: WORKER_PARITY_BRIEFING,
    resultText: spawnResult,
  })
  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': fakeCodexThreadStartResponse('thread-worker-failure'),
      'turn/start': () => {
        transport.emit(roundTrip.startNotification)
        transport.emitServerRequest(roundTrip.serverRequest)
        return fakeCodexTurnStartResponse('turn-worker-failure')
      },
    },
    notificationsAfterServerResponse: [
      roundTrip.continuationNotifications[0]!,
      {
        method: 'error',
        params: {
          threadId: 'thread-worker-failure',
          turnId: 'turn-worker-failure',
          error: { message: 'Selected model is at capacity.' },
          willRetry: false,
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-worker-failure',
          turn: {
            id: 'turn-worker-failure',
            status: 'failed',
            error: { message: 'Selected model is at capacity.' },
            items: [],
          },
        },
      },
    ],
  })
  const provider = subscriptionProvider({
    connectionId: WORKER_PARITY_CONNECTION_ID,
    rootDir: parityTempDir(harness.directories, 'veduta-provider-worker-failure-codex-'),
    now: WORKER_PARITY_NOW,
    transport,
  })
  let pool: WorkerPool | undefined
  const attemptedConnectionIds: string[] = []
  let fallbackCalls = 0
  let chatError = ''

  try {
    harness.router.recordSpend(
      {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId: WORKER_PARITY_CONNECTION_ID,
      },
      21,
    )
    pool = createWorkerParityPool({ harness, provider, workerId })
    const spawnTool = observeWorkerTool(createSpawnWorkerTool(pool), harness.spawnObservations)

    try {
      await harness.router.execute(
        { purpose: 'chat-turn', origin: 'user', spaceId: WORKER_PARITY_SPACE_ID },
        async (model) => {
          attemptedConnectionIds.push(model.connectionId ?? model.provider)
          if (model.connectionId === fallbackConnectionId) {
            fallbackCalls++
            return []
          }
          return runProviderParityTurn({
            provider,
            sessionStore: harness.sessionStore,
            sessionId: 'provider-worker-failure-chat',
            input: 'Start the Worker while proactive tier spend is capped.',
            model,
            tools: [spawnTool],
            promptOptions: { origin: 'trusted:user', spaceId: WORKER_PARITY_SPACE_ID },
          })
        },
      )
    } catch (error) {
      chatError = error instanceof Error ? error.message : String(error)
    }

    await pool.whenSettled(workerId)
    const chatSession = await harness.sessionStore.load('provider-worker-failure-chat')
    const workerSession = await harness.sessionStore.load(`worker-${workerId}`)
    return {
      attemptedConnectionIds,
      fallbackCalls,
      spawnCalls: harness.spawnObservations.length,
      chatError,
      dynamicToolSuccess: observeSubscriptionTransport(transport).toolResultSuccess,
      chatToolResults: chatSession.messages.filter(isWorkerToolMessage).map(stableWorkerToolResult),
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
