import { rmSync } from 'node:fs'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import type { AgentEvent, ToolDef } from './agent-runner.ts'
import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
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
import { ModelRouter, type RuntimeRoutingConfig } from './model-routing.ts'
import {
  captureProviderDefinitions,
  consistentProviderDefinitions,
  observeSubscriptionTransport,
  subscriptionDefinitions,
  type ProviderToolDefinition,
  type SubscriptionTransportObservation,
} from './provider-parity-observation.ts'
import {
  normalizeAgentEvents,
  normalizeSessionEntries,
  normalizeSpaceEvent,
  normalizeStableValue,
} from './provider-parity-test-support.ts'
import { Scheduler, type Automation } from './scheduler.ts'
import { Store } from './store.ts'
import type { Origin } from './taint.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000077'
const FALLBACK_CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000078'
const FIXED_NOW = new Date('2026-08-24T09:00:00.000Z')

type AutomationTurnKey = 'create' | 'disable' | 'cancel' | 'reject-other-space'

export const AUTOMATION_PARITY_SPACE_ID = 'spc-health'
export const AUTOMATION_PARITY_OTHER_SPACE_ID = 'spc-other-space'
export const AUTOMATION_PARITY_UNTRUSTED_ORIGIN = 'untrusted:gmail'

export interface AutomationParityToolResult {
  toolName: string
  content: string
  isError?: boolean
  details?: unknown
  origin?: Origin
  origins?: Origin[]
}

export interface AutomationParityOutcome {
  offeredDefinitions: ProviderToolDefinition[]
  events: unknown[]
  sessionEntries: unknown[]
  toolResults: AutomationParityToolResult[]
  focusedAutomations: Automation[]
  otherSpaceAutomations: Automation[]
  automationsSurface: Surface
  eventLog: unknown[]
  otherSpaceEventLog: unknown[]
  turns: Array<{
    key: AutomationTurnKey
    toolNames: string[]
    finalText: string
  }>
  handlerExecution: {
    total: number
    distinctCallIds: number
    maxCallsPerId: number
    allContextHashesValid: boolean
    byTool: Record<string, number>
  }
}

interface AutomationParityRun {
  outcome: AutomationParityOutcome
  toolResultTexts: string[]
  acceptedCallIds: string[]
  handlerCallIds: string[]
  transports?: Array<SubscriptionTransportObservation & { key: AutomationTurnKey }>
}

interface AutomationParityPair {
  byok: Pick<
    AutomationParityRun,
    'outcome' | 'toolResultTexts' | 'acceptedCallIds' | 'handlerCallIds'
  >
  subscription: AutomationParityRun & {
    transports: NonNullable<AutomationParityRun['transports']>
  }
}

export interface AutomationHandlerErrorNoReplayOutcome {
  attemptedConnectionIds: string[]
  fallbackCalls: number
  handlerCalls: number
  toolResult: AutomationParityToolResult
  dynamicToolSuccess: boolean[]
}

interface AutomationHarness {
  directories: string[]
  store: Store
  scheduler: Scheduler
  sessionStore: PiJsonlSessionStore
  tools: ToolDef[]
  focusedAutomationId: number
  otherSpaceAutomationId: number
  eventStart: number
  otherSpaceEventStart: number
  handlerObservations: HandlerObservation[]
  activeTurn: { key: AutomationTurnKey }
  dispose(): void
}

interface HandlerObservation {
  turnKey: AutomationTurnKey
  toolName: string
  toolCallId: string
  contextHash: string
}

interface AutomationTurnScript {
  key: AutomationTurnKey
  input: string
  finalText: string
  calls: Array<Omit<ScriptedToolCall, 'resultText'>>
}

export async function runAutomationParityPair(): Promise<AutomationParityPair> {
  const byok = await runAutomationParityScenario('byok')
  const subscription = await runAutomationParityScenario(
    'chatgpt-subscription',
    byok.toolResultTexts,
  )
  if (!subscription.transports) {
    throw new Error('subscription scenario produced no transport data')
  }
  return {
    byok: {
      outcome: byok.outcome,
      toolResultTexts: byok.toolResultTexts,
      acceptedCallIds: byok.acceptedCallIds,
      handlerCallIds: byok.handlerCallIds,
    },
    subscription: { ...subscription, transports: subscription.transports },
  }
}

