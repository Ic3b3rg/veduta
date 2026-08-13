import { rmSync } from 'node:fs'
import type { ToolDef } from './agent-runner.ts'
import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import {
  modelForConnectionMethod,
  parityTempDir,
  runProviderParityTurn,
  scriptedByokProvider,
  scriptedSubscriptionTransport,
  subscriptionProvider,
  type ModelConnectionMethod,
  type ScriptedToolCall,
} from './provider-parity-model-fixture.ts'
import {
  normalizeAgentEvents,
  normalizeSessionEntries,
  normalizeSpaceEvent,
  normalizeStableValue,
} from './provider-parity-test-support.ts'
import {
  captureProviderDefinitions,
  consistentProviderDefinitions,
  observeSubscriptionTransport,
  subscriptionDefinitions,
  type ProviderToolDefinition,
  type SubscriptionTransportObservation,
} from './provider-parity-observation.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'
import type { Origin } from './taint.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000075'
const FIXED_NOW = new Date('2026-08-13T10:00:00.000Z')
const SPACE_ID = 'spc-health'
const FINAL_TEXT = 'Space memory checked.'
const RECENT_CONTEXT_LIMIT = 20

export const MEMORY_PARITY_PRIMARY_FACT = 'Recovery drink preference is chamomile tea'
export const MEMORY_PARITY_DERIVED_FACT = 'Train platform changed to seven'
export const MEMORY_PARITY_UNTRUSTED_EVENT = 'Boarding pass reminder says platform seven in Verona'
export const MEMORY_PARITY_UNTRUSTED_ORIGIN = 'untrusted:gmail'

interface MemoryParityCall {
  toolName: string
  input: Record<string, unknown>
}

const MEMORY_PARITY_CALLS: MemoryParityCall[] = [
  { toolName: 'write_fact', input: { fact: MEMORY_PARITY_PRIMARY_FACT } },
  {
    toolName: 'search_memory',
    input: { query: 'chamomile recovery', kind: 'fact', limit: 5 },
  },
  { toolName: 'read_recent', input: { limit: 1 } },
  { toolName: 'search_log', input: { query: 'boarding', limit: 5 } },
  {
    toolName: 'search_memory',
    input: { query: 'boarding platform', kind: 'event', limit: 5 },
  },
  { toolName: 'write_fact', input: { fact: MEMORY_PARITY_DERIVED_FACT } },
]

export interface MemoryParityToolResult {
  toolName: string
  content: string
  details?: unknown
  origin?: Origin
  origins?: Origin[]
}

export interface MemoryParityOutcome {
  offeredDefinitions: ProviderToolDefinition[]
  events: unknown[]
  sessionEntries: unknown[]
  toolResults: MemoryParityToolResult[]
  facts: Array<{
    state: 'active' | 'dormant' | 'superseded'
    text: string
    noted?: string
    origin?: Origin
  }>
  eventLog: unknown[]
  taintBeforeCalls: Array<{ toolName: string; origins: Origin[] }>
  handlerExecution: {
    total: number
    distinctCallIds: number
    maxCallsPerId: number
    allContextHashesValid: boolean
    byTool: Record<string, number>
  }
}

interface MemoryParityRun {
  outcome: MemoryParityOutcome
  toolResultTexts: string[]
  transport?: SubscriptionTransportObservation
}

interface MemoryParityPair {
  byok: Pick<MemoryParityRun, 'outcome' | 'toolResultTexts'>
  subscription: MemoryParityRun & { transport: NonNullable<MemoryParityRun['transport']> }
}

interface HandlerObservation {
  toolName: string
  toolCallId: string
  origins: Origin[]
  contextHash: string
}

interface MemoryHarness {
  directories: string[]
  engine: SpacesEngine
  index: MemoryIndex
  sessionStore: PiJsonlSessionStore
  tools: ToolDef[]
  eventStart: number
  handlerObservations: HandlerObservation[]
  dispose(): void
}

