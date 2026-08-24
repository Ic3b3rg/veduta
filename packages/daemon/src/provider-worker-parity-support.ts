import { rmSync } from 'node:fs'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import type { AgentEvent, SessionMessage, ToolDef, ToolResult } from './agent-runner.ts'
import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { ModelRouter, type RuntimeRoutingConfig } from './model-routing.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import { completeToolless, type ProviderBridge } from './pi-provider-bridge.ts'
import { parityTempDir, type ModelConnectionMethod } from './provider-parity-model-fixture.ts'
import { normalizeSpaceEvent, normalizeStableValue } from './provider-parity-test-support.ts'
import { Store } from './store.ts'
import { piToolParameters } from './tool-parameters.ts'
import { WORKER_REPORT_VERSION, type WorkerBriefing, type WorkerReport } from './worker-briefing.ts'
import { WorkerPool } from './worker.ts'
import { workerToolRegistry } from './worker-tool-registry.ts'

export const WORKER_PARITY_CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000078'
export const WORKER_PARITY_NOW = new Date('2026-08-24T16:00:00.000Z')
export const WORKER_PARITY_SPACE_ID = 'spc-health'
export const WORKER_PARITY_ID = 'wrk-parity'
export const WORKER_PARITY_CHAT_SESSION_ID = 'provider-worker-parity-chat'
export const WORKER_PARITY_SOURCE_NOTE =
  'Worker parity source note: the recovery window is forty-eight hours.'
export const WORKER_PARITY_CHAT_FINAL_TEXT = 'The Worker is running in the background.'
export const WORKER_PARITY_REPORT: WorkerReport = {
  version: WORKER_REPORT_VERSION,
  title: 'Reviewed Worker report',
  summary: 'Reviewed Worker report based on the bounded Space evidence.',
  sections: [
    {
      heading: 'Finding',
      body: 'The source note records a forty-eight-hour recovery window.',
    },
  ],
  claims: [
    {
      text: 'The recorded recovery window is forty-eight hours.',
      support: 'The focused Space Event log source note.',
    },
  ],
}
export const WORKER_PARITY_REVIEW_TEXT = JSON.stringify({
  verdict: 'pass',
  unsupportedClaims: [],
})
export const WORKER_PARITY_BRIEFING: WorkerBriefing = {
  goal: 'Investigate the Worker parity source note',
  allowedTools: ['read_recent', 'send_message'],
  boundaries: ['Read only from the focused Space and do not contact external systems.'],
  tokenBudget: 10_000,
  maxIterations: 6,
  tier: 'reasoning',
  highRisk: true,
}

export type WorkerProviderCallPurpose = 'chat' | 'worker' | 'review'

export interface WorkerHandlerObservation {
  toolCallId: string
}

export interface WorkerParityToolResult {
  toolName: string
  content: string
  details?: unknown
  isError: boolean
}

export interface StableWorkerSpaceEvent extends Record<string, unknown> {
  type: string
}

export interface WorkerParityHarness {
  directories: string[]
  store: Store
  sessionStore: PiJsonlSessionStore
  router: ModelRouter
  workerTools: ToolDef[]
  workerGate: AsyncGate
  spawnObservations: WorkerHandlerObservation[]
  workerToolObservations: WorkerHandlerObservation[]
  eventStart: number
  dispose(): void
}

export class AsyncGate {
  private releaseWaiter: () => void = () => {}
  private enterWaiter: () => void = () => {}
  private released = false
  private entered = false
  readonly waitUntilEntered = new Promise<void>((resolve) => {
    this.enterWaiter = resolve
  })
  private readonly waitUntilReleased = new Promise<void>((resolve) => {
    this.releaseWaiter = resolve
  })

  async wait(): Promise<void> {
    if (!this.entered) {
      this.entered = true
      this.enterWaiter()
    }
    if (!this.released) await this.waitUntilReleased
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.releaseWaiter()
  }
}

