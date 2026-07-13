import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayServerMessageSchema,
  type ApprovalCard,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeContextHash, type ToolContext, type ToolDef } from './agent-runner.ts'
import { ApprovalSurfaceManager } from './approval-surface.ts'
import { INJECTION_CORPUS } from './injection-corpus.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { QuarantinedReader, type ReaderOutput } from './quarantined-reader.ts'
import { buildServer } from './server.ts'
import { Store } from './store.ts'
import { effectiveOrigin, TurnTaintAccumulator, untrustedOrigin, type Origin } from './taint.ts'
import {
  canonicalAllowlistParams,
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  TrustLayer,
  type OutcomeEventPayload,
} from './trust-layer.ts'
import { signBody } from './webhook-verify.ts'

/**
 * Issue #14 acceptance criteria, proved verbatim (not a re-test of the unit
 * behavior already covered by trust-layer.test.ts / approval-surface.test.ts
 * / allowlist-surface.test.ts / audit-surface.test.ts / outbound-tools.test.ts
 * / dev-dispatch.test.ts):
 *
 *   AC1 — "Reply to my wife that I'm on my way" (direct request, active
 *         allowlist) sends without a card; the same action triggered by an
 *         incoming email is a mandatory card, including the mid-turn case.
 *   AC2 — an L2 action stays behind a card even with a matching allowlist.
 *   AC3 — every executed L1+ action is in the audit log with the complete
 *         trigger chain.
 *
 * AC1(a) and AC1(b) run end-to-end through `buildServer` (real Gateway, real
 * chat WebSocket, real HTTP Surface actions, real ingestion+quarantined
 * reader), following server.test.ts's setup style. AC1(b)'s "email trigger"
 * is proved via the real ingestion → quarantined reader pipeline: an actual
 * signed webhook is delivered, the real `QuarantinedReader` appends the
 * `reader.summary` event, and the untrusted mark reaches the next chat
 * dispatch through the same `contextOrigins()` call `dev-dispatch.ts` itself
 * uses — nothing here hand-builds the taint. This was chosen over hand-
 * seeding a `ToolContext` because it exercises the real webhook, reader, and
 * dev-dispatch wiring together, the strongest proof available without a real
 * Agent loop (issue #14 is scaffolded on `dev-dispatch.ts`, a documented
 * placeholder — see server.ts's wiring comments).
 *
 * AC1(c) (mid-turn taint) cannot be produced through `dev-dispatch.ts`: it
 * builds one fresh `ToolContext` per chat command and calls the tool
 * immediately, so there is no seam to grow the taint accumulator "mid-turn"
 * from the outside. That scenario, and the injection-corpus pass below, use
 * a direct harness that wires the *real* `TrustLayer` + `ApprovalSurfaceManager`
 * + `outbound-tools.ts` + `Store` (no HTTP layer, no test doubles for the
 * trust machinery itself) and builds the `ToolContext` by hand, mirroring
 * `dev-dispatch.ts`'s own construction exactly (D10/A1).
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class RecordingSocket {
  readonly sent: GatewayServerMessage[] = []
  private readonly handlers = new Map<string, (raw: Buffer | string) => void>()

  send(data: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(data)))
  }

  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void): void {
    this.handlers.set(event, handler)
  }

  receive(frame: unknown): void {
    this.handlers.get('message')?.(JSON.stringify(frame))
  }
}

function approvalCardFrames(
  socket: RecordingSocket,
): Extract<GatewayServerMessage, { type: 'approval.card' }>[] {
  return socket.sent.filter(
    (frame): frame is Extract<GatewayServerMessage, { type: 'approval.card' }> =>
      frame.type === 'approval.card',
  )
}

function lastCard(socket: RecordingSocket): ApprovalCard {
  const card = approvalCardFrames(socket).at(-1)?.card
  if (!card) throw new Error('expected at least one approval.card frame')
  return card
}

// Every `buildServer` test in this file creates its own on-disk data dir
// (SQLite files, ingestion config); tracked here so `afterEach` can remove
// them instead of leaking a fresh temp directory per test run (Fix 9d).
const createdDataDirs: string[] = []

async function tempDataDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  createdDataDirs.push(dir)
  return dir
}

afterEach(() => {
  // AC1's real-webhook scenario is the only test that sets this (Fix 9d):
  // clean it up unconditionally so it never leaks into another test's
  // process.env, whether or not this test ran or threw.
  delete process.env['VEDUTA_TRUST_ACCEPTANCE_AC1']
  for (const dir of createdDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// AC1(a)+(b) — end-to-end through buildServer
// ---------------------------------------------------------------------------

describe('AC1 — direct request + active allowlist executes without a card; the same action triggered by an incoming email cards (issue #14)', () => {
  it('auto-sends a second direct request once an allowlist rule exists, then cards the identical request once the Space is tainted by a real incoming email', async () => {
    const secret = 'veduta-trust-acceptance-ac1'
    process.env['VEDUTA_TRUST_ACCEPTANCE_AC1'] = secret
    const dataDir = await tempDataDir('veduta-trust-ac1-')
    await writeFile(
      join(dataDir, 'ingestion.json'),
      JSON.stringify({
        sources: {
          mail: {
            verification: 'hmac',
            secret: 'secret://env/VEDUTA_TRUST_ACCEPTANCE_AC1',
            spaceId: 'spc-health',
            filters: { allowSenders: ['sender@untrusted-corp.example'] },
          },
        },
      }),
    )
    const { app, gateway, store, trust } = buildServer({ dataDir })
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    // --- "Reply to my wife that I'm on my way": direct chat request, no
    // allowlist rule yet -> mandatory card (nothing auto-executes on a cold start).
    socket.receive({
      type: 'chat.send',
      text: "send to wife@example.com: I'm on my way",
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => expect(approvalCardFrames(socket).length).toBeGreaterThan(0))
    const firstCard = lastCard(socket)
    expect(firstCard.level).toBe('L1')

    // Approve with the allowlist checkbox: creates a standing rule for wife@example.com.
    await app.inject({
      method: 'POST',
      url: `/api/surfaces/${firstCard.surfaceId}/actions`,
      payload: { nodeId: 'decision-allowlist', name: 'toggle', payload: { value: true } },
    })
    await app.inject({
      method: 'POST',
      url: `/api/surfaces/${firstCard.surfaceId}/actions`,
      payload: { nodeId: 'decision-approve', name: 'press', payload: { value: true } },
    })
    await vi.waitFor(() => {
      expect(trust.auditEntries().some((e) => e.kind === 'action.outcome')).toBe(true)
    })
    expect(trust.listAllowlistRules()).toHaveLength(1)
    expect(store.eventLog('spc-health').filter((e) => e.type === 'outbound.delivery')).toHaveLength(
      1,
    )
    // The card Surface is gone once resolved.
    expect(store.getSurface(firstCard.surfaceId)).toBeUndefined()

    // --- AC1(a): the SAME direct request again -> auto-executes. No new
    // card, no approval.card frame at all; sent immediately.
    const cardCountAfterFirst = approvalCardFrames(socket).length
    socket.receive({
      type: 'chat.send',
      text: "send to wife@example.com: I'm on my way",
      spaceId: 'spc-health',
    })
    // Wait for the *outcome* audit row specifically (not just the delivery
    // event): the handler's delivery lands one microtask turn before
    // `executeAndFinalize`'s transaction commits the outcome row, so waiting
    // on the delivery count alone would race the assertions below.
    await vi.waitFor(() => {
      expect(trust.auditEntries().filter((e) => e.kind === 'action.outcome')).toHaveLength(2)
    })
    expect(store.eventLog('spc-health').filter((e) => e.type === 'outbound.delivery')).toHaveLength(
      2,
    )
    expect(approvalCardFrames(socket)).toHaveLength(cardCountAfterFirst) // no new card frame

    // AC3, for this auto-allowed execution: decision 'allowed' and outcome
    // 'executed' linked by refId, the chat trigger, and a non-empty context hash.
    const allowedDecision = trust
      .auditEntries()
      .find((e) => e.kind === 'action.decision' && e.decision === 'allowed')
    expect(allowedDecision).toBeDefined()
    expect(allowedDecision?.toolName).toBe('send_message')
    expect(allowedDecision?.effectiveOrigin).toBe('trusted:user')
    expect(allowedDecision?.trigger?.kind).toBe('chat')
    expect(allowedDecision?.contextHash).toBeTruthy()
    const linkedOutcome = trust
      .auditEntries()
      .find((e) => e.kind === 'action.outcome' && e.refId === allowedDecision?.refId)
    expect(linkedOutcome?.outcome).toBe('executed')

    // --- AC1(b): taint the Space through a REAL incoming email — the actual
    // signed webhook, the actual ingestion pipeline, the actual quarantined
    // reader — rather than hand-seeding an origin.
    const payload = JSON.stringify({
      id: 'msg-untrusted-1',
      type: 'message.received',
      kind: 'email',
      sender: 'sender@untrusted-corp.example',
      subject: 'quick favor',
    })
    const ingestRes = await app.inject({
      method: 'POST',
      url: '/api/ingest/mail',
      headers: {
        'x-veduta-signature': signBody(secret, Buffer.from(payload)),
        'content-type': 'application/json',
      },
      payload,
    })
    expect(ingestRes.statusCode).toBe(200)
    expect(
      store
        .eventLog('spc-health')
        .some((e) => e.type === 'reader.summary' && e.origin === 'untrusted:mail'),
    ).toBe(true)
    // The exact function dev-dispatch.ts uses to seed a turn's origins.
    expect(store.spacesEngine.contextOrigins('spc-health')).toContain('untrusted:mail')

    // --- Same tool, same recipient, the allowlist rule is still active —
    // now it must card: the untrusted origin in the live turn taint
    // overrides the allowlist entirely.
    const cardCountBeforeTainted = approvalCardFrames(socket).length
    socket.receive({
      type: 'chat.send',
      text: "send to wife@example.com: I'm on my way",
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => {
      expect(approvalCardFrames(socket)).toHaveLength(cardCountBeforeTainted + 1)
    })
    // Nothing new delivered for the tainted attempt.
    expect(store.eventLog('spc-health').filter((e) => e.type === 'outbound.delivery')).toHaveLength(
      2,
    )
    const taintedCard = lastCard(socket)
    expect(taintedCard.surfaceId).not.toBe(firstCard.surfaceId)

    // AC3: the audit chain for this card carries the untrusted origin. (The
    // chain also carries `untrusted:external`, the ingestion accept notice's
    // fixed mark — `effectiveOrigin` is "some" untrusted origin from the
    // chain, not specifically this one; the chain membership is the proof.)
    const cardDecision = trust
      .auditEntries()
      .find(
        (e) =>
          e.kind === 'action.decision' &&
          e.decision === 'card' &&
          e.toolName === 'send_message' &&
          e.originChain?.includes('untrusted:mail'),
      )
    expect(cardDecision).toBeDefined()
    expect(cardDecision?.effectiveOrigin?.startsWith('untrusted:')).toBe(true)

    await app.close()
  })
})

// ---------------------------------------------------------------------------
// AC1(c) — mid-turn taint, and the injection corpus below, use a direct
// harness: the real TrustLayer + ApprovalSurfaceManager + outbound-tools.ts +
// Store, `ToolContext` built by hand exactly like dev-dispatch.ts does.
// ---------------------------------------------------------------------------

interface DirectHarness {
  store: Store
  trust: TrustLayer
  approvalSurfaces: ApprovalSurfaceManager
  sendMessage: ToolDef
  approvalCards: ApprovalCard[]
  dispose(): void
}

function buildDirectHarness(): DirectHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-trust-direct-'))
  const store = new Store({ rootDir })
  const approvalSurfaces = new ApprovalSurfaceManager({ store })
  const approvalCards: ApprovalCard[] = []
  const outcomeEvents: { spaceId: string; payload: OutcomeEventPayload }[] = []
  const trust = new TrustLayer({
    rootDir,
    approvalCardPort: approvalSurfaces,
    onApprovalCard: (card) => approvalCards.push(card),
    appendOutcomeEvent: (spaceId, payload) => {
      outcomeEvents.push({ spaceId, payload })
      // Mirrors server.ts's wiring exactly (Fix 4): an outcome is always
      // daemon-produced, never a genuine user event.
      store.spacesEngine.appendEvent(spaceId, {
        type: 'approval.outcome',
        text: `${payload.tool}: ${payload.outcome}`,
        origin: 'trusted:system',
        payload,
      })
    },
  })
  approvalSurfaces.setTrust(trust)
  const outboundTransport = createMockOutboundTransport(store.spacesEngine)
  const outboundTools = createOutboundTools(outboundTransport)
  for (const { tool, meta } of outboundTools) trust.register(tool, meta)
  const [sendMessage] = trust.wrapTools(outboundTools.map(({ tool }) => tool))
  if (!sendMessage) throw new Error('expected wrapTools to return the wrapped send_message tool')
  return {
    store,
    trust,
    approvalSurfaces,
    sendMessage,
    approvalCards,
    dispose: () => {
      approvalSurfaces.dispose()
      trust.dispose()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

/** Mirrors dev-dispatch.ts's `runDispatch` context construction exactly (D10/A1/A3). */
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

