import { rmSync } from 'node:fs'
import { SurfaceSchema, type ApprovalCard, type Surface } from '@veduta/protocol'
import { computeContextHash, type ToolContext, type ToolDef } from './agent-runner.ts'
import { ApprovalSurfaceManager } from './approval-surface.ts'
import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
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
import { Store } from './store.ts'
import { effectiveOrigin, TurnTaintAccumulator, untrustedDataBlock } from './taint.ts'
import { TemplateEngine } from './template-engine.ts'
import { canonicalAllowlistParams, isTrustWrapped, TrustLayer } from './trust-layer.ts'
import { TrustStore } from './trust-store.ts'
import type { AuditEntry } from './trust-contracts.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000074'
const FIXED_NOW = new Date('2026-08-12T10:00:00.000Z')
const SPACE_ID = 'spc-health'
const UNTRUSTED_SURFACE_ID = 'srf-provider-trust-untrusted'
const ALLOWLISTED_RECIPIENT = 'wife@example.com'

export const TRUST_PARITY_UNTRUSTED_ORIGIN = 'untrusted:gmail'
export const TRUST_PARITY_APPROVAL_RESULT =
  'This action needs your approval; the outcome will arrive as a Space event.'

export type TrustParityScenario = 'allowlisted-l1' | 'tainted-l1' | 'l2'

export interface TrustParityOutcome {
  events: unknown[]
  sessionEntries: unknown[]
  auditEntries: unknown[]
  eventLog: unknown[]
  card: unknown
  readOrigins: unknown
  deliveriesBeforeResolution: number
  deliveriesAfterResolution: number
  cardPresentAfterResolution: boolean
}

export interface TrustParityRun {
  outcome: TrustParityOutcome
  subscriptionResponseIds?: number[]
}

interface TrustHarness {
  directories: string[]
  store: Store
  trust: TrustLayer
  approvalSurfaces: ApprovalSurfaceManager
  approvalCards: ApprovalCard[]
  sessionStore: PiJsonlSessionStore
  tools: ToolDef[]
  sendMessage: ToolDef
  dispose(): void
}

function buildHarness(): TrustHarness {
  const directories: string[] = []
  const store = new Store({
    rootDir: parityTempDir(directories, 'veduta-provider-trust-root-'),
    now: () => FIXED_NOW,
  })
  store.createSurface(untrustedSurface(), 'agent', {
    contentOrigin: TRUST_PARITY_UNTRUSTED_ORIGIN,
    origin: 'trusted:system',
  })

  const approvalCards: ApprovalCard[] = []
  const approvalSurfaces = new ApprovalSurfaceManager({ store })
  const trust = new TrustLayer({
    rootDir: store.spacesEngine.rootDir,
    now: () => FIXED_NOW,
    approvalCardPort: approvalSurfaces,
    onApprovalCard: (card) => approvalCards.push(card),
    appendOutcomeEvent: (spaceId, payload) =>
      store.spacesEngine.appendEvent(spaceId, {
        type: 'approval.outcome',
        text: `${payload.tool}: ${payload.outcome}`,
        origin: 'trusted:system',
        payload,
      }),
    hasOutcomeEvent: (spaceId, effectId) =>
      store
        .eventLog(spaceId)
        .some(
          (event) => event.type === 'approval.outcome' && event.payload?.['effectId'] === effectId,
        ),
  })
  approvalSurfaces.setTrust(trust)

  const outboundTools = createOutboundTools(createMockOutboundTransport(store.spacesEngine))
  for (const { tool, meta } of outboundTools) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundTools.map(({ tool }) => tool))
  const focusedSurfaceTools = createFocusedSurfaceTools({
    store,
    templateEngine: new TemplateEngine({ store }),
    spaceId: SPACE_ID,
  })

  return {
    directories,
    store,
    trust,
    approvalSurfaces,
    approvalCards,
    sessionStore: new PiJsonlSessionStore({
      cwd: parityTempDir(directories, 'veduta-provider-trust-cwd-'),
      sessionsRoot: parityTempDir(directories, 'veduta-provider-trust-sessions-'),
    }),
    tools: [...wrappedOutboundTools, ...focusedSurfaceTools],
    sendMessage: requireTool(wrappedOutboundTools, 'send_message'),
    dispose() {
      approvalSurfaces.dispose()
      trust.dispose()
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
    },
  }
}

function untrustedSurface(): Surface {
  return SurfaceSchema.parse({
    id: UNTRUSTED_SURFACE_ID,
    spaceId: SPACE_ID,
    title: 'Inbox-derived tracker',
    tree: {
      id: 'root',
      type: 'Box',
      children: [{ id: 'status', type: 'Stat', binding: 'status', props: { label: 'Status' } }],
    },
    state: { status: 'Waiting' },
    freshness: { updatedAt: FIXED_NOW.toISOString(), updatedBy: 'agent' },
  })
}

