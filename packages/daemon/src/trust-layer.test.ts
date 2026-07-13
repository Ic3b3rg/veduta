import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import type { ApprovalCard } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineTool,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type TriggerRef,
} from './agent-runner.ts'
import { type Origin, TurnTaintAccumulator, untrustedOrigin } from './taint.ts'
import {
  type ApprovalCardModel,
  type ApprovalCardPort,
  canonicalAllowlistParams,
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  fieldStateKey,
  isTrustWrapped,
  type OutcomeEventPayload,
  type PendingApproval,
  type ToolMeta,
  TrustLayer,
  type TrustLayerOptions,
} from './trust-layer.ts'

/** Everything the fake needs to let tests drive/observe a card: field state, archived flag, validation error. */
interface FakeCard {
  approval: PendingApproval
  card: ApprovalCardModel
  fields: Record<string, unknown>
  archived: boolean
  validationError?: string
}

class FakeApprovalCardPort implements ApprovalCardPort {
  readonly surfaces = new Map<string, FakeCard>()
  private nextId = 1

  create(approval: PendingApproval, card: ApprovalCardModel): { surfaceId: string } {
    const surfaceId = `srf-approval-${this.nextId}`
    this.nextId += 1
    const fields: Record<string, unknown> = {}
    for (const field of card.editableFields) fields[fieldStateKey(field.key)] = field.value
    this.surfaces.set(surfaceId, { approval, card, fields, archived: false })
    return { surfaceId }
  }

  patchValidationError(surfaceId: string, message: string): void {
    const entry = this.surfaces.get(surfaceId)
    if (entry) entry.validationError = message
  }

  readEditedFields(surfaceId: string): Record<string, unknown> {
    const entry = this.surfaces.get(surfaceId)
    return entry ? { ...entry.fields } : {}
  }

  archive(surfaceId: string): void {
    const entry = this.surfaces.get(surfaceId)
    if (entry) entry.archived = true
  }

  /** Test helper: simulates the human editing a field or checking the checkbox. */
  setField(surfaceId: string, key: string, value: unknown): void {
    const entry = this.surfaces.get(surfaceId)
    if (entry) entry.fields[key] = value
  }

  /** Test helper: the one card created so far (asserts exactly one exists). */
  onlySurfaceId(): string {
    const ids = [...this.surfaces.keys()]
    if (ids.length !== 1) throw new Error(`expected exactly one surface, found ${ids.length}`)
    return ids[0] as string
  }
}

const SendMessageSchema = z.object({ to: z.string().min(1), body: z.string().min(1) })

function sendMessageTool(onExecute?: (input: z.infer<typeof SendMessageSchema>) => void): ToolDef {
  return defineTool({
    name: 'send_message',
    description: 'Send a message to a recipient.',
    schema: SendMessageSchema,
    level: 'L1',
    egressDomains: ['mail.example.com'],
    handler: (input) => {
      onExecute?.(input)
      return { content: `sent to ${input.to}` }
    },
  })
}

const sendMessageMeta: ToolMeta<z.infer<typeof SendMessageSchema>> = {
  title: (input) => `Send message to ${input.to}`,
  summary: (input) => input.body,
  editableKeys: ['body'],
  allowlistParams: (input) => ({ to: input.to }),
}

const TransferFundsSchema = z.object({ to: z.string().min(1), amountUsd: z.number().positive() })

function transferFundsTool(
  onExecute?: (input: z.infer<typeof TransferFundsSchema>) => void,
): ToolDef {
  return defineTool({
    name: 'transfer_funds',
    description: 'Transfer funds to a recipient.',
    schema: TransferFundsSchema,
    level: 'L2',
    egressDomains: ['bank.example.com'],
    handler: (input) => {
      onExecute?.(input)
      return { content: `transferred ${input.amountUsd} to ${input.to}` }
    },
  })
}

const transferFundsMeta: ToolMeta<z.infer<typeof TransferFundsSchema>> = {
  title: (input) => `Transfer $${input.amountUsd} to ${input.to}`,
  summary: () => 'A funds transfer.',
  allowlistParams: (input) => ({ to: input.to }),
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())
let port: FakeApprovalCardPort
let approvalCards: ApprovalCard[]
let outcomeEvents: { spaceId: string; payload: OutcomeEventPayload }[]
let systemNotices: string[]
let layers: TrustLayer[]