export async function runAutomationHandlerErrorNoReplayScenario(): Promise<AutomationHandlerErrorNoReplayOutcome> {
  const harness = buildHarness()
  harness.activeTurn.key = 'reject-other-space'
  const resultText = 'Automation is unavailable in this Space'
  const transport = scriptedSubscriptionTransport(
    [
      {
        toolName: 'set_automation_enabled',
        input: { automationId: harness.otherSpaceAutomationId, enabled: false },
        resultText,
        success: false,
      },
    ],
    'The other Space Automation was not changed.',
    'automation-handler-error-no-replay',
  )
  const provider = subscriptionProvider({
    connectionId: CONNECTION_ID,
    rootDir: parityTempDir(harness.directories, 'veduta-provider-automation-no-replay-codex-'),
    now: FIXED_NOW,
    transport,
  })
  const attemptedConnectionIds: string[] = []
  let fallbackCalls = 0

  try {
    const router = new ModelRouter({
      config: automationNoReplayRoutingConfig(),
      now: () => FIXED_NOW,
      sleep: async () => {},
    })
    await router.execute(
      {
        purpose: 'chat-turn',
        origin: 'user',
        spaceId: AUTOMATION_PARITY_SPACE_ID,
      },
      async (model) => {
        attemptedConnectionIds.push(model.connectionId ?? model.provider)
        if (model.connectionId === FALLBACK_CONNECTION_ID) {
          fallbackCalls++
          return []
        }
        return runProviderParityTurn({
          provider,
          sessionStore: harness.sessionStore,
          sessionId: 'provider-automation-handler-error-no-replay',
          input: 'disable the Automation with the supplied id',
          model,
          tools: harness.tools,
          promptOptions: {
            origin: AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
            spaceId: AUTOMATION_PARITY_SPACE_ID,
            trigger: {
              kind: 'chat',
              summary: 'disable an unavailable Automation',
            },
          },
        })
      },
    )

    const session = await harness.sessionStore.load('provider-automation-handler-error-no-replay')
    const message = session.messages.filter((candidate) => candidate.role === 'tool').at(-1)
    if (!message || message.role !== 'tool') {
      throw new Error('the no-replay scenario produced no tool result')
    }

    return {
      attemptedConnectionIds,
      fallbackCalls,
      handlerCalls: harness.handlerObservations.length,
      toolResult: {
        toolName: message.toolName ?? '',
        content: message.content,
        ...(message.isError === undefined ? {} : { isError: message.isError }),
      },
      dynamicToolSuccess: observeSubscriptionTransport(transport).toolResultSuccess,
    }
  } finally {
    transport.close()
    harness.dispose()
  }
}

