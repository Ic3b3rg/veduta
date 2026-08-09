import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalCard, GatewayServerMessage } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { computeContextHash, type ToolContext, type ToolDef } from './agent-runner.ts'
import { ApprovalSurfaceManager } from './approval-surface.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { createChatLoop, type ChatLoop } from './chat-loop.ts'
import { createFakeProvider, fakeText, fakeToolCall } from './fake-provider.ts'
import { createMemoryTools } from './memory-tools.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import { Store } from './store.ts'
import { effectiveOrigin, TurnTaintAccumulator, untrustedOrigin, type Origin } from './taint.ts'
import { canonicalAllowlistParams, isTrustWrapped, TrustLayer } from './trust-layer.ts'

/**
 * Issue #37's AC2 ("Trust matrix on a live turn"), proved through the real
 * chat loop (chat-loop.ts) driven by `createFakeProvider()`, with a REAL
 * `TrustLayer`-wrapped outbound registry — the same wiring `server.ts`
 * builds, copied here rather than imported because `server.ts` builds it
 * inline as part of `buildServer`. This complements
 * trust-acceptance.test.ts (issue #14's own acceptance, proved end-to-end
 * through `buildServer` with the deterministic mock provider): that harness
 * cannot script a turn that calls a read tool and an outbound tool in the
 * same turn, because the mock chat model (`mock-chat-model.ts`) always
 * answers with at most one tool call per user message. Case (b) below needs
 * exactly that multi-step sequence, which only the fake provider's scripted
 * step queue can produce — proof that a turn's mid-turn taint growth (a real
 * `read_recent` call surfacing an untrusted event, not a hand-seeded
 * `TurnTaint`) gates a later call in the SAME turn, through the actual
 * `PiAgentRunner` sequential tool execution (issue #14's decision matrix
 * lives in `trust-layer.ts`'s `decide()`; this file only proves the chat
 * loop wires it in correctly end-to-end).
 */

interface Harness {
  store: Store
  router: ModelRouter
  trust: TrustLayer
  approvalSurfaces: ApprovalSurfaceManager
  fake: ReturnType<typeof createFakeProvider>
  chatLoop: ChatLoop
  approvalCards: ApprovalCard[]
  frames: { clientId: string; frame: GatewayServerMessage }[]
  spaceId: string
  wrappedSendMessage: ToolDef
  cleanup: () => void
}