function createLayer(overrides: Partial<TrustLayerOptions> = {}): TrustLayer {
  const layer = new TrustLayer({
    rootDir,
    approvalCardPort: port,
    onApprovalCard: (card) => approvalCards.push(card),
    appendOutcomeEvent: (spaceId, payload) => outcomeEvents.push({ spaceId, payload }),
    onSystemNotice: (text) => systemNotices.push(text),
    now,
    ...overrides,
  })
  layers.push(layer)
  return layer
}

/** Raw db access for tests that must reach past the public API (crash simulation): reaches through the facade's private `store` to its private `db` (Fix 7 split). */
interface RawDb {
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown }
}
function dbOf(layer: TrustLayer): RawDb {
  return (layer as unknown as { store: { db: RawDb } }).store.db
}

/** Seeds an allowlist rule directly, past `decide()`, for adversarial "even a planted rule must not help" tests (Fix 7: `upsertAllowlistRule` now lives on `TrustStore`). */
function seedAllowlistRule(
  layer: TrustLayer,
  toolName: string,
  paramsJson: string,
  approvalId: string,
  nowIso: string,
): { id: number; created: boolean } {
  const store = (
    layer as unknown as {
      store: {
        upsertAllowlistRule(
          toolName: string,
          paramsJson: string,
          approvalId: string,
          nowIso: string,
        ): { id: number; created: boolean }
      }
    }
  ).store
  return store.upsertAllowlistRule(toolName, paramsJson, approvalId, nowIso)
}

function toolContext(params: {
  origin?: Origin
  origins?: Origin[]
  spaceId?: string
  trigger?: TriggerRef
  contextHash?: string
  toolCallId?: string
}): ToolContext {
  const origin = params.origin ?? 'trusted:user'
  const origins = params.origins ?? [origin]
  return fromPartial<ToolContext>({
    toolCallId: params.toolCallId ?? 'call-1',
    origin,
    origins,
    taint: new TurnTaintAccumulator(origins),
    contextHash: params.contextHash ?? 'hash-1',
    ...(params.spaceId !== undefined ? { spaceId: params.spaceId } : {}),
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
  })
}

async function callWrapped(
  layer: TrustLayer,
  tool: ToolDef,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const [wrapped] = layer.wrapTools([tool])
  if (!wrapped) throw new Error('wrapTools returned no tool')
  return wrapped.handler(input, context)
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-trust-'))
  clock = new Date('2026-07-10T12:00:00.000Z')
  port = new FakeApprovalCardPort()
  approvalCards = []
  outcomeEvents = []
  systemNotices = []
  layers = []
})

afterEach(() => {
  for (const layer of layers) layer.dispose()
  rmSync(rootDir, { recursive: true, force: true })
})