async function runAutomationParityScenario(
  method: ModelConnectionMethod,
  expectedResultTexts: string[] = [],
): Promise<AutomationParityRun> {
  const harness = buildHarness()
  const scripts = turnsWithResultTexts(
    method,
    expectedResultTexts,
    harness.focusedAutomationId,
    harness.otherSpaceAutomationId,
  )
  const byokDefinitionSets: ProviderToolDefinition[][] = []
  const subscriptionDefinitionSets: ProviderToolDefinition[][] = []
  const transportObservations: Array<
    SubscriptionTransportObservation & { key: AutomationTurnKey }
  > = []
  const allEvents: AgentEvent[] = []
  const acceptedCallIds: string[] = []
  const turns: AutomationParityOutcome['turns'] = []
  let observedToolMessages = 0

  try {
    for (const script of scripts) {
      harness.activeTurn.key = script.key
      let transport: FakeCodexTransport | undefined
      try {
        const provider =
          method === 'byok'
            ? captureProviderDefinitions(
                scriptedByokProvider(script.calls, script.finalText),
                byokDefinitionSets,
              )
            : subscriptionProvider({
                connectionId: CONNECTION_ID,
                rootDir: parityTempDir(
                  harness.directories,
                  `veduta-provider-automation-${script.key}-codex-`,
                ),
                now: FIXED_NOW,
                transport: (transport = scriptedSubscriptionTransport(
                  script.calls,
                  script.finalText,
                  `automation-${script.key}`,
                )),
              })

        const events = await runProviderParityTurn({
          provider,
          sessionStore: harness.sessionStore,
          sessionId: 'provider-automation-parity',
          input: script.input,
          model: modelForConnectionMethod(method, CONNECTION_ID),
          tools: harness.tools,
          promptOptions: {
            origin: AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
            spaceId: AUTOMATION_PARITY_SPACE_ID,
            trigger: { kind: 'chat', summary: script.input },
          },
        })
        allEvents.push(...events)
        acceptedCallIds.push(
          ...acceptedToolCallIds(events).map((toolCallId) => `${script.key}:${toolCallId}`),
        )

        const session = await harness.sessionStore.load('provider-automation-parity')
        const toolMessages = session.messages
          .filter((message) => message.role === 'tool')
          .slice(observedToolMessages)
        if (toolMessages.length !== script.calls.length) {
          throw new Error(
            `expected ${script.calls.length} ${script.key} tool results, received ${toolMessages.length}`,
          )
        }
        observedToolMessages += toolMessages.length
        turns.push({
          key: script.key,
          toolNames: toolMessages.map((message) => message.toolName ?? ''),
          finalText: completedTurnText(events, script.key),
        })

        if (transport) {
          subscriptionDefinitionSets.push(subscriptionDefinitions(transport))
          transportObservations.push({
            key: script.key,
            ...observeSubscriptionTransport(transport),
          })
        }
      } finally {
        transport?.close()
      }
    }

    const session = await harness.sessionStore.load('provider-automation-parity')
    const toolMessages = session.messages.filter((message) => message.role === 'tool')
    const toolResultTexts = toolMessages.map((message) => message.content)
    const offeredDefinitions =
      method === 'byok'
        ? consistentProviderDefinitions(byokDefinitionSets)
        : consistentProviderDefinitions(subscriptionDefinitionSets)

    const result: AutomationParityRun = {
      outcome: {
        offeredDefinitions,
        events: normalizeAgentEvents(allEvents, { includeTurnOrigins: true }),
        sessionEntries: normalizeSessionEntries(session.entries),
        toolResults: toolMessages.map((message) => ({
          toolName: message.toolName ?? '',
          content: message.content,
          ...(message.isError === undefined ? {} : { isError: message.isError }),
          ...(message.details === undefined
            ? {}
            : { details: normalizeStableValue(message.details) }),
          ...(message.origin === undefined ? {} : { origin: message.origin }),
          ...(message.origins === undefined ? {} : { origins: message.origins }),
        })),
        focusedAutomations: harness.scheduler.listAutomations(AUTOMATION_PARITY_SPACE_ID),
        otherSpaceAutomations: harness.scheduler.listAutomations(AUTOMATION_PARITY_OTHER_SPACE_ID),
        automationsSurface: requireSurface(harness.store, 'srf-health-automations'),
        eventLog: harness.store
          .eventLog(AUTOMATION_PARITY_SPACE_ID)
          .slice(harness.eventStart)
          .map(normalizeSpaceEvent),
        otherSpaceEventLog: harness.store
          .eventLog(AUTOMATION_PARITY_OTHER_SPACE_ID)
          .slice(harness.otherSpaceEventStart)
          .map(normalizeSpaceEvent),
        turns,
        handlerExecution: handlerExecution(harness.handlerObservations),
      },
      toolResultTexts,
      acceptedCallIds,
      handlerCallIds: harness.handlerObservations.map(
        (observation) => `${observation.turnKey}:${observation.toolCallId}`,
      ),
      ...(method === 'chatgpt-subscription' ? { transports: transportObservations } : {}),
    }
    return result
  } finally {
    harness.dispose()
  }
}

function buildHarness(): AutomationHarness {
  const directories: string[] = []
  const rootDir = parityTempDir(directories, 'veduta-provider-automation-root-')
  const store = new Store({ rootDir, now: () => FIXED_NOW })
  const otherSpace = store.spacesEngine.createSpace({ name: 'Other Space' })
  if (otherSpace.id !== AUTOMATION_PARITY_OTHER_SPACE_ID) {
    throw new Error('Automation parity fixture produced an unexpected other-Space id')
  }
  const scheduler = new Scheduler({ rootDir, store, now: () => FIXED_NOW })
  const otherSpaceAutomation = scheduler.armTimer({
    spaceId: AUTOMATION_PARITY_OTHER_SPACE_ID,
    when: '2026-08-24T22:00:00.000Z',
    action: 'Other Space reminder',
  })
  const focused = scheduler.armTimer({
    spaceId: AUTOMATION_PARITY_SPACE_ID,
    when: '2026-08-24T20:00:00.000Z',
    action: 'Existing focused reminder',
  })
  const handlerObservations: HandlerObservation[] = []
  const activeTurn: { key: AutomationTurnKey } = { key: 'create' }
  const tools = trackHandlerCalls(
    createFocusedAutomationTools({
      scheduler,
      spaceId: AUTOMATION_PARITY_SPACE_ID,
    }),
    handlerObservations,
    activeTurn,
  )

  return {
    directories,
    store,
    scheduler,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-automation-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-automation-sessions-'),
    }),
    tools,
    focusedAutomationId: focused.id,
    otherSpaceAutomationId: otherSpaceAutomation.id,
    eventStart: store.eventLog(AUTOMATION_PARITY_SPACE_ID).length,
    otherSpaceEventStart: store.eventLog(AUTOMATION_PARITY_OTHER_SPACE_ID).length,
    handlerObservations,
    activeTurn,
    dispose() {
      scheduler.stop()
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

function automationNoReplayRoutingConfig(): RuntimeRoutingConfig {
  return {
    tiers: {
      triage: [],
      reasoning: [
        {
          provider: 'openai',
          modelId: 'gpt-5-codex',
          connectionId: CONNECTION_ID,
        },
        {
          provider: 'openai',
          modelId: 'gpt-5-codex-fallback',
          connectionId: FALLBACK_CONNECTION_ID,
        },
      ],
    },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 1, reasoning: 5 },
  }
}