export async function runMemoryParityPair(): Promise<MemoryParityPair> {
  const byok = await runMemoryParityScenario('byok')
  const subscription = await runMemoryParityScenario('chatgpt-subscription', byok.toolResultTexts)
  if (!subscription.transport) throw new Error('subscription scenario produced no transport data')
  return {
    byok: { outcome: byok.outcome, toolResultTexts: byok.toolResultTexts },
    subscription: { ...subscription, transport: subscription.transport },
  }
}

async function runMemoryParityScenario(
  method: ModelConnectionMethod,
  expectedResultTexts: string[] = [],
): Promise<MemoryParityRun> {
  const harness = buildHarness()
  const byokDefinitionSets: ProviderToolDefinition[][] = []
  let transport: FakeCodexTransport | undefined
  try {
    const scriptedCalls = callsWithResultTexts(method, expectedResultTexts)
    const provider =
      method === 'byok'
        ? captureProviderDefinitions(
            scriptedByokProvider(scriptedCalls, FINAL_TEXT),
            byokDefinitionSets,
          )
        : subscriptionProvider({
            connectionId: CONNECTION_ID,
            rootDir: parityTempDir(harness.directories, 'veduta-provider-memory-codex-'),
            now: FIXED_NOW,
            transport: (transport = scriptedSubscriptionTransport(
              scriptedCalls,
              FINAL_TEXT,
              'memory',
            )),
          })

    const events = await runProviderParityTurn({
      provider,
      sessionStore: harness.sessionStore,
      sessionId: 'provider-memory-parity',
      input: 'write and inspect the requested Space memory',
      model: modelForConnectionMethod(method, CONNECTION_ID),
      tools: harness.tools,
      promptOptions: {
        origin: 'trusted:user',
        contextOrigins: harness.engine.contextOrigins(SPACE_ID, RECENT_CONTEXT_LIMIT),
        spaceId: SPACE_ID,
        trigger: { kind: 'chat', summary: 'write and inspect Space memory' },
      },
    })

    const session = await harness.sessionStore.load('provider-memory-parity')
    const toolMessages = session.messages.filter((message) => message.role === 'tool')
    if (toolMessages.length !== MEMORY_PARITY_CALLS.length) {
      throw new Error(
        `expected ${MEMORY_PARITY_CALLS.length} tool results, received ${toolMessages.length}`,
      )
    }
    const toolResultTexts = toolMessages.map((message) => message.content)
    const offeredDefinitions =
      method === 'byok'
        ? consistentProviderDefinitions(byokDefinitionSets)
        : subscriptionDefinitions(requireTransport(transport))
    const result: MemoryParityRun = {
      outcome: {
        offeredDefinitions,
        events: normalizeAgentEvents(events, { includeTurnOrigins: true }),
        sessionEntries: normalizeSessionEntries(session.entries),
        toolResults: toolMessages.map((message) => ({
          toolName: message.toolName ?? '',
          content: message.content,
          ...(message.details === undefined
            ? {}
            : { details: normalizeStableValue(message.details) }),
          ...(message.origin === undefined ? {} : { origin: message.origin }),
          ...(message.origins === undefined ? {} : { origins: message.origins }),
        })),
        facts: parityFacts(harness.engine),
        eventLog: harness.engine
          .readRecent(SPACE_ID, 1_000)
          .slice(harness.eventStart)
          .map(normalizeSpaceEvent),
        taintBeforeCalls: harness.handlerObservations.map((observation) => ({
          toolName: observation.toolName,
          origins: observation.origins,
        })),
        handlerExecution: handlerExecution(harness.handlerObservations),
      },
      toolResultTexts,
      ...(transport === undefined ? {} : { transport: observeSubscriptionTransport(transport) }),
    }
    return result
  } finally {
    transport?.close()
    harness.dispose()
  }
}

