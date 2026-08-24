import type { Surface } from '@veduta/protocol'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
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
  WORKER_PARITY_SPACE_ID,
  type StableWorkerSpaceEvent,
} from './provider-worker-parity-support.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import type { WorkerBriefing } from './worker-briefing.ts'
import { workerSurfaceId } from './worker-surface.ts'
import type { WorkerPool } from './worker.ts'

export interface WorkerAbortOutcome {
  spawnCalls: number
  chatCompletedBeforeCancel: boolean
  interruptCalls: number
  dynamicToolSuccess: boolean[]
  terminalSurface: Surface
  chatSessionEntries: unknown[]
  workerSessionEntries: unknown[]
  workerEvents: StableWorkerSpaceEvent[]
}

export async function runSubscriptionWorkerAbortScenario(): Promise<WorkerAbortOutcome> {
  const harness = buildWorkerParityHarness('chatgpt-subscription')
  const workerId = 'wrk-abort'
  const abortBriefing: WorkerBriefing = {
    ...WORKER_PARITY_BRIEFING,
    allowedTools: [],
    highRisk: false,
  }
  const spawnResult =
    `spawned worker ${workerId}, researching: ` + 'Investigate the Worker parity source note'
  const chatRoundTrip = fakeCodexDynamicToolRoundTrip({
    threadId: 'thread-worker-abort-chat',
    turnId: 'turn-worker-abort-chat',
    callId: 'call-worker-abort',
    tool: 'spawn_worker',
    input: abortBriefing,
    resultText: spawnResult,
    finalText: WORKER_PARITY_CHAT_FINAL_TEXT,
  })
  let markWorkerTurnStarted: () => void = () => {}
  const workerTurnStarted = new Promise<void>((resolve) => {
    markWorkerTurnStarted = resolve
  })
  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': (params: unknown) => {
        const purpose = workerThreadPurpose(workerRecordValue(params, 'thread/start params'))
        return fakeCodexThreadStartResponse(
          purpose === 'chat' ? 'thread-worker-abort-chat' : 'thread-worker-abort-run',
        )
      },
      'turn/start': (params: unknown) => {
        const values = workerRecordValue(params, 'turn/start params')
        const threadId = workerStringValue(values['threadId'], 'turn/start threadId')
        if (threadId === 'thread-worker-abort-chat') {
          transport.emit(chatRoundTrip.startNotification)
          transport.emitServerRequest(chatRoundTrip.serverRequest)
          return fakeCodexTurnStartResponse('turn-worker-abort-chat')
        }
        if (threadId === 'thread-worker-abort-run') {
          markWorkerTurnStarted()
          return fakeCodexTurnStartResponse('turn-worker-abort-run')
        }
        throw new Error(`unexpected Worker abort thread "${threadId}"`)
      },
      'turn/interrupt': {},
    },
    notificationsAfterServerResponse: chatRoundTrip.continuationNotifications,
  })
  const provider = subscriptionProvider({
    connectionId: WORKER_PARITY_CONNECTION_ID,
    rootDir: parityTempDir(harness.directories, 'veduta-provider-worker-abort-codex-'),
    now: WORKER_PARITY_NOW,
    transport,
  })
  let pool: WorkerPool | undefined

  try {
    pool = createWorkerParityPool({ harness, provider, workerId })
    const spawnTool = observeWorkerTool(createSpawnWorkerTool(pool), harness.spawnObservations)
    const chatEvents = await harness.router.execute(
      { purpose: 'chat-turn', origin: 'user', spaceId: WORKER_PARITY_SPACE_ID },
      (model) =>
        runProviderParityTurn({
          provider,
          sessionStore: harness.sessionStore,
          sessionId: 'provider-worker-abort-chat',
          input: 'Start a Worker that I will cancel from its Surface.',
          model,
          tools: [spawnTool],
          promptOptions: { origin: 'trusted:user', spaceId: WORKER_PARITY_SPACE_ID },
        }),
    )
    await workerTurnStarted
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    const chatCompletedBeforeCancel =
      chatEvents.some((event) => event.type === 'turn-end') &&
      harness.store
        .eventLog(WORKER_PARITY_SPACE_ID)
        .every((event) => event.type !== 'worker.cancelled')
    harness.store.invokeSurfaceAction(workerSurfaceId(workerId), {
      nodeId: 'worker-cancel',
      name: 'cancel',
      payload: { value: true },
    })
    await pool.whenSettled(workerId)

    const chatSession = await harness.sessionStore.load('provider-worker-abort-chat')
    const workerSession = await harness.sessionStore.load(`worker-${workerId}`)
    return {
      spawnCalls: harness.spawnObservations.length,
      chatCompletedBeforeCancel,
      interruptCalls: transport.requests.filter((request) => request.method === 'turn/interrupt')
        .length,
      dynamicToolSuccess: observeSubscriptionTransport(transport).toolResultSuccess,
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