describe('register', () => {
  it('throws on duplicate tool registration', () => {
    const layer = createLayer()
    layer.register(sendMessageTool(), sendMessageMeta)
    expect(() => layer.register(sendMessageTool(), sendMessageMeta)).toThrow(/duplicate/)
  })

  it('throws when an L0 tool declares non-empty egress domains', () => {
    const layer = createLayer()
    const badTool = defineTool({
      name: 'bad_tool',
      description: 'x',
      schema: z.object({}),
      level: 'L0',
      egressDomains: ['example.com'],
      handler: () => ({ content: 'ok' }),
    })
    expect(() => layer.register(badTool, { title: () => 't', summary: () => 's' })).toThrow(
      /L0 tool/,
    )
  })

  it('allows an L0 tool with empty egress domains', () => {
    const layer = createLayer()
    const okTool = defineTool({
      name: 'ok_tool',
      description: 'x',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
    expect(() => layer.register(okTool, { title: () => 't', summary: () => 's' })).not.toThrow()
  })

  it('throws when an editableKey is not a simple identifier', () => {
    const layer = createLayer()
    expect(() =>
      layer.register(sendMessageTool(), { ...sendMessageMeta, editableKeys: ['field.body'] }),
    ).toThrow(/simple identifier/)
  })

  it('throws when an editableKey collides with a reserved decision key', () => {
    const layer = createLayer()
    expect(() =>
      layer.register(sendMessageTool(), { ...sendMessageMeta, editableKeys: ['decision.approve'] }),
    ).toThrow()
  })
})

describe('isTrustWrapped', () => {
  it('is true only for a tool actually produced by wrapTools, never a hand-built lookalike', () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    const [wrapped] = layer.wrapTools([tool])
    expect(wrapped).toBeDefined()
    expect(isTrustWrapped(wrapped as ToolDef)).toBe(true)
    expect(isTrustWrapped(tool)).toBe(false)

    const forged = { ...tool, trustWrapped: true } as unknown as ToolDef
    expect(isTrustWrapped(forged)).toBe(false)
  })

  it('L0 tools and unregistered L1/L2 tools pass through wrapTools unwrapped', () => {
    const layer = createLayer()
    const l0 = defineTool({
      name: 'l0_tool',
      description: 'x',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
    const unregistered = sendMessageTool()
    const [wrappedL0, wrappedUnregistered] = layer.wrapTools([l0, unregistered])
    expect(wrappedL0).toBe(l0)
    expect(wrappedUnregistered).toBe(unregistered)
    expect(isTrustWrapped(l0)).toBe(false)
    expect(isTrustWrapped(unregistered)).toBe(false)
  })
})

describe('decision matrix', () => {
  it('unregistered tool -> deny', () => {
    const layer = createLayer()
    const context = toolContext({ spaceId: 'spc-test' })
    const decision = layer.decide('mystery_tool', { anything: true }, context)
    expect(decision.outcome).toBe('denied')
    expect(decision.reason).toMatch(/not registered/)
    const [entry] = layer.auditEntries(1)
    expect(entry?.kind).toBe('action.decision')
    expect(entry?.decision).toBe('denied')
  })

  it('missing spaceId when a card would be needed -> deny (not card)', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    const context = toolContext({}) // no spaceId, no rule yet -> would need a card
    const result = await callWrapped(layer, tool, { to: 'alice@example.com', body: 'hi' }, context)
    expect(result.content).toMatch(/denied/)
    expect(port.surfaces.size).toBe(0)
  })

  it('L1 + trusted:user prompt + matching allowlist rule + no untrusted taint -> allow, no card', async () => {
    const executed: unknown[] = []
    const layer = createLayer()
    const tool = sendMessageTool((input) => executed.push(input))
    layer.register(tool, sendMessageMeta)

    // First call cards (no rule yet).
    const first = await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(first.content).toMatch(/needs your approval/)
    const surfaceId = port.onlySurfaceId()
    port.setField(surfaceId, DECISION_ALLOWLIST_CHECKBOX_KEY, true)
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    await layer.resolve(effectId, 'approve')
    expect(executed).toHaveLength(1)
    expect(layer.listAllowlistRules()).toHaveLength(1)

    // Second call, same recipient: now auto-allowed, no new card.
    const second = await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'again' },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(executed).toHaveLength(2)
    expect(port.surfaces.size).toBe(1)
    expect(second.content).toBe('sent to alice@example.com')

    // The allowed decision names the exact rule that authorized it
    // (SECURITY.md §5: the audit carries the complete trigger chain).
    const ruleId = layer.listAllowlistRules()[0]?.id
    const allowedDecision = layer
      .auditEntries()
      .find((entry) => entry.kind === 'action.decision' && entry.decision === 'allowed')
    expect(allowedDecision?.allowlistRuleId).toBe(ruleId)
  })

  it('L2 always cards, even with a matching allowlist rule (allowlist ignored)', async () => {
    const layer = createLayer()
    const tool = transferFundsTool()
    layer.register(tool, transferFundsMeta)
    // Seed a rule directly: L2 approvals never offer the checkbox, so this
    // proves the level check, not just the UI, keeps L2 out of the allowlist.
    seedAllowlistRule(
      layer,
      'transfer_funds',
      canonicalAllowlistParams({ to: 'bob' }),
      'seed-approval',
      now().toISOString(),
    )

    const result = await callWrapped(
      layer,
      tool,
      { to: 'bob', amountUsd: 10 },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(result.content).toMatch(/needs your approval/)
    expect(port.surfaces.size).toBe(1)
  })

  it('any untrusted origin in the snapshot forces a card, allowlist ignored', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    seedAllowlistRule(
      layer,
      'send_message',
      canonicalAllowlistParams({ to: 'alice@example.com' }),
      'seed-approval',
      now().toISOString(),
    )

    const context = toolContext({
      origins: ['trusted:user', untrustedOrigin('gmail')],
      spaceId: 'spc-test',
    })
    const result = await callWrapped(layer, tool, { to: 'alice@example.com', body: 'hi' }, context)
    expect(result.content).toMatch(/needs your approval/)
  })

  it('a trusted:system prompt origin still cards, even with no untrusted taint and a matching rule', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    seedAllowlistRule(
      layer,
      'send_message',
      canonicalAllowlistParams({ to: 'alice@example.com' }),
      'seed-approval',
      now().toISOString(),
    )

    const context = toolContext({
      origin: 'trusted:system',
      origins: ['trusted:system'],
      spaceId: 'spc-test',
    })
    const result = await callWrapped(layer, tool, { to: 'alice@example.com', body: 'hi' }, context)
    expect(result.content).toMatch(/needs your approval/)
  })

  it('taint added mid-turn (after the taint accumulator was seeded) still forces a card (A1)', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    seedAllowlistRule(
      layer,
      'send_message',
      canonicalAllowlistParams({ to: 'alice@example.com' }),
      'seed-approval',
      now().toISOString(),
    )

    const context = toolContext({ spaceId: 'spc-test' }) // seeded trusted:user only
    context.taint.add(untrustedOrigin('gmail')) // simulates a mid-turn read_recent
    const result = await callWrapped(layer, tool, { to: 'alice@example.com', body: 'hi' }, context)
    expect(result.content).toMatch(/needs your approval/)
  })
})