function buildHarness(): MemoryHarness {
  const directories: string[] = []
  const rootDir = parityTempDir(directories, 'veduta-provider-memory-root-')
  const engine = new SpacesEngine({ rootDir, now: () => FIXED_NOW, seed: seedSpaces() })
  engine.appendEvent(SPACE_ID, {
    type: 'reader.summary',
    text: MEMORY_PARITY_UNTRUSTED_EVENT,
    origin: MEMORY_PARITY_UNTRUSTED_ORIGIN,
  })
  for (let index = 1; index <= RECENT_CONTEXT_LIMIT + 1; index++) {
    engine.appendEvent(SPACE_ID, {
      type: 'turn',
      text: `Trusted context filler ${index}`,
      origin: 'trusted:system',
    })
  }
  if (
    engine.contextOrigins(SPACE_ID, RECENT_CONTEXT_LIMIT).includes(MEMORY_PARITY_UNTRUSTED_ORIGIN)
  ) {
    throw new Error('the long-tail event must not taint the turn before a memory read')
  }

  const index = new MemoryIndex({ rootDir, spacesEngine: engine, now: () => FIXED_NOW })
  index.reconcile()
  const retrieval = new MemoryRetrieval({
    index,
    spacesEngine: engine,
    config: MemoryConfigSchema.parse({}),
    now: () => FIXED_NOW,
  })
  const handlerObservations: HandlerObservation[] = []
  const tools = trackHandlers(
    createMemoryTools(engine, { activeSpaceId: SPACE_ID, retrieval }),
    handlerObservations,
  )

  return {
    directories,
    engine,
    index,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-memory-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-memory-sessions-'),
    }),
    tools,
    eventStart: engine.readRecent(SPACE_ID, 1_000).length,
    handlerObservations,
    dispose() {
      index.close()
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

function trackHandlers(tools: ToolDef[], observations: HandlerObservation[]): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    async handler(input, context) {
      observations.push({
        toolName: tool.name,
        toolCallId: context.toolCallId,
        origins: context.taint.origins(),
        contextHash: context.contextHash,
      })
      return tool.handler(input, context)
    },
  }))
}

function callsWithResultTexts(
  method: ModelConnectionMethod,
  resultTexts: string[],
): ScriptedToolCall[] {
  if (method === 'chatgpt-subscription' && resultTexts.length !== MEMORY_PARITY_CALLS.length) {
    throw new Error('the subscription fixture needs one observed result per scripted call')
  }
  return MEMORY_PARITY_CALLS.map((call, index) => ({
    ...call,
    resultText: resultTexts[index] ?? '',
  }))
}

function parityFacts(engine: SpacesEngine): MemoryParityOutcome['facts'] {
  const document = engine.readFacts(SPACE_ID)
  return (
    [
      ...document.active.map((fact) => ({ state: 'active' as const, fact })),
      ...document.dormant.map((fact) => ({ state: 'dormant' as const, fact })),
      ...document.superseded.map((fact) => ({ state: 'superseded' as const, fact })),
    ] as const
  )
    .filter(({ fact }) =>
      [MEMORY_PARITY_PRIMARY_FACT, MEMORY_PARITY_DERIVED_FACT].includes(fact.text),
    )
    .map(({ state, fact }) => ({
      state,
      text: fact.text,
      ...(fact.noted === undefined ? {} : { noted: fact.noted }),
      ...(fact.origin === undefined ? {} : { origin: fact.origin }),
    }))
}

function handlerExecution(
  observations: HandlerObservation[],
): MemoryParityOutcome['handlerExecution'] {
  const callsPerId = new Map<string, number>()
  const byTool: Record<string, number> = {}
  for (const observation of observations) {
    callsPerId.set(observation.toolCallId, (callsPerId.get(observation.toolCallId) ?? 0) + 1)
    byTool[observation.toolName] = (byTool[observation.toolName] ?? 0) + 1
  }
  return {
    total: observations.length,
    distinctCallIds: callsPerId.size,
    maxCallsPerId: Math.max(0, ...callsPerId.values()),
    allContextHashesValid: observations.every((observation) =>
      /^[0-9a-f]{64}$/.test(observation.contextHash),
    ),
    byTool,
  }
}

function requireTransport(transport: FakeCodexTransport | undefined): FakeCodexTransport {
  if (!transport) throw new Error('subscription scenario created no Codex transport')
  return transport
}