function trackHandlerCalls(
  tools: ToolDef[],
  observations: HandlerObservation[],
  activeTurn: { key: AutomationTurnKey },
): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    async handler(input, context) {
      observations.push({
        turnKey: activeTurn.key,
        toolName: tool.name,
        toolCallId: context.toolCallId,
        contextHash: context.contextHash,
      })
      return tool.handler(input, context)
    },
  }))
}

function acceptedToolCallIds(events: AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'tool-start' ? [event.toolCallId] : []))
}

function handlerExecution(
  observations: HandlerObservation[],
): AutomationParityOutcome['handlerExecution'] {
  const callsPerId = new Map<string, number>()
  const byTool: Record<string, number> = {}
  for (const observation of observations) {
    const correlatedCallId = `${observation.turnKey}:${observation.toolCallId}`
    callsPerId.set(correlatedCallId, (callsPerId.get(correlatedCallId) ?? 0) + 1)
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

function turnsWithResultTexts(
  method: ModelConnectionMethod,
  resultTexts: string[],
  focusedAutomationId: number,
  otherSpaceAutomationId: number,
): Array<Omit<AutomationTurnScript, 'calls'> & { calls: ScriptedToolCall[] }> {
  const scripts = automationTurnScripts(focusedAutomationId, otherSpaceAutomationId)
  const callCount = scripts.reduce((total, script) => total + script.calls.length, 0)
  if (method === 'chatgpt-subscription' && resultTexts.length !== callCount) {
    throw new Error('the subscription fixture needs one observed result per scripted call')
  }
  let resultIndex = 0
  return scripts.map((script) => ({
    ...script,
    calls: script.calls.map((call) => ({
      ...call,
      resultText: resultTexts[resultIndex++] ?? '',
    })),
  }))
}

function automationTurnScripts(
  focusedAutomationId: number,
  otherSpaceAutomationId: number,
): AutomationTurnScript[] {
  return [
    {
      key: 'create',
      input: 'list every Automation here, then arm a medication timer and a daily review',
      finalText: 'Created the focused Automations.',
      calls: [
        { toolName: 'list_automations', input: {} },
        {
          toolName: 'arm_timer',
          input: {
            when: '2026-08-24T21:00:00.000Z',
            action: 'Check medication',
          },
        },
        {
          toolName: 'create_job',
          input: { cron: '0 9 * * *', briefing: 'Review the plan' },
        },
      ],
    },
    {
      key: 'disable',
      input: 'disable the existing focused reminder',
      finalText: 'Disabled the focused Automation.',
      calls: [
        {
          toolName: 'set_automation_enabled',
          input: { automationId: focusedAutomationId, enabled: false },
        },
      ],
    },
    {
      key: 'cancel',
      input: 'cancel the existing focused reminder',
      finalText: 'Cancelled the focused Automation.',
      calls: [{ toolName: 'cancel', input: { automationId: focusedAutomationId } }],
    },
    {
      key: 'reject-other-space',
      input: 'disable the Automation with the supplied id',
      finalText: 'The other Space Automation was not changed.',
      calls: [
        {
          toolName: 'set_automation_enabled',
          input: { automationId: otherSpaceAutomationId, enabled: false },
          success: false,
        },
      ],
    },
  ]
}

function completedTurnText(events: AgentEvent[], key: AutomationTurnKey): string {
  const completed = events.filter((event) => event.type === 'turn-end').at(-1)
  if (!completed || completed.type !== 'turn-end') {
    throw new Error(`${key} turn produced no completion`)
  }
  return completed.text
}

function requireSurface(store: Store, surfaceId: string): Surface {
  const surface = store.getSurface(surfaceId)
  if (!surface) throw new Error(`missing Surface ${surfaceId}`)
  return SurfaceSchema.parse(surface)
}