describe('TriggerRef.parent (Fix 8)', () => {
  it('a two-hop trigger chain round-trips through a decision audit row', () => {
    const layer = createLayer()
    const twoHop: TriggerRef = {
      kind: 'automation',
      id: 'job-1',
      summary: 'scheduled digest run',
      parent: { kind: 'external-event', source: 'gmail', summary: 'new message arrived' },
    }
    const context = toolContext({ spaceId: 'spc-test', trigger: twoHop })
    layer.decide('mystery_tool', { anything: true }, context)

    const [entry] = layer.auditEntries(1)
    expect(entry?.kind).toBe('action.decision')
    expect(entry?.trigger).toEqual(twoHop)
    expect(entry?.trigger?.parent).toEqual(twoHop.parent)
  })
})

describe('resolve()', () => {
  it('reject: claims, archives the card, and appends a content-free outcome event without executing', async () => {
    let executions = 0
    const layer = createLayer()
    const tool = sendMessageTool(() => {
      executions += 1
    })
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string

    await layer.resolve(effectId, 'reject')

    expect(executions).toBe(0)
    expect(port.surfaces.get(surfaceId)?.archived).toBe(true)
    expect(outcomeEvents).toHaveLength(1)
    expect(outcomeEvents[0]?.payload.outcome).toBe('rejected')
    expect(outcomeEvents[0]?.payload.effectId).toBe(effectId)
    expect(outcomeEvents[0]?.payload.approvalId).toBe(effectId)
  })

  it('exactly-once: two concurrent resolve("approve") calls on the same approval produce one winner', async () => {
    let executions = 0
    const layer = createLayer()
    const tool = sendMessageTool(() => {
      executions += 1
    })
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string

    await Promise.all([layer.resolve(effectId, 'approve'), layer.resolve(effectId, 'approve')])

    expect(executions).toBe(1)
    const decided = layer
      .auditEntries(50)
      .filter((e) => e.kind === 'approval.decided' && e.refId === effectId)
    expect(decided).toHaveLength(1)
    const outcome = layer
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === effectId)
    expect(outcome).toHaveLength(1)
  })

  it('a claim attempted after the TTL passed expires the approval instead of executing it', async () => {
    let executions = 0
    const layer = createLayer({ ttlMs: 1000 })
    const tool = sendMessageTool(() => {
      executions += 1
    })
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string

    clock = new Date(clock.getTime() + 60_000) // well past the 1s ttl
    await layer.resolve(effectId, 'approve')

    expect(executions).toBe(0)
    const outcome = layer
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === effectId)
    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.outcome).toBe('expired')
    expect(port.surfaces.get(surfaceId)?.archived).toBe(true)
  })

  it('validate-before-claim: an invalid edited field leaves the approval pending, no approval.decided row', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    port.setField(surfaceId, fieldStateKey('body'), '') // violates z.string().min(1)

    await layer.resolve(effectId, 'approve')

    expect(port.surfaces.get(surfaceId)?.validationError).toBeDefined()
    expect(port.surfaces.get(surfaceId)?.archived).toBe(false)
    expect(layer.auditEntries(50).filter((e) => e.kind === 'approval.decided')).toHaveLength(0)
    expect(layer.auditEntries(50).filter((e) => e.kind === 'approval.edit_rejected')).toHaveLength(
      1,
    )

    // A corrected edit still resolves the same, still-pending approval.
    port.setField(surfaceId, fieldStateKey('body'), 'fixed')
    await layer.resolve(effectId, 'approve')
    expect(layer.auditEntries(50).filter((e) => e.kind === 'approval.decided')).toHaveLength(1)
  })

  it('every card-approved effect is preceded by an approval.decided row for the same effectId', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    const trigger: TriggerRef = { kind: 'chat', summary: 'user asked to email alice' }
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi there' },
      toolContext({ spaceId: 'spc-test', trigger, contextHash: 'hash-xyz' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    await layer.resolve(effectId, 'approve')

    const entries = layer.auditEntries(50).filter((e) => e.refId === effectId)
    const kinds = entries.map((e) => e.kind)
    expect(kinds).toEqual(
      expect.arrayContaining(['action.decision', 'approval.decided', 'action.outcome']),
    )
    // auditEntries() is newest-first: action.outcome must sort before (index < ) approval.decided.
    expect(entries.findIndex((e) => e.kind === 'action.outcome')).toBeLessThan(
      entries.findIndex((e) => e.kind === 'approval.decided'),
    )
    const decided = entries.find((e) => e.kind === 'approval.decided')
    expect(decided?.approvedBy).toBe('trusted:user')
    expect(decided?.trigger).toEqual(trigger)
    expect(decided?.contextHash).toBe('hash-xyz')
    expect(decided?.input).toEqual({ to: 'alice@example.com', body: 'hi there' })
  })
})

