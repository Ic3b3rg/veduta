import { rmSync } from 'node:fs'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
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
const FIXED_NOW = new Date('2026-08-24T09:00:00.000Z')
const FINAL_TEXT = 'Focused Automations managed.'

export const AUTOMATION_PARITY_SPACE_ID = 'spc-health'
export const AUTOMATION_PARITY_OTHER_SPACE_ID = 'spc-other-space'
export const AUTOMATION_PARITY_UNTRUSTED_ORIGIN = 'untrusted:gmail'

export interface AutomationParityToolResult {
  toolName: string
  content: string
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
}

interface AutomationParityRun {
  outcome: AutomationParityOutcome
  toolResultTexts: string[]
  transport?: SubscriptionTransportObservation
}

interface AutomationParityPair {
  byok: Pick<AutomationParityRun, 'outcome' | 'toolResultTexts'>
  subscription: AutomationParityRun & {
    transport: NonNullable<AutomationParityRun['transport']>
  }
}

interface AutomationHarness {
  directories: string[]
  store: Store
  scheduler: Scheduler
  sessionStore: PiJsonlSessionStore
  focusedAutomationId: number
  eventStart: number
  dispose(): void
}

export async function runAutomationParityPair(): Promise<AutomationParityPair> {
  const byok = await runAutomationParityScenario('byok')
  const subscription = await runAutomationParityScenario(
    'chatgpt-subscription',
    byok.toolResultTexts,
  )
  if (!subscription.transport) throw new Error('subscription scenario produced no transport data')
  return {
    byok: { outcome: byok.outcome, toolResultTexts: byok.toolResultTexts },
    subscription: { ...subscription, transport: subscription.transport },
  }
}

async function runAutomationParityScenario(
  method: ModelConnectionMethod,
  expectedResultTexts: string[] = [],
): Promise<AutomationParityRun> {
  const harness = buildHarness()
  const tools = createFocusedAutomationTools({
    scheduler: harness.scheduler,
    spaceId: AUTOMATION_PARITY_SPACE_ID,
  })
  const scriptedCalls = callsWithResultTexts(
    method,
    expectedResultTexts,
    harness.focusedAutomationId,
  )
  const byokDefinitionSets: ProviderToolDefinition[][] = []
  let transport: FakeCodexTransport | undefined

  try {
    const provider =
      method === 'byok'
        ? captureProviderDefinitions(
            scriptedByokProvider(scriptedCalls, FINAL_TEXT),
            byokDefinitionSets,
          )
        : subscriptionProvider({
            connectionId: CONNECTION_ID,
            rootDir: parityTempDir(harness.directories, 'veduta-provider-automation-codex-'),
            now: FIXED_NOW,
            transport: (transport = scriptedSubscriptionTransport(
              scriptedCalls,
              FINAL_TEXT,
              'automation',
            )),
          })

    const events = await runProviderParityTurn({
      provider,
      sessionStore: harness.sessionStore,
      sessionId: 'provider-automation-parity',
      input: 'inspect and manage every Automation in this Space',
      model: modelForConnectionMethod(method, CONNECTION_ID),
      tools,
      promptOptions: {
        origin: AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
        spaceId: AUTOMATION_PARITY_SPACE_ID,
        trigger: { kind: 'chat', summary: 'manage focused Automations' },
      },
    })

    const session = await harness.sessionStore.load('provider-automation-parity')
    const toolMessages = session.messages.filter((message) => message.role === 'tool')
    if (toolMessages.length !== scriptedCalls.length) {
      throw new Error(
        `expected ${scriptedCalls.length} tool results, received ${toolMessages.length}`,
      )
    }
    const toolResultTexts = toolMessages.map((message) => message.content)
    const offeredDefinitions =
      method === 'byok'
        ? consistentProviderDefinitions(byokDefinitionSets)
        : subscriptionDefinitions(requireTransport(transport))

    const result: AutomationParityRun = {
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
        focusedAutomations: harness.scheduler.listAutomations(AUTOMATION_PARITY_SPACE_ID),
        otherSpaceAutomations: harness.scheduler.listAutomations(AUTOMATION_PARITY_OTHER_SPACE_ID),
        automationsSurface: requireSurface(harness.store, 'srf-health-automations'),
        eventLog: harness.store
          .eventLog(AUTOMATION_PARITY_SPACE_ID)
          .slice(harness.eventStart)
          .map(normalizeSpaceEvent),
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

function buildHarness(): AutomationHarness {
  const directories: string[] = []
  const rootDir = parityTempDir(directories, 'veduta-provider-automation-root-')
  const store = new Store({ rootDir, now: () => FIXED_NOW })
  const otherSpace = store.spacesEngine.createSpace({ name: 'Other Space' })
  if (otherSpace.id !== AUTOMATION_PARITY_OTHER_SPACE_ID) {
    throw new Error('Automation parity fixture produced an unexpected other-Space id')
  }
  const scheduler = new Scheduler({ rootDir, store, now: () => FIXED_NOW })
  scheduler.armTimer({
    spaceId: AUTOMATION_PARITY_OTHER_SPACE_ID,
    when: '2026-08-24T22:00:00.000Z',
    action: 'Other Space reminder',
  })
  const focused = scheduler.armTimer({
    spaceId: AUTOMATION_PARITY_SPACE_ID,
    when: '2026-08-24T20:00:00.000Z',
    action: 'Existing focused reminder',
  })

  return {
    directories,
    store,
    scheduler,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-automation-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-automation-sessions-'),
    }),
    focusedAutomationId: focused.id,
    eventStart: store.eventLog(AUTOMATION_PARITY_SPACE_ID).length,
    dispose() {
      scheduler.stop()
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

function callsWithResultTexts(
  method: ModelConnectionMethod,
  resultTexts: string[],
  focusedAutomationId: number,
): ScriptedToolCall[] {
  const calls: Array<Omit<ScriptedToolCall, 'resultText'>> = [
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
    {
      toolName: 'set_automation_enabled',
      input: { automationId: focusedAutomationId, enabled: false },
    },
    { toolName: 'cancel', input: { automationId: focusedAutomationId } },
  ]
  if (method === 'chatgpt-subscription' && resultTexts.length !== calls.length) {
    throw new Error('the subscription fixture needs one observed result per scripted call')
  }
  return calls.map((call, index) => ({ ...call, resultText: resultTexts[index] ?? '' }))
}

function requireSurface(store: Store, surfaceId: string): Surface {
  const surface = store.getSurface(surfaceId)
  if (!surface) throw new Error(`missing Surface ${surfaceId}`)
  return SurfaceSchema.parse(surface)
}

function requireTransport(transport: FakeCodexTransport | undefined): FakeCodexTransport {
  if (!transport) throw new Error('subscription scenario created no Codex transport')
  return transport
}
