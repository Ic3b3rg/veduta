import { rmSync } from 'node:fs'
import {
  SurfaceSchema,
  SurfaceTemplateSchema,
  type Surface,
  type SurfaceTemplate,
} from '@veduta/protocol'
import type { AgentEvent, ToolDef } from './agent-runner.ts'
import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
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
import { Store } from './store.ts'
import type { SurfaceProvenance } from './surface-engine.ts'
import { templateTools, TemplateEngine } from './template-engine.ts'
import type { Origin } from './taint.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000076'
const FIXED_NOW = new Date('2026-08-13T11:00:00.000Z')
const FINAL_TEXT = 'Template reused and composition preserved.'
const SOURCE_SURFACE_ID = 'srf-template-library-source'

export const SOURCE_SPACE_ID = 'spc-template-library'
export const DESTINATION_SPACE_ID = 'spc-reading-plans'
export const REUSED_SURFACE_ID = 'srf-weekly-reading-reused'
export const DIRECT_SURFACE_ID = 'srf-weekly-reading-direct'
export const TEMPLATE_PARITY_UNTRUSTED_ORIGIN = 'untrusted:template-import'
export const TEMPLATE_JUSTIFICATION =
  'This version needs an independently evolving composition for the weekly review.'

const SOURCE_TEMPLATE_TITLE = 'Reading progress tracker'
const REUSED_SURFACE_TITLE = 'Weekly reading tracker'
const TEMPLATE_TREE: Surface['tree'] = {
  id: 'root',
  type: 'Box',
  children: [
    { id: 'title', type: 'Title', props: { text: SOURCE_TEMPLATE_TITLE } },
    { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
    {
      id: 'done',
      type: 'Checkbox',
      binding: 'finished',
      props: { label: 'Finished' },
      actions: [{ name: 'toggle', path: 'fast', stateKey: 'finished', payload: {} }],
    },
  ],
}

export interface TemplateParityToolResult {
  toolName: string
  content: string
  details?: unknown
  origin?: Origin
  origins?: Origin[]
}

export interface TemplateParityOutcome {
  offeredDefinitions: ProviderToolDefinition[]
  events: unknown[]
  sessionEntries: unknown[]
  toolResults: TemplateParityToolResult[]
  sourceTemplate: SurfaceTemplate
  reusedSurface: Surface
  reusedProvenance: SurfaceProvenance
  directSurface: Surface
  directProvenance: SurfaceProvenance
  destinationTemplates: SurfaceTemplate[]
  eventLog: unknown[]
  taintBeforeCalls: Array<{ toolName: string; origins: Origin[] }>
  directSurfaceExistsAfterCalls: boolean[]
  handlerExecution: {
    total: number
    distinctCallIds: number
    maxCallsPerId: number
    allContextHashesValid: boolean
    byTool: Record<string, number>
  }
}

interface TemplateParityRun {
  outcome: TemplateParityOutcome
  toolResultTexts: string[]
  acceptedCallIds: string[]
  handlerCallIds: string[]
  transport?: SubscriptionTransportObservation
}

interface TemplateParityPair {
  byok: Pick<
    TemplateParityRun,
    'outcome' | 'toolResultTexts' | 'acceptedCallIds' | 'handlerCallIds'
  >
  subscription: TemplateParityRun & { transport: NonNullable<TemplateParityRun['transport']> }
}

interface HandlerObservation {
  toolName: string
  toolCallId: string
  origins: Origin[]
  contextHash: string
}

interface TemplateHarness {
  directories: string[]
  store: Store
  sessionStore: PiJsonlSessionStore
  tools: ToolDef[]
  sourceTemplate: SurfaceTemplate
  eventStart: number
  handlerObservations: HandlerObservation[]
  directSurfaceExistsAfterCalls: boolean[]
  dispose(): void
}

export async function runTemplateParityPair(): Promise<TemplateParityPair> {
  const byok = await runTemplateParityScenario('byok')
  const subscription = await runTemplateParityScenario('chatgpt-subscription', byok.toolResultTexts)
  if (!subscription.transport) throw new Error('subscription scenario produced no transport data')
  return {
    byok: {
      outcome: byok.outcome,
      toolResultTexts: byok.toolResultTexts,
      acceptedCallIds: byok.acceptedCallIds,
      handlerCallIds: byok.handlerCallIds,
    },
    subscription: { ...subscription, transport: subscription.transport },
  }
}

async function runTemplateParityScenario(
  method: ModelConnectionMethod,
  expectedResultTexts: string[] = [],
): Promise<TemplateParityRun> {
  const harness = buildHarness()
  const byokDefinitionSets: ProviderToolDefinition[][] = []
  let transport: FakeCodexTransport | undefined
  try {
    const scriptedCalls = callsWithResultTexts(
      method,
      expectedResultTexts,
      harness.sourceTemplate.id,
    )
    const provider =
      method === 'byok'
        ? captureProviderDefinitions(
            scriptedByokProvider(scriptedCalls, FINAL_TEXT),
            byokDefinitionSets,
          )
        : subscriptionProvider({
            connectionId: CONNECTION_ID,
            rootDir: parityTempDir(harness.directories, 'veduta-provider-template-codex-'),
            now: FIXED_NOW,
            transport: (transport = scriptedSubscriptionTransport(
              scriptedCalls,
              FINAL_TEXT,
              'template',
            )),
          })

    const events = await runProviderParityTurn({
      provider,
      sessionStore: harness.sessionStore,
      sessionId: 'provider-template-parity',
      input: 'reuse the reading Template, pin it, and create the justified variant',
      model: modelForConnectionMethod(method, CONNECTION_ID),
      tools: harness.tools,
      promptOptions: {
        origin: 'trusted:user',
        spaceId: DESTINATION_SPACE_ID,
        trigger: { kind: 'chat', summary: 'reuse and pin a Template' },
      },
    })

    const session = await harness.sessionStore.load('provider-template-parity')
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

    const result: TemplateParityRun = {
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
        sourceTemplate: SurfaceTemplateSchema.parse(harness.sourceTemplate),
        reusedSurface: requireSurface(harness.store, REUSED_SURFACE_ID),
        reusedProvenance: requireProvenance(harness.store, REUSED_SURFACE_ID),
        directSurface: requireSurface(harness.store, DIRECT_SURFACE_ID),
        directProvenance: requireProvenance(harness.store, DIRECT_SURFACE_ID),
        destinationTemplates: harness.store.spacesEngine
          .listTemplates(DESTINATION_SPACE_ID)
          .map((template) => SurfaceTemplateSchema.parse(template)),
        eventLog: harness.store
          .eventLog(DESTINATION_SPACE_ID)
          .slice(harness.eventStart)
          .map(normalizeSpaceEvent),
        taintBeforeCalls: harness.handlerObservations.map((observation) => ({
          toolName: observation.toolName,
          origins: observation.origins,
        })),
        directSurfaceExistsAfterCalls: harness.directSurfaceExistsAfterCalls,
        handlerExecution: handlerExecution(harness.handlerObservations),
      },
      toolResultTexts,
      acceptedCallIds: acceptedToolCallIds(events),
      handlerCallIds: harness.handlerObservations.map((observation) => observation.toolCallId),
      ...(transport === undefined ? {} : { transport: observeSubscriptionTransport(transport) }),
    }
    return result
  } finally {
    transport?.close()
    harness.dispose()
  }
}