describe('allowlist management', () => {
  // Allowlist upsert idempotency and the schema-level NOT NULL constraint on
  // `created_from_approval_id` live in trust-store.test.ts (Fix 7):
  // `upsertAllowlistRule` and the DDL itself both live on `TrustStore`. The
  // grant/revoke/match mechanics themselves are unit-tested directly against
  // `TrustAllowlist` in trust-allowlist.test.ts (Fix C); what remains here is
  // `TrustLayer`'s own integration of them into decide()/resolve().

  it('revokeAllowlistRule sets revoked_at, audits allowlist.revoked, and the rule stops matching', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    port.setField(surfaceId, DECISION_ALLOWLIST_CHECKBOX_KEY, true)
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    await layer.resolve(effectId, 'approve')
    const [rule] = layer.listAllowlistRules()
    expect(rule).toBeDefined()

    layer.revokeAllowlistRule((rule as { id: number }).id)
    expect(layer.listAllowlistRules()[0]?.revokedAt).toBeDefined()
    expect(layer.auditEntries(50).filter((e) => e.kind === 'allowlist.revoked')).toHaveLength(1)

    const result = await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'again' },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(result.content).toMatch(/needs your approval/)
  })

  it('allowlist.created carries the full provenance of the approval that granted it (Fix 5)', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    const trigger: TriggerRef = { kind: 'chat', summary: 'user asked to email alice' }
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test', trigger, contextHash: 'hash-provenance' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    port.setField(surfaceId, DECISION_ALLOWLIST_CHECKBOX_KEY, true)
    await layer.resolve(effectId, 'approve')

    const created = layer.auditEntries(50).find((e) => e.kind === 'allowlist.created')
    expect(created?.refId).toBe(effectId)
    expect(created?.toolName).toBe('send_message')
    expect(created?.level).toBe('L1')
    expect(created?.effectiveOrigin).toBe('trusted:user')
    expect(created?.originChain).toEqual(['trusted:user'])
    expect(created?.trigger).toEqual(trigger)
    expect(created?.contextHash).toBe('hash-provenance')
    expect(created?.spaceId).toBe('spc-test')
    // Fix B: the approved (validated) input, not just the allowlist match
    // params in `detail` — the rule's audit row is exactly as complete as
    // the `approval.decided` row it accompanies.
    expect(created?.input).toEqual({ to: 'alice@example.com', body: 'hi' })
  })

  // The actor/Space specifics of a revoke's own audit row, and the
  // no-op-on-unknown-id case, are unit-tested directly against
  // `TrustAllowlist` in trust-allowlist.test.ts (Fix C split) — nothing
  // about them depends on decide()/resolve(), only on `TrustStore`.
})