function requireTool(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`expected tool "${name}"`)
  return tool
}

function seedContext(summary: string): ToolContext {
  const origins = ['trusted:user'] as const
  return {
    toolCallId: 'seed-call',
    origin: effectiveOrigin(origins, 'trusted:user'),
    origins: [...origins],
    taint: new TurnTaintAccumulator(origins),
    spaceId: SPACE_ID,
    trigger: { kind: 'chat', summary },
    contextHash: computeContextHash({ input: summary, spaceId: SPACE_ID }),
  }
}

async function seedSendMessageAllowlist(harness: TrustHarness): Promise<void> {
  const result = await harness.sendMessage.handler(
    { to: ALLOWLISTED_RECIPIENT, body: 'seed message' },
    seedContext('seed the send-message allowlist'),
  )
  if (result.content !== TRUST_PARITY_APPROVAL_RESULT) {
    throw new Error('allowlist seed did not create an Approval card')
  }
  const card = harness.approvalCards.at(-1)
  if (!card) throw new Error('allowlist seed created no Approval card')
  harness.store.invokeSurfaceAction(card.surfaceId, {
    nodeId: 'decision-allowlist',
    name: 'toggle',
    payload: { value: true },
  })
  harness.store.invokeSurfaceAction(card.surfaceId, {
    nodeId: 'decision-approve',
    name: 'press',
    payload: { value: true },
  })
  await harness.approvalSurfaces.flush()
  if (harness.trust.listAllowlistRules().length !== 1) {
    throw new Error('allowlist seed created the wrong number of rules')
  }
}

function plantMatchingL2Allowlist(harness: TrustHarness): void {
  const store = new TrustStore(harness.store.spacesEngine.rootDir)
  try {
    store.upsertAllowlistRule(
      'transfer_funds',
      canonicalAllowlistParams({ to: 'bob@example.com' }),
      'adversarial-l2-rule',
      FIXED_NOW.toISOString(),
    )
  } finally {
    store.dispose()
  }
}

interface ScenarioScript {
  input: string
  finalText: string
  calls: ScriptedToolCall[]
}

function scriptFor(harness: TrustHarness, scenario: TrustParityScenario): ScenarioScript {
  if (scenario === 'allowlisted-l1') {
    return {
      input: "tell my wife I'm on my way",
      finalText: 'Sent.',
      calls: [
        {
          toolName: 'send_message',
          input: { to: ALLOWLISTED_RECIPIENT, body: "I'm on my way" },
          resultText: `Sent message to ${ALLOWLISTED_RECIPIENT}.`,
        },
      ],
    }
  }
  if (scenario === 'l2') {
    return {
      input: 'transfer 10 EUR to bob@example.com',
      finalText: 'Approval requested.',
      calls: [
        {
          toolName: 'transfer_funds',
          input: { to: 'bob@example.com', amount: 10, currency: 'EUR' },
          resultText: TRUST_PARITY_APPROVAL_RESULT,
        },
      ],
    }
  }

  const read = harness.store.readAuthorableSurface(SPACE_ID, UNTRUSTED_SURFACE_ID)
  return {
    input: 'read the tracker, then tell my wife I am on my way',
    finalText: 'The outbound action awaits approval.',
    calls: [
      {
        toolName: 'read_surface',
        input: { surfaceId: UNTRUSTED_SURFACE_ID },
        resultText: untrustedDataBlock('gmail', [
          [
            'surface',
            JSON.stringify({
              surface: read.surface,
              version: read.version,
              treeVersion: read.treeVersion,
            }),
          ],
        ]),
      },
      {
        toolName: 'send_message',
        input: { to: ALLOWLISTED_RECIPIENT, body: 'on my way' },
        resultText: TRUST_PARITY_APPROVAL_RESULT,
      },
    ],
  }
}