function buildHarness(): TemplateHarness {
  const directories: string[] = []
  const store = new Store({
    rootDir: parityTempDir(directories, 'veduta-provider-template-root-'),
    now: () => FIXED_NOW,
  })
  const sourceSpace = store.spacesEngine.createSpace({ name: 'Template Library' })
  const destinationSpace = store.spacesEngine.createSpace({ name: 'Reading Plans' })
  if (sourceSpace.id !== SOURCE_SPACE_ID || destinationSpace.id !== DESTINATION_SPACE_ID) {
    throw new Error('Template parity fixture produced unexpected Space ids')
  }

  const sourceSurface = SurfaceSchema.parse({
    id: SOURCE_SURFACE_ID,
    spaceId: SOURCE_SPACE_ID,
    title: SOURCE_TEMPLATE_TITLE,
    tree: TEMPLATE_TREE,
    state: { progress: 20, finished: false },
    freshness: { updatedAt: FIXED_NOW.toISOString(), updatedBy: 'agent' },
  })
  store.createSurface(sourceSurface, 'agent', {
    origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
    contentOrigin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
  })

  const templateEngine = new TemplateEngine({ store, now: () => FIXED_NOW })
  const { template: sourceTemplate } = templateEngine.pin(SOURCE_SURFACE_ID, true, {
    origin: 'trusted:user',
    updatedBy: 'user',
  })
  if (!sourceTemplate) throw new Error('Template parity fixture failed to seed its Template')

  const handlerObservations: HandlerObservation[] = []
  const directSurfaceExistsAfterCalls: boolean[] = []
  const tools = observeDirectSurfaceExistence(
    trackHandlerCalls(
      [
        ...createFocusedSurfaceTools({
          store,
          templateEngine,
          spaceId: DESTINATION_SPACE_ID,
        }),
        ...templateTools(templateEngine, { activeSpaceId: DESTINATION_SPACE_ID }),
      ],
      handlerObservations,
    ),
    store,
    directSurfaceExistsAfterCalls,
  )

  return {
    directories,
    store,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-template-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-template-sessions-'),
    }),
    tools,
    sourceTemplate,
    eventStart: store.eventLog(DESTINATION_SPACE_ID).length,
    handlerObservations,
    directSurfaceExistsAfterCalls,
    dispose() {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

function trackHandlerCalls(tools: ToolDef[], observations: HandlerObservation[]): ToolDef[] {
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

function observeDirectSurfaceExistence(
  tools: ToolDef[],
  store: Store,
  observations: boolean[],
): ToolDef[] {
  return tools.map((tool) => {
    if (tool.name !== 'create_surface') return tool
    return {
      ...tool,
      async handler(input, context) {
        const result = await tool.handler(input, context)
        observations.push(store.getSurface(DIRECT_SURFACE_ID) !== undefined)
        return result
      },
    }
  })
}

function acceptedToolCallIds(events: AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'tool-start' ? [event.toolCallId] : []))
}