describe('listPending / attachSurfaceId (D7, Fix 3)', () => {
  it('returns a still-pending, non-expired card with a card model matching what createCard() would have built', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    const trigger: TriggerRef = { kind: 'chat', summary: 'user asked to email alice' }
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test', trigger }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string

    const [record] = layer.listPending()
    expect(record?.approval.id).toBe(effectId)
    expect(record?.approval.toolName).toBe('send_message')
    expect(record?.approval.spaceId).toBe('spc-test')
    expect(record?.surfaceId).toBe(surfaceId)
    expect(record?.card.title).toBe('Send message to alice@example.com')
    expect(record?.card.summary).toBe('hi')
    expect(record?.card.editableFields).toEqual([{ key: 'body', value: 'hi' }])
    expect(record?.card.trigger).toEqual(trigger)
  })

  it('excludes an expired pending row', async () => {
    const layer = createLayer({ ttlMs: 1000 })
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    clock = new Date(clock.getTime() + 60_000) // well past the 1s ttl
    expect(layer.listPending()).toHaveLength(0)
  })

  it('excludes a row whose tool is no longer registered on this instance', async () => {
    const layer1 = createLayer()
    const tool = sendMessageTool()
    layer1.register(tool, sendMessageMeta)
    await callWrapped(
      layer1,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    layer1.dispose()

    const layer2 = createLayer() // send_message never registered here
    expect(layer2.listPending()).toHaveLength(0)
  })

  it('attachSurfaceId sets a null surface_id and never clobbers an existing one', async () => {
    const layer = createLayer()
    const db = dbOf(layer)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values ('effect-nosurface-1', 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', null, ?, ?, 'pending', null)`,
    ).run(
      JSON.stringify({ to: 'a@b.com', body: 'x' }),
      JSON.stringify(['trusted:user']),
      nowIso,
      expiresAt,
    )

    layer.attachSurfaceId('effect-nosurface-1', 'srf-approval-effect-nosurface-1')
    const row1 = db
      .prepare(`select surface_id from pending_approvals where id = ?`)
      .get('effect-nosurface-1') as { surface_id: string | null }
    expect(row1.surface_id).toBe('srf-approval-effect-nosurface-1')

    // A second call with a different value must never clobber the one already recorded.
    layer.attachSurfaceId('effect-nosurface-1', 'srf-approval-should-not-win')
    const row2 = db
      .prepare(`select surface_id from pending_approvals where id = ?`)
      .get('effect-nosurface-1') as { surface_id: string | null }
    expect(row2.surface_id).toBe('srf-approval-effect-nosurface-1')
  })
})

describe('hasPendingCardSurface (issue #14 review fix)', () => {
  /** Directly inserts a pending row with a `null` surface_id — simulates `createCard()` crashing before `setSurfaceId` runs (D7). */
  function insertNullSurfaceRow(layer: TrustLayer, id: string): void {
    const db = dbOf(layer)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values (?, 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', null, ?, ?, 'pending', null)`,
    ).run(
      id,
      JSON.stringify({ to: 'a@b.com', body: 'x' }),
      JSON.stringify(['trusted:user']),
      nowIso,
      expiresAt,
    )
  }

  it('rejects any surfaceId — including the canonical, deterministic one — while surface_id is still null', () => {
    const layer = createLayer()
    insertNullSurfaceRow(layer, 'effect-null-1')

    // A forged Surface at the guessable canonical id must not pass either.
    expect(layer.hasPendingCardSurface('effect-null-1', 'srf-approval-effect-null-1')).toBe(false)
    expect(layer.hasPendingCardSurface('effect-null-1', 'srf-approval-some-other-id')).toBe(false)
  })

  it('accepts only an exact surface_id match once one has been recorded', () => {
    const layer = createLayer()
    insertNullSurfaceRow(layer, 'effect-attached-1')
    layer.attachSurfaceId('effect-attached-1', 'srf-approval-effect-attached-1')

    expect(layer.hasPendingCardSurface('effect-attached-1', 'srf-approval-effect-attached-1')).toBe(
      true,
    )
    expect(layer.hasPendingCardSurface('effect-attached-1', 'srf-approval-impostor')).toBe(false)
  })

  it('returns false for an unknown approvalId', () => {
    const layer = createLayer()
    expect(layer.hasPendingCardSurface('effect-does-not-exist', 'srf-approval-anything')).toBe(
      false,
    )
  })
})