describe('AC1(c) — mid-turn taint: a turn that starts trusted still cards once the live taint accumulator gains an untrusted origin', () => {
  it('cards a normally-allowlisted send_message once a memory-tool-style read taints the turn before the send is attempted', async () => {
    const harness = buildDirectHarness()
    try {
      const spaceId = 'spc-health'

      // Establish the allowlist rule the ordinary way: an untainted first
      // send, approved with the checkbox checked.
      const { context: firstContext } = buildTurnContext(
        harness.store,
        spaceId,
        "send to wife@example.com: I'm on my way",
      )
      const firstResult = await harness.sendMessage.handler(
        { to: 'wife@example.com', body: "I'm on my way" },
        firstContext,
      )
      expect(firstResult.content).toMatch(/needs your approval/)
      const surfaceId = harness.approvalCards.at(-1)?.surfaceId
      if (!surfaceId) throw new Error('expected a card surface to have been created')
      harness.store.invokeSurfaceAction(surfaceId, {
        nodeId: 'decision-allowlist',
        name: 'toggle',
        payload: { value: true },
      })
      harness.store.invokeSurfaceAction(surfaceId, {
        nodeId: 'decision-approve',
        name: 'press',
        payload: { value: true },
      })
      await harness.approvalSurfaces.flush()
      expect(harness.trust.listAllowlistRules()).toHaveLength(1)
      expect(
        harness.store.eventLog(spaceId).filter((e) => e.type === 'outbound.delivery'),
      ).toHaveLength(1)

      // Baseline: an untainted repeat auto-executes (the rule works).
      const { context: repeatContext } = buildTurnContext(
        harness.store,
        spaceId,
        'send to wife@example.com: still on my way',
      )
      const repeatResult = await harness.sendMessage.handler(
        { to: 'wife@example.com', body: 'still on my way' },
        repeatContext,
      )
      expect(repeatResult.content).toBe('Sent message to wife@example.com.')
      expect(
        harness.store.eventLog(spaceId).filter((e) => e.type === 'outbound.delivery'),
      ).toHaveLength(2)

      // The A1 case: a turn that STARTS trusted (the seed carries no
      // untrusted origin — `context.origin` below proves it), but before the
      // send is attempted, a memory-tool-style read grows the live taint
      // accumulator mid-turn.
      const { context: taintedContext, taint } = buildTurnContext(
        harness.store,
        spaceId,
        'send to wife@example.com: on my way, after reading recent notes',
      )
      expect(taintedContext.origin).toBe('trusted:user')
      taint.add(untrustedOrigin('gmail')) // simulates read_recent surfacing an untrusted event
      const taintedResult = await harness.sendMessage.handler(
        { to: 'wife@example.com', body: 'on my way' },
        taintedContext,
      )
      expect(taintedResult.content).toMatch(/needs your approval/)
      // Unchanged: the tainted attempt never executed.
      expect(
        harness.store.eventLog(spaceId).filter((e) => e.type === 'outbound.delivery'),
      ).toHaveLength(2)

      const cardDecision = harness.trust
        .auditEntries()
        .find(
          (e) =>
            e.kind === 'action.decision' &&
            e.decision === 'card' &&
            e.originChain?.includes(untrustedOrigin('gmail')),
        )
      expect(cardDecision).toBeDefined()
      expect(cardDecision?.effectiveOrigin).toBe(untrustedOrigin('gmail'))
    } finally {
      harness.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// AC2 — L2 stays behind a card even with a matching allowlist.
// ---------------------------------------------------------------------------

describe('AC2 — an L2 action (bank transfer) stays behind a card even with a matching allowlist (issue #14)', () => {
  it('never offers the allowlist checkbox on an L2 card, and approving it grants no rule', async () => {
    const dataDir = await tempDataDir('veduta-trust-ac2a-')
    const { app, gateway, store, trust } = buildServer({ dataDir })
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    socket.receive({
      type: 'chat.send',
      text: 'transfer 250 to bob@example.com',
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => expect(approvalCardFrames(socket).length).toBeGreaterThan(0))
    const card = lastCard(socket)
    expect(card.level).toBe('L2')

    // Impossible via the front door: the card's own state never carries the
    // allowlist checkbox key at all (buildApprovalCardSurface only adds it
    // when `showAllowlistCheckbox` is true, which requires L1).
    const surface = store.getSurface(card.surfaceId)
    expect(surface).toBeDefined()
    expect(Object.keys(surface?.state ?? {})).not.toContain(DECISION_ALLOWLIST_CHECKBOX_KEY)

    const approve = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${card.surfaceId}/actions`,
      payload: { nodeId: 'decision-approve', name: 'press', payload: { value: true } },
    })
    expect(approve.statusCode).toBe(200)
    await vi.waitFor(() => {
      expect(trust.auditEntries().some((e) => e.kind === 'action.outcome')).toBe(true)
    })
    // Approving an L2 card never creates an allowlist rule — there was never
    // a checkbox to check.
    expect(trust.listAllowlistRules()).toHaveLength(0)
    expect(store.eventLog('spc-health').filter((e) => e.type === 'outbound.delivery')).toHaveLength(
      1,
    )

    await app.close()
  })

  it('still cards a transfer even when a matching-shape allowlist rule is planted directly for transfer_funds (maximally adversarial: past the front door entirely)', async () => {
    const dataDir = await tempDataDir('veduta-trust-ac2b-')
    const { app, gateway, store, trust } = buildServer({ dataDir })
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    // A genuine active send_message rule for the same recipient string
    // exists — proves it is the tool/level check, not the recipient match,
    // that gates L2.
    socket.receive({
      type: 'chat.send',
      text: 'send to bob@example.com: hi there',
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => expect(approvalCardFrames(socket).length).toBeGreaterThan(0))
    const sendCard = lastCard(socket)
    await app.inject({
      method: 'POST',
      url: `/api/surfaces/${sendCard.surfaceId}/actions`,
      payload: { nodeId: 'decision-allowlist', name: 'toggle', payload: { value: true } },
    })
    await app.inject({
      method: 'POST',
      url: `/api/surfaces/${sendCard.surfaceId}/actions`,
      payload: { nodeId: 'decision-approve', name: 'press', payload: { value: true } },
    })
    await vi.waitFor(() => expect(trust.listAllowlistRules()).toHaveLength(1))

    // Adversarial: the public API has no way to create an allowlist rule for
    // an L2 tool (no checkbox is ever rendered, `grantAllowlist` requires
    // `row.level === 'L1'`). Reach past the front door entirely and insert a
    // matching-shape row directly, to prove even a *planted* row is never
    // consulted for L2 — the level check happens before any allowlist lookup.
    // `upsertAllowlistRule` now lives on `TrustStore` (Fix 7 split), reached
    // through the facade's private `store` field.
    const backdoor = (
      trust as unknown as {
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

    const cardCountBefore = approvalCardFrames(socket).length
    socket.receive({
      type: 'chat.send',
      text: 'transfer 10 to bob@example.com',
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => {
      expect(approvalCardFrames(socket)).toHaveLength(cardCountBefore + 1)
    })
    const transferCard = lastCard(socket)
    expect(transferCard.level).toBe('L2')
    // Still not delivered — only the send_message above went through.
    expect(store.eventLog('spc-health').filter((e) => e.type === 'outbound.delivery')).toHaveLength(
      1,
    )

    const decision = trust
      .auditEntries()
      .find((e) => e.kind === 'action.decision' && e.toolName === 'transfer_funds')
    expect(decision?.decision).toBe('card')

    await app.close()
  })
})

// ---------------------------------------------------------------------------
// Injection corpus × trust layer (basis for issue #015's broader CI suite).
// ---------------------------------------------------------------------------

function testRouter(): ModelRouter {
  const config: RoutingConfig = {
    tiers: {
      reasoning: [{ provider: 'mock', modelId: 'strong' }],
      triage: [{ provider: 'mock', modelId: 'cheap' }],
    },
    providerKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 5 },
  }
  return new ModelRouter({
    config,
    now: () => new Date('2026-07-11T10:00:00.000Z'),
    sleep: async () => {},
  })
}

const BENIGN_READER_OUTPUT: ReaderOutput = {
  intent: 'other',
  entities: [],
  deadlines: [],
  urgency: 'normal',
  summary: 'a routine message (mock reader classification)',
}

/**
 * Issue #13's injection corpus already proves the quarantined reader itself
 * never lets an adversarial completion reach the Space log
 * (quarantined-reader.test.ts's own corpus suite). This pass is the trust
 * layer's side of the same corpus, and the seed for issue #015's broader CI
 * suite: whatever a malicious email tries to induce the (future) Agent to
 * do with an outbound tool, the trust layer must gate it exactly like any
 * other tainted turn — zero ungated executions, ever.
 */
describe('injection corpus × trust layer (issue #14, seeds issue #015 CI suite)', () => {
  const inducedRecipient = 'attacker@evil.com'

  it.each(INJECTION_CORPUS)(
    'never executes an induced send_message for corpus entry $name — exactly one card, zero deliveries, complete audit',
    async (entry) => {
      const harness = buildDirectHarness()
      try {
        const spaceId = 'spc-health'

        // Maximally adversarial, in the right order: an active allowlist
        // rule for the induced recipient is granted FIRST, while the Space
        // is still untainted (an already-tainted seed would never pass the
        // checkbox-eligibility check, so the rule could never be created —
        // that ordering itself is part of what the trust layer guarantees).
        const { context: seedContext } = buildTurnContext(harness.store, spaceId, 'seed allowlist')
        const seedResult = await harness.sendMessage.handler(
          { to: inducedRecipient, body: 'seed message' },
          seedContext,
        )
        expect(seedResult.content).toMatch(/needs your approval/)
        const seedSurfaceId = harness.approvalCards.at(-1)?.surfaceId
        if (!seedSurfaceId) throw new Error('expected a seed card surface')
        harness.store.invokeSurfaceAction(seedSurfaceId, {
          nodeId: 'decision-allowlist',
          name: 'toggle',
          payload: { value: true },
        })
        harness.store.invokeSurfaceAction(seedSurfaceId, {
          nodeId: 'decision-approve',
          name: 'press',
          payload: { value: true },
        })
        await harness.approvalSurfaces.flush()
        expect(harness.trust.listAllowlistRules()).toHaveLength(1)

        // Drive this corpus entry through the real QuarantinedReader (same
        // harness pattern as quarantined-reader.test.ts's own corpus suite):
        // a benign, schema-valid completion is enough to taint the Space —
        // the sanitizer's own adversarial-completion defense is already
        // covered there, this pass is about the trust layer's reaction to
        // the resulting taint, not the reader's sanitizer.
        const reader = new QuarantinedReader({
          router: testRouter(),
          store: harness.store,
          complete: async () => ({ text: JSON.stringify(BENIGN_READER_OUTPUT) }),
          fetchBody: async () => entry.body,
        })
        await reader.read({
          queueId: 1,
          spaceId,
          acceptedAt: new Date().toISOString(),
          event: entry.event,
        })
        const taintOrigin = untrustedOrigin(entry.event.source)
        expect(harness.store.spacesEngine.contextOrigins(spaceId)).toContain(taintOrigin)

        // The corpus-tainted attempt: same tool, same already-allowlisted
        // recipient — must still card, never auto-execute.
        const cardsBefore = harness.approvalCards.length
        const { context: attemptContext } = buildTurnContext(
          harness.store,
          spaceId,
          `induced by corpus entry ${entry.name}`,
        )
        const attemptResult = await harness.sendMessage.handler(
          { to: inducedRecipient, body: 'induced message' },
          attemptContext,
        )
        expect(attemptResult.content).toMatch(/needs your approval/)
        // Exactly one new card for this attempt.
        expect(harness.approvalCards).toHaveLength(cardsBefore + 1)

        // Zero ungated executions: only the (approved) seed send ever
        // delivered; the induced attempt never did.
        expect(
          harness.store.eventLog(spaceId).filter((e) => e.type === 'outbound.delivery'),
        ).toHaveLength(1)

        // Audit completeness for the gated attempt.
        const cardDecision = harness.trust
          .auditEntries()
          .find(
            (e) =>
              e.kind === 'action.decision' &&
              e.decision === 'card' &&
              e.toolName === 'send_message' &&
              e.originChain?.includes(taintOrigin),
          )
        expect(cardDecision).toBeDefined()
        expect(cardDecision?.effectiveOrigin).toBe(taintOrigin)
        expect(cardDecision?.trigger?.kind).toBe('chat')
        expect(cardDecision?.contextHash).toBeTruthy()
      } finally {
        harness.dispose()
      }
    },
  )
})