function callsWithResultTexts(
  method: ModelConnectionMethod,
  resultTexts: string[],
  sourceTemplateId: string,
): ScriptedToolCall[] {
  const calls: Array<Omit<ScriptedToolCall, 'resultText'>> = [
    {
      toolName: 'list_templates',
      input: { intent: SOURCE_TEMPLATE_TITLE },
    },
    {
      toolName: 'create_surface_from_template',
      input: {
        templateId: sourceTemplateId,
        templateSpaceId: SOURCE_SPACE_ID,
        surfaceId: REUSED_SURFACE_ID,
        title: REUSED_SURFACE_TITLE,
        state: { progress: 60, finished: false },
      },
    },
    {
      toolName: 'pin_surface',
      input: { surfaceId: REUSED_SURFACE_ID, pinned: true },
    },
    {
      toolName: 'create_surface',
      input: directSurfaceInput(),
    },
    {
      toolName: 'create_surface',
      input: { ...directSurfaceInput(), justification: TEMPLATE_JUSTIFICATION },
    },
  ]

  if (method === 'chatgpt-subscription' && resultTexts.length !== calls.length) {
    throw new Error('the subscription fixture needs one observed result per scripted call')
  }
  return calls.map((call, index) => ({ ...call, resultText: resultTexts[index] ?? '' }))
}

function directSurfaceInput(): Record<string, unknown> {
  return {
    id: DIRECT_SURFACE_ID,
    title: REUSED_SURFACE_TITLE,
    intent: REUSED_SURFACE_TITLE,
    tree: TEMPLATE_TREE,
    state: { progress: 0, finished: false },
  }
}

function requireSurface(store: Store, surfaceId: string): Surface {
  const surface = store.getSurface(surfaceId)
  if (!surface) throw new Error(`missing Surface ${surfaceId}`)
  return SurfaceSchema.parse(surface)
}

function requireProvenance(store: Store, surfaceId: string): SurfaceProvenance {
  const provenance = store.surfaceProvenance(surfaceId)
  if (!provenance) throw new Error(`missing provenance for Surface ${surfaceId}`)
  return provenance
}

function handlerExecution(
  observations: HandlerObservation[],
): TemplateParityOutcome['handlerExecution'] {
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