// The audit log's append-only triggers and its one-outcome-per-ref_id unique
// index are schema-level guarantees now covered directly against
// `TrustStore` in trust-store.test.ts (Fix 7).

describe('recovery (start())', () => {
  it('expires an overdue pending approval left over from a previous run', async () => {
    const layer1 = createLayer()
    const tool = sendMessageTool()
    layer1.register(tool, sendMessageMeta)
    await callWrapped(
      layer1,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    const surfaceId = port.onlySurfaceId()
    const effectId = port.surfaces.get(surfaceId)?.approval.id as string
    layer1.dispose()

    clock = new Date(clock.getTime() + 60 * 60 * 1000) // well past the default 30-minute TTL
    const layer2 = createLayer()
    layer2.register(sendMessageTool(), sendMessageMeta)
    await layer2.start()

    const outcome = layer2
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === effectId)
    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.outcome).toBe('expired')
    expect(port.surfaces.get(surfaceId)?.archived).toBe(true)
  })

  it('re-executes an interrupted executing row through the same effectId (idempotent recovery)', async () => {
    const layer1 = createLayer()
    const db = dbOf(layer1)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values ('effect-crash-1', 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', null, ?, ?, 'executing', ?)`,
    ).run(
      JSON.stringify({ to: 'alice@example.com', body: 'resumed' }),
      JSON.stringify(['trusted:user']),
      nowIso,
      expiresAt,
      nowIso,
    )
    layer1.dispose()

    let executions = 0
    const layer2 = createLayer()
    layer2.register(
      sendMessageTool(() => {
        executions += 1
      }),
      sendMessageMeta,
    )
    await layer2.start()

    expect(executions).toBe(1)
    const outcome = layer2
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === 'effect-crash-1')
    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.outcome).toBe('executed')
  })

  it('recovery dedupes the outcome event when the Space log already carries it but outcome_event_at never committed (Fix 6a crash window)', async () => {
    const loggedEffectIds = new Set<string>()
    const layer1 = createLayer({
      hasOutcomeEvent: (_spaceId, effectId) => loggedEffectIds.has(effectId),
    })
    const db = dbOf(layer1)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values ('effect-dupe-1', 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', null, ?, ?, 'executing', ?)`,
    ).run(
      JSON.stringify({ to: 'alice@example.com', body: 'resumed' }),
      JSON.stringify(['trusted:user']),
      nowIso,
      expiresAt,
      nowIso,
    )
    // Simulates the crash window: the Space log already carries this
    // effectId's outcome event from a prior (crashed) attempt, even though
    // `outcome_event_at` never committed.
    loggedEffectIds.add('effect-dupe-1')
    layer1.dispose()

    let executions = 0
    const layer2 = createLayer({
      hasOutcomeEvent: (_spaceId, effectId) => loggedEffectIds.has(effectId),
    })
    layer2.register(
      sendMessageTool(() => {
        executions += 1
      }),
      sendMessageMeta,
    )
    await layer2.start()

    // The handler itself still re-runs (the idempotent-executor contract,
    // unaffected by this fix) ...
    expect(executions).toBe(1)
    // ... but the outcome event is never doubled: it was never re-appended.
    expect(outcomeEvents).toHaveLength(0)
    // The row is still marked done, so a second recovery would not retry it.
    const row = dbOf(layer2)
      .prepare(`select outcome_event_at from pending_approvals where id = ?`)
      .get('effect-dupe-1') as { outcome_event_at: string | null }
    expect(row.outcome_event_at).not.toBeNull()
    const outcome = layer2
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === 'effect-dupe-1')
    expect(outcome).toHaveLength(1)
  })

  it('appends the Space outcome event exactly once for a terminal row whose event never landed (Fix 10 crash window)', async () => {
    const layer1 = createLayer()
    const db = dbOf(layer1)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at, outcome_event_at)
       values ('effect-lost-outcome-1', 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', 'srf-approval-effect-lost-outcome-1', ?, ?, 'approved', ?, null)`,
    ).run(
      JSON.stringify({ to: 'alice@example.com', body: 'hi' }),
      JSON.stringify(['trusted:user']),
      nowIso,
      expiresAt,
      nowIso,
    )
    // Simulates the crash window (Fix 10): the same transaction that set
    // status = 'approved' also inserted this action.outcome row
    // (executeAndFinalize's real behavior), but the daemon crashed before
    // appendOutcomeEventIfNeeded ran, so outcome_event_at is still null and
    // no Space event was ever appended.
    db.prepare(
      `insert into audit_log (at, kind, ref_id, tool_name, level, outcome, space_id)
       values (?, 'action.outcome', 'effect-lost-outcome-1', 'send_message', 'L1', 'executed', 'spc-test')`,
    ).run(nowIso)
    layer1.dispose()

    const layer2 = createLayer()
    layer2.register(sendMessageTool(), sendMessageMeta)
    await layer2.start()

    expect(outcomeEvents).toHaveLength(1)
    expect(outcomeEvents[0]?.payload.effectId).toBe('effect-lost-outcome-1')
    expect(outcomeEvents[0]?.payload.outcome).toBe('executed')
    expect(outcomeEvents[0]?.spaceId).toBe('spc-test')
    const row = dbOf(layer2)
      .prepare(`select outcome_event_at from pending_approvals where id = ?`)
      .get('effect-lost-outcome-1') as { outcome_event_at: string | null }
    expect(row.outcome_event_at).not.toBeNull()

    // Idempotent: a second recovery pass never re-appends it.
    await layer2.start()
    expect(outcomeEvents).toHaveLength(1)
  })

  it('marks an interrupted executing row indeterminate when its tool is no longer registered', async () => {
    const layer1 = createLayer()
    const db = dbOf(layer1)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values ('effect-gone-1', 'ghost_tool', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', null, ?, ?, 'executing', ?)`,
    ).run(JSON.stringify({}), JSON.stringify(['trusted:user']), nowIso, expiresAt, nowIso)
    layer1.dispose()

    const layer2 = createLayer() // ghost_tool is never registered on this instance
    await layer2.start()

    const outcome = layer2
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === 'effect-gone-1')
    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.outcome).toBe('error')
    expect(systemNotices.some((text) => text.includes('effect-gone-1'))).toBe(true)
  })

  it('expires a pending row whose tool is no longer registered, even if its TTL has not elapsed', async () => {
    const layer1 = createLayer()
    const db = dbOf(layer1)
    const nowIso = now().toISOString()
    const expiresAt = new Date(clock.getTime() + 60 * 60 * 1000).toISOString() // not overdue
    db.prepare(
      `insert into pending_approvals
         (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
          context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
       values ('effect-gone-2', 'ghost_tool', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
               'spc-test', 'srf-ghost', ?, ?, 'pending', null)`,
    ).run(JSON.stringify({}), JSON.stringify(['trusted:user']), nowIso, expiresAt)
    layer1.dispose()

    const layer2 = createLayer()
    await layer2.start()

    const outcome = layer2
      .auditEntries(50)
      .filter((e) => e.kind === 'action.outcome' && e.refId === 'effect-gone-2')
    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.outcome).toBe('expired')
  })
})

describe('onChange', () => {
  it('notifies subscribers on mutation and stops after unsubscribe', async () => {
    const layer = createLayer()
    const tool = sendMessageTool()
    layer.register(tool, sendMessageMeta)
    let calls = 0
    const unsubscribe = layer.onChange(() => {
      calls += 1
    })
    await callWrapped(
      layer,
      tool,
      { to: 'alice@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(calls).toBeGreaterThan(0)
    unsubscribe()
    const before = calls
    await callWrapped(
      layer,
      tool,
      { to: 'bob@example.com', body: 'hi' },
      toolContext({ spaceId: 'spc-test' }),
    )
    expect(calls).toBe(before)
  })
})