export function buildWorkerParityHarness(
  method: ModelConnectionMethod,
  config: RuntimeRoutingConfig = workerParityRoutingConfig(method),
): WorkerParityHarness {
  const directories: string[] = []
  const rootDir = parityTempDir(directories, 'veduta-provider-worker-root-')
  const store = new Store({ rootDir, now: () => WORKER_PARITY_NOW })
  store.spacesEngine.appendEvent(WORKER_PARITY_SPACE_ID, {
    type: 'turn',
    text: WORKER_PARITY_SOURCE_NOTE,
    origin: 'trusted:user',
  })
  const index = new MemoryIndex({
    rootDir,
    spacesEngine: store.spacesEngine,
    now: () => WORKER_PARITY_NOW,
  })
  index.reconcile()
  const retrieval = new MemoryRetrieval({
    index,
    spacesEngine: store.spacesEngine,
    config: MemoryConfigSchema.parse({}),
    now: () => WORKER_PARITY_NOW,
  })
  const workerGate = new AsyncGate()
  const workerToolObservations: WorkerHandlerObservation[] = []
  const workerTools = workerToolRegistry({
    spacesEngine: store.spacesEngine,
    memoryRetrieval: retrieval,
  }).map((tool) =>
    tool.name === 'read_recent'
      ? observeWorkerTool(tool, workerToolObservations, () => workerGate.wait())
      : observeWorkerTool(tool, workerToolObservations),
  )

  return {
    directories,
    store,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-worker-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-worker-sessions-'),
    }),
    router: new ModelRouter({
      config,
      rootDir,
      now: () => WORKER_PARITY_NOW,
      sleep: async () => {},
    }),
    workerTools,
    workerGate,
    spawnObservations: [],
    workerToolObservations,
    eventStart: store.eventLog(WORKER_PARITY_SPACE_ID).length,
    dispose() {
      index.close()
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

export function createWorkerParityPool(args: {
  harness: WorkerParityHarness
  provider: ProviderBridge
  workerId: string
  onAgentEvent?: (event: AgentEvent) => void
}): WorkerPool {
  const workerParameters = piToolParameters(args.harness.workerTools)
  return new WorkerPool({
    store: args.harness.store,
    router: args.harness.router,
    workerTools: args.harness.workerTools,
    runnerFactory: () => {
      const runner = new PiAgentRunner({
        sessionStore: args.harness.sessionStore,
        resolveModel: args.provider.resolveModel,
        getApiKey: args.provider.getApiKey,
        streamFn: args.provider.streamFn,
        toolParameters: workerParameters,
      })
      if (args.onAgentEvent) runner.on(args.onAgentEvent)
      return runner
    },
    reviewComplete: (model, prompt) => completeToolless(args.provider, model, prompt),
    makeWorkerId: () => args.workerId,
    now: () => WORKER_PARITY_NOW,
  })
}

export function observeWorkerTool(
  tool: ToolDef,
  observations: WorkerHandlerObservation[],
  beforeHandler?: () => Promise<void>,
): ToolDef {
  return {
    ...tool,
    async handler(input, context): Promise<ToolResult> {
      observations.push({ toolCallId: context.toolCallId })
      await beforeHandler?.()
      return tool.handler(input, context)
    },
  }
}

export function workerHandlerCounts(observations: WorkerHandlerObservation[]): {
  calls: number
  distinctCallIds: number
  maxCallsPerId: number
} {
  const callsPerId = new Map<string, number>()
  for (const observation of observations) {
    callsPerId.set(observation.toolCallId, (callsPerId.get(observation.toolCallId) ?? 0) + 1)
  }
  return {
    calls: observations.length,
    distinctCallIds: callsPerId.size,
    maxCallsPerId: Math.max(0, ...callsPerId.values()),
  }
}

export function stableWorkerToolResult(message: SessionMessage): WorkerParityToolResult {
  return {
    toolName: message.toolName ?? '',
    content: message.content,
    ...(message.details === undefined ? {} : { details: normalizeStableValue(message.details) }),
    isError: message.isError ?? false,
  }
}

export function isWorkerToolMessage(message: SessionMessage): boolean {
  return message.role === 'tool'
}

export function requireWorkerSurface(store: Store, surfaceId: string): Surface {
  const surface = store.getSurface(surfaceId)
  if (!surface) throw new Error(`missing Surface ${surfaceId}`)
  return SurfaceSchema.parse(surface)
}

export function stableWorkerSpaceEvent(
  event: Parameters<typeof normalizeSpaceEvent>[0],
): StableWorkerSpaceEvent {
  const normalized = workerRecordValue(normalizeSpaceEvent(event), 'normalized Space Event')
  return {
    ...normalized,
    type: workerStringValue(normalized['type'], 'Space Event type'),
  }
}

export function workerEventsSinceStart(harness: WorkerParityHarness): StableWorkerSpaceEvent[] {
  return harness.store
    .eventLog(WORKER_PARITY_SPACE_ID)
    .slice(harness.eventStart)
    .map(stableWorkerSpaceEvent)
}

export function requireWorkerTransport(
  transport: FakeCodexTransport | undefined,
): FakeCodexTransport {
  if (!transport) throw new Error('subscription Worker transport was not created')
  return transport
}

export function workerThreadPurpose(value: unknown): WorkerProviderCallPurpose {
  const params = workerRecordValue(value, 'thread/start params')
  const names = workerDynamicToolNames(params)
  if (names.length === 1 && names[0] === 'spawn_worker') return 'chat'
  if (names.length === 1 && names[0] === 'read_recent') return 'worker'
  if (names.length === 0) return 'review'
  throw new Error(`unexpected Worker parity dynamic tools: ${names.join(', ')}`)
}

export function workerDynamicToolNames(params: Record<string, unknown>): string[] {
  const definitions = params['dynamicTools']
  if (!Array.isArray(definitions)) throw new Error('thread/start carried no dynamicTools array')
  return definitions.map((definition) =>
    workerStringValue(
      workerRecordValue(definition, 'dynamic tool definition')['name'],
      'dynamic tool name',
    ),
  )
}

export function workerRecordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

export function workerStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`)
  return value
}

function workerParityRoutingConfig(method: ModelConnectionMethod): RuntimeRoutingConfig {
  const candidate =
    method === 'byok'
      ? { provider: 'fake', modelId: 'fake-model' }
      : {
          provider: 'openai',
          modelId: 'gpt-5-codex',
          connectionId: WORKER_PARITY_CONNECTION_ID,
        }
  return {
    tiers: { triage: [candidate], reasoning: [candidate] },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 20 },
  }
}