function buildHarness(): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-chat-trust-root-'))
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'veduta-chat-trust-sessions-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veduta-chat-trust-cwd-'))

  const store = new Store({ rootDir })
  const spaceId = store.listSpaces()[0]!.id

  const fake = createFakeProvider()
  const config: RoutingConfig = {
    tiers: {
      reasoning: [{ provider: 'fake', modelId: 'fake-model' }],
      triage: [{ provider: 'fake', modelId: 'fake-model' }],
    },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 20 },
  }
  const router = new ModelRouter({ config, rootDir, sleep: async () => {} })
  const sessionStore = new PiJsonlSessionStore({ cwd, sessionsRoot })

  // Trust wiring mirrors server.ts exactly (approvalSurfaces + TrustLayer +
  // outbound tools registered then wrapped), same rationale
  // trust-acceptance.test.ts's `buildDirectHarness` gives for its own copy.
  const approvalCards: ApprovalCard[] = []
  const approvalSurfaces = new ApprovalSurfaceManager({ store })
  const trust = new TrustLayer({
    rootDir: store.spacesEngine.rootDir,
    approvalCardPort: approvalSurfaces,
    onApprovalCard: (card) => approvalCards.push(card),
    appendOutcomeEvent: (sid, payload) =>
      store.spacesEngine.appendEvent(sid, {
        type: 'approval.outcome',
        text: `${payload.tool}: ${payload.outcome}`,
        // Daemon-produced, never `trusted:user` — same rule taint.ts's
        // `toolWriteOrigin` doc describes, mirrored from server.ts.
        origin: 'trusted:system',
        payload,
      }),
  })
  approvalSurfaces.setTrust(trust)

  const outboundTransport = createMockOutboundTransport(store.spacesEngine)
  const outboundTools = createOutboundTools(outboundTransport)
  for (const { tool, meta } of outboundTools) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundTools.map(({ tool }) => tool))
  const wrappedSendMessage = wrappedOutboundTools.find((tool) => tool.name === 'send_message')
  if (!wrappedSendMessage) throw new Error('expected wrapTools to return a wrapped send_message')

  const frames: { clientId: string; frame: GatewayServerMessage }[] = []
  const chatLoop = createChatLoop({
    store,
    router,
    sessionStore,
    bridge: fake,
    isTrustWrapped,
    toolsFor: (sid) =>
      sid === undefined
        ? []
        : [
            ...wrappedOutboundTools,
            ...createMemoryTools(store.spacesEngine, { activeSpaceId: sid }),
          ],
    send: (clientId, frame) => frames.push({ clientId, frame }),
  })

  return {
    store,
    router,
    trust,
    approvalSurfaces,
    fake,
    chatLoop,
    approvalCards,
    frames,
    spaceId,
    wrappedSendMessage,
    cleanup: () => {
      approvalSurfaces.dispose()
      trust.dispose()
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(sessionsRoot, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

/** Mirrors `pi-agent-runner.ts`'s `buildToolContext`, same as trust-acceptance.test.ts's own helper — used only to seed the allowlist rule with a direct, untainted tool call outside the chat loop. */
function buildTurnContext(
  store: Store,
  spaceId: string,
  summary: string,
): { context: ToolContext; taint: TurnTaintAccumulator } {
  const seed: Origin[] = ['trusted:user', ...store.spacesEngine.contextOrigins(spaceId)]
  const taint = new TurnTaintAccumulator(seed)
  const context: ToolContext = {
    toolCallId: randomUUID(),
    origin: effectiveOrigin(seed, 'trusted:user'),
    origins: seed,
    taint,
    spaceId,
    trigger: { kind: 'chat', summary },
    contextHash: computeContextHash({ input: summary, spaceId }),
  }
  return { context, taint }
}

/** Establishes an active allowlist rule for `send_message` -> `to`, the ordinary way: an untainted direct call, approved with the allowlist checkbox checked. */
async function seedSendMessageAllowlist(h: Harness, to: string): Promise<void> {
  const { context } = buildTurnContext(h.store, h.spaceId, `seed allowlist for ${to}`)
  const seedResult = await h.wrappedSendMessage.handler({ to, body: 'seed message' }, context)
  expect(seedResult.content).toMatch(/needs your approval/)
  const surfaceId = h.approvalCards.at(-1)?.surfaceId
  if (!surfaceId) throw new Error('expected a seed card surface to have been created')
  h.store.invokeSurfaceAction(surfaceId, {
    nodeId: 'decision-allowlist',
    name: 'toggle',
    payload: { value: true },
  })
  h.store.invokeSurfaceAction(surfaceId, {
    nodeId: 'decision-approve',
    name: 'press',
    payload: { value: true },
  })
  await h.approvalSurfaces.flush()
}

function chatEvent(
  overrides: Partial<NormalizedChannelEvent> & { text: string },
): NormalizedChannelEvent {
  return { adapterId: 'pwa', clientId: 'c1', receivedAt: new Date().toISOString(), ...overrides }
}

function deliveryCount(h: Harness): number {
  return h.store.eventLog(h.spaceId).filter((event) => event.type === 'outbound.delivery').length
}

describe('chat loop x trust layer — the live-turn trust matrix (issue #37 AC2)', () => {
  const harnesses: Harness[] = []
  function harness(): Harness {
    const built = buildHarness()
    harnesses.push(built)
    return built
  }

  afterEach(() => {
    for (const built of harnesses.splice(0)) built.cleanup()
  })

  it('a trusted turn + allowlisted L1 send_message executes with no card', async () => {
    const h = harness()
    await seedSendMessageAllowlist(h, 'wife@example.com')
    expect(h.trust.listAllowlistRules()).toHaveLength(1)

    const cardsBefore = h.approvalCards.length
    const deliveriesBefore = deliveryCount(h)

    h.fake.setResponses([
      { message: fakeToolCall('send_message', { to: 'wife@example.com', body: "I'm on my way" }) },
      { message: fakeText('Sent.') },
    ])
    await h.chatLoop.handleChatMessage(
      chatEvent({ text: "tell my wife I'm on my way", spaceId: h.spaceId }),
    )

    // No new approval card: the allowlist rule auto-executed the call.
    expect(h.approvalCards).toHaveLength(cardsBefore)
    expect(deliveryCount(h)).toBe(deliveriesBefore + 1)
    expect(h.frames.at(-1)!.frame).toMatchObject({ type: 'chat.turn-end' })

    const allowedDecision = h.trust
      .auditEntries()
      .find(
        (entry) =>
          entry.kind === 'action.decision' &&
          entry.decision === 'allowed' &&
          entry.toolName === 'send_message',
      )
    expect(allowedDecision).toBeDefined()
    expect(allowedDecision?.effectiveOrigin).toBe('trusted:user')
    expect(allowedDecision?.trigger?.kind).toBe('chat')
    expect(allowedDecision?.contextHash).toBeTruthy()
    const linkedOutcome = h.trust
      .auditEntries()
      .find((entry) => entry.kind === 'action.outcome' && entry.refId === allowedDecision?.refId)
    expect(linkedOutcome?.outcome).toBe('executed')
  })

  it('mid-turn taint from a real read_recent call cards an otherwise-allowlisted send_message', async () => {
    const h = harness()
    await seedSendMessageAllowlist(h, 'wife@example.com')
    expect(h.trust.listAllowlistRules()).toHaveLength(1)

    // Baseline: an untainted repeat auto-executes — proves the rule works
    // before the tainted case below is attempted.
    h.fake.setResponses([
      {
        message: fakeToolCall('send_message', { to: 'wife@example.com', body: 'still on my way' }),
      },
      { message: fakeText('Sent.') },
    ])
    await h.chatLoop.handleChatMessage(chatEvent({ text: 'still on my way', spaceId: h.spaceId }))
    // One delivery from approving the seed card above, one from this
    // untainted repeat.
    expect(deliveryCount(h)).toBe(2)

    // The event `read_recent` will surface: a stored event with an untrusted
    // origin, appended directly (the same shape the real quarantined reader
    // would leave behind, e.g. `reader.summary` — see quarantined-reader.ts).
    h.store.spacesEngine.appendEvent(h.spaceId, {
      type: 'reader.summary',
      text: 'a message from an external inbox asking for a favor',
      origin: untrustedOrigin('gmail'),
    })

    const cardsBefore = h.approvalCards.length
    const deliveriesBefore = deliveryCount(h)

    // Scripted as two tool calls in ONE turn: `read_recent` first (its
    // ToolResult reports the untrusted origin, folded live into the turn's
    // taint accumulator — memory-tools.ts's `eventOrigins` /
    // pi-agent-runner.ts's `toPiAgentTool`), then `send_message` — the
    // allowlisted recipient from above, in the same turn, after the taint
    // has grown.
    h.fake.setResponses([
      { message: fakeToolCall('read_recent', {}) },
      { message: fakeToolCall('send_message', { to: 'wife@example.com', body: 'on my way' }) },
      { message: fakeText('Noted, and sent.') },
    ])
    await h.chatLoop.handleChatMessage(
      chatEvent({
        text: 'check recent notes, then tell my wife I am on my way',
        spaceId: h.spaceId,
      }),
    )

    // A NEW card, despite the standing allowlist rule: the mid-turn taint
    // overrides it entirely, exactly like AC1(c)'s hand-seeded case.
    expect(h.approvalCards).toHaveLength(cardsBefore + 1)
    // Nothing new delivered — the tainted attempt never executed.
    expect(deliveryCount(h)).toBe(deliveriesBefore)

    const taintedOrigin = untrustedOrigin('gmail')
    const cardDecision = h.trust
      .auditEntries()
      .find(
        (entry) =>
          entry.kind === 'action.decision' &&
          entry.decision === 'card' &&
          entry.toolName === 'send_message' &&
          entry.originChain?.includes(taintedOrigin),
      )
    expect(cardDecision).toBeDefined()
    expect(cardDecision?.effectiveOrigin).toBe(taintedOrigin)
    expect(cardDecision?.trigger?.kind).toBe('chat')
  })

  it('an L2 transfer_funds call always cards, even on a fully trusted turn with a matching allowlist rule planted for it', async () => {
    const h = harness()

    // Adversarial per trust-acceptance.test.ts's AC2(b): the public API has
    // no way to create an allowlist rule for an L2 tool (no checkbox is ever
    // offered for it), so reach past the front door and plant a
    // matching-shape row directly — proving even a planted rule is never
    // consulted for L2, the level check happens before any allowlist lookup.
    const backdoor = (
      h.trust as unknown as {
        store: {
          upsertAllowlistRule(
            toolName: string,
            paramsJson: string,
            approvalId: string,
            nowIso: string,
          ): unknown
        }
      }
    ).store
    backdoor.upsertAllowlistRule(
      'transfer_funds',
      canonicalAllowlistParams({ to: 'bob@example.com' }),
      'seed-approval-adversarial',
      new Date().toISOString(),
    )

    const cardsBefore = h.approvalCards.length
    const deliveriesBefore = deliveryCount(h)

    h.fake.setResponses([
      { message: fakeToolCall('transfer_funds', { to: 'bob@example.com', amount: 10 }) },
      { message: fakeText('Card raised.') },
    ])
    await h.chatLoop.handleChatMessage(
      chatEvent({ text: 'transfer 10 to bob@example.com', spaceId: h.spaceId }),
    )

    expect(h.approvalCards).toHaveLength(cardsBefore + 1)
    expect(h.approvalCards.at(-1)?.level).toBe('L2')
    // Never delivered: an L2 card always waits for a human, allowlist or not.
    expect(deliveryCount(h)).toBe(deliveriesBefore)

    const cardDecision = h.trust
      .auditEntries()
      .find(
        (entry) =>
          entry.kind === 'action.decision' &&
          entry.decision === 'card' &&
          entry.toolName === 'transfer_funds',
      )
    expect(cardDecision).toBeDefined()
    expect(cardDecision?.trigger?.kind).toBe('chat')
  })
})