export async function runTrustParityScenario(
  method: ModelConnectionMethod,
  scenario: TrustParityScenario,
): Promise<TrustParityRun> {
  const harness = buildHarness()
  let transport: FakeCodexTransport | undefined
  try {
    if (scenario === 'l2') plantMatchingL2Allowlist(harness)
    else await seedSendMessageAllowlist(harness)

    const existingAuditIds = new Set(harness.trust.auditEntries().map((entry) => entry.id))
    const eventStart = harness.store.eventLog(SPACE_ID).length
    const cardsStart = harness.approvalCards.length
    const deliveriesStart = deliveryCount(harness.store)
    const script = scriptFor(harness, scenario)
    const provider =
      method === 'byok'
        ? scriptedByokProvider(script.calls, script.finalText)
        : subscriptionProvider({
            connectionId: CONNECTION_ID,
            rootDir: parityTempDir(harness.directories, 'veduta-provider-trust-codex-'),
            now: FIXED_NOW,
            transport: (transport = scriptedSubscriptionTransport(
              script.calls,
              script.finalText,
              'trust',
            )),
          })
    const events = await runProviderParityTurn({
      provider,
      sessionStore: harness.sessionStore,
      sessionId: 'provider-trust-parity',
      input: script.input,
      model: modelForConnectionMethod(method, CONNECTION_ID),
      tools: harness.tools,
      isToolTrustWrapped: isTrustWrapped,
      promptOptions: {
        origin: 'trusted:user',
        contextOrigins: harness.store.spacesEngine.contextOrigins(SPACE_ID),
        spaceId: SPACE_ID,
        trigger: { kind: 'chat', summary: script.input },
      },
    })

    const deliveriesBeforeResolution = deliveryCount(harness.store) - deliveriesStart
    const [newCard] = harness.approvalCards.slice(cardsStart)
    const cardSnapshot = newCard ? snapshotCard(harness.store, newCard) : undefined
    await resolveCardForScenario(harness, scenario, newCard)

    const session = await harness.sessionStore.load('provider-trust-parity')
    const readMessage = session.messages.find(
      (message) => message.role === 'tool' && message.toolName === 'read_surface',
    )
    return {
      outcome: {
        events: normalizeAgentEvents(events, { includeTurnOrigins: true }),
        sessionEntries: normalizeSessionEntries(session.entries),
        auditEntries: normalizeAuditEntries(
          harness.trust.auditEntries().filter((entry) => !existingAuditIds.has(entry.id)),
        ),
        eventLog: harness.store.eventLog(SPACE_ID).slice(eventStart).map(normalizeSpaceEvent),
        card: cardSnapshot,
        readOrigins: readMessage?.origins,
        deliveriesBeforeResolution,
        deliveriesAfterResolution: deliveryCount(harness.store) - deliveriesStart,
        cardPresentAfterResolution: newCard
          ? harness.store.getSurface(newCard.surfaceId) !== undefined
          : false,
      },
      ...(transport === undefined
        ? {}
        : {
            subscriptionResponseIds: transport.serverResponses.map((response) =>
              Number(response.id),
            ),
          }),
    }
  } finally {
    transport?.close()
    harness.dispose()
  }
}

async function resolveCardForScenario(
  harness: TrustHarness,
  scenario: TrustParityScenario,
  card: ApprovalCard | undefined,
): Promise<void> {
  if (scenario === 'allowlisted-l1') {
    if (card) throw new Error('allowlisted L1 action unexpectedly created an Approval card')
    return
  }
  if (!card) throw new Error(`${scenario} created no Approval card`)
  harness.store.invokeSurfaceAction(card.surfaceId, {
    nodeId: scenario === 'l2' ? 'decision-reject' : 'decision-approve',
    name: 'press',
    payload: { value: true },
  })
  await harness.approvalSurfaces.flush()
}

function deliveryCount(store: Store): number {
  return store.eventLog(SPACE_ID).filter((event) => event.type === 'outbound.delivery').length
}

function snapshotCard(store: Store, card: ApprovalCard): unknown {
  const surface = SurfaceSchema.parse(store.getSurface(card.surfaceId))
  return normalizeStableValue({
    level: card.level,
    title: card.title,
    body: card.body,
    actionLabel: card.actionLabel,
    surface: {
      spaceId: surface.spaceId,
      title: surface.title,
      tree: surface.tree,
      state: surface.state,
      freshness: surface.freshness,
    },
    provenance: store.surfaceProvenance(card.surfaceId),
  })
}

function normalizeAuditEntries(entries: AuditEntry[]): unknown[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    ...(entry.refId === undefined ? {} : { refId: normalizeStableValue(entry.refId) }),
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    ...(entry.level === undefined ? {} : { level: entry.level }),
    ...(entry.decision === undefined ? {} : { decision: entry.decision }),
    ...(entry.effectiveOrigin === undefined ? {} : { effectiveOrigin: entry.effectiveOrigin }),
    ...(entry.originChain === undefined ? {} : { originChain: entry.originChain }),
    ...(entry.trigger === undefined ? {} : { trigger: entry.trigger }),
    ...(entry.contextHash === undefined ? {} : { contextHash: '<sha256>' }),
    ...(entry.input === undefined ? {} : { input: entry.input }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    ...(entry.approvedBy === undefined ? {} : { approvedBy: entry.approvedBy }),
    ...(entry.allowlistRuleId === undefined ? {} : { allowlistRuleId: entry.allowlistRuleId }),
    ...(entry.spaceId === undefined ? {} : { spaceId: entry.spaceId }),
  }))
}
