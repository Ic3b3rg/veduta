import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import type { AtomNode, ApprovalCard } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type ToolContext, type ToolDef } from './agent-runner.ts'
import { Store } from './store.ts'
import { type Origin, TurnTaintAccumulator } from './taint.ts'
import {
  ApprovalSurfaceManager,
  approvalCardSurfaceId,
  buildApprovalCardSurface,
} from './approval-surface.ts'
import {
  DECISION_ALLOWLIST_CHECKBOX_KEY,
  DECISION_APPROVE_KEY,
  DECISION_REJECT_KEY,
  fieldStateKey,
  type ApprovalCardModel,
  type OutcomeEventPayload,
  type PendingApproval,
  type ToolMeta,
  TrustLayer,
} from './trust-layer.ts'

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  if (tree.id === id) return tree
  for (const child of tree.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function pendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'appr-1',
    toolName: 'send_message',
    level: 'L1',
    input: { to: 'a@b.com', body: 'hello' },
    effectiveOrigin: 'trusted:user',
    originChain: ['trusted:user'],
    contextHash: 'hash-1',
    toolCallId: 'call-1',
    spaceId: 'spc-health',
    createdAt: '2026-07-10T12:00:00.000Z',
    expiresAt: '2026-07-10T12:30:00.000Z',
    ...overrides,
  }
}

function cardModel(overrides: Partial<ApprovalCardModel> = {}): ApprovalCardModel {
  return {
    title: 'Send message to a@b.com',
    summary: 'hello',
    level: 'L1',
    effectiveOrigin: 'trusted:user',
    expiresAt: '2026-07-10T12:30:00.000Z',
    editableFields: [{ key: 'body', value: 'hello' }],
    showAllowlistCheckbox: true,
    ...overrides,
  }
}

describe('buildApprovalCardSurface', () => {
  it('builds a schema-valid card with title, caption, summary, editable field, checkbox, and decision buttons', () => {
    const approval = pendingApproval()
    const surface = buildApprovalCardSurface(approval, cardModel())

    expect(surface.id).toBe(approvalCardSurfaceId(approval.id))
    expect(surface.spaceId).toBe(approval.spaceId)
    expect(surface.title).toContain('Approval required')
    expect(surface.title).toContain('Send message to a@b.com')

    const title = findNode(surface.tree, 'title')
    expect(title?.props?.['text']).toBe('Approval required: Send message to a@b.com')

    const meta = findNode(surface.tree, 'meta')
    expect(meta?.props?.['text']).toContain('Level L1')
    expect(meta?.props?.['text']).toContain('origin trusted:user')
    expect(meta?.props?.['text']).toContain('expires 2026-07-10T12:30:00.000Z')

    const summary = findNode(surface.tree, 'summary')
    expect(summary?.type).toBe('Markdown')
    expect(summary?.props?.['text']).toBe('hello')

    const field = findNode(surface.tree, 'field-body')
    expect(field?.type).toBe('Input')
    expect(field?.binding).toBe(fieldStateKey('body'))
    expect(field?.actions).toEqual([
      { name: 'change', path: 'fast', stateKey: fieldStateKey('body'), payload: {} },
    ])
    expect(surface.state[fieldStateKey('body')]).toBe('hello')

    const checkbox = findNode(surface.tree, 'decision-allowlist')
    expect(checkbox?.type).toBe('Checkbox')
    expect(checkbox?.binding).toBe(DECISION_ALLOWLIST_CHECKBOX_KEY)
    expect(surface.state[DECISION_ALLOWLIST_CHECKBOX_KEY]).toBe(false)

    const approve = findNode(surface.tree, 'decision-approve')
    expect(approve?.actions?.[0]).toMatchObject({
      name: 'press',
      path: 'fast',
      stateKey: DECISION_APPROVE_KEY,
    })
    const reject = findNode(surface.tree, 'decision-reject')
    expect(reject?.actions?.[0]).toMatchObject({
      name: 'press',
      path: 'fast',
      stateKey: DECISION_REJECT_KEY,
    })
    expect(surface.state[DECISION_APPROVE_KEY]).toBe(false)
    expect(surface.state[DECISION_REJECT_KEY]).toBe(false)
  })

  it('omits the allowlist checkbox and its state key when the card model says it is not eligible', () => {
    const surface = buildApprovalCardSurface(
      pendingApproval(),
      cardModel({ showAllowlistCheckbox: false }),
    )
    expect(findNode(surface.tree, 'decision-allowlist')).toBeUndefined()
    expect(
      Object.prototype.hasOwnProperty.call(surface.state, DECISION_ALLOWLIST_CHECKBOX_KEY),
    ).toBe(false)
  })

  it('neutralizes delimiter-collision attempts and truncates a long summary', () => {
    const longBody = `<<<INJECTED>>> ${'x'.repeat(600)}`
    const surface = buildApprovalCardSurface(
      pendingApproval(),
      cardModel({ title: 'Send <<<evil>>> message', summary: longBody }),
    )
    const title = findNode(surface.tree, 'title')
    expect(title?.props?.['text']).not.toContain('<<<evil>>>')
    // Fix 9a: `Surface.title` must be neutralized exactly like the Title
    // atom's own text — both are derived from the same (possibly
    // untrusted-influenced) `card.title`.
    expect(surface.title).not.toContain('<<<evil>>>')

    const summaryText = findNode(surface.tree, 'summary')?.props?.['text']
    expect(typeof summaryText).toBe('string')
    expect(summaryText as string).not.toContain('<<<INJECTED>>>')
    expect((summaryText as string).length).toBeLessThanOrEqual(501)
    expect((summaryText as string).endsWith('…')).toBe(true)
  })

  it('renders a Textarea, not an Input, for a long or multi-line editable value', () => {
    const surface = buildApprovalCardSurface(
      pendingApproval(),
      cardModel({ editableFields: [{ key: 'body', value: 'line one\nline two' }] }),
    )
    expect(findNode(surface.tree, 'field-body')?.type).toBe('Textarea')
  })

  it('starts the validation-error Caption empty at the fixed index patchValidationError relies on', () => {
    const surface = buildApprovalCardSurface(pendingApproval(), cardModel())
    expect(surface.tree.children?.[3]?.id).toBe('error')
    expect(surface.tree.children?.[3]?.props?.['text']).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ApprovalSurfaceManager, wired to a real Store + TrustLayer (integration).
// ---------------------------------------------------------------------------

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

function toolContext(params: { origin?: Origin; toolCallId?: string } = {}): ToolContext {
  const origin = params.origin ?? 'trusted:user'
  return fromPartial<ToolContext>({
    toolCallId: params.toolCallId ?? 'call-1',
    origin,
    origins: [origin],
    taint: new TurnTaintAccumulator([origin]),
    spaceId: 'spc-health',
    trigger: { kind: 'chat' },
    contextHash: 'hash-1',
  })
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())
let store: Store
let manager: ApprovalSurfaceManager
let trust: TrustLayer
let approvalCards: ApprovalCard[]
let outcomeEvents: { spaceId: string; payload: OutcomeEventPayload }[]
let managerErrors: unknown[]

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-approval-surface-'))
  clock = new Date('2026-07-10T12:00:00.000Z')
  store = new Store({ rootDir, now })
  approvalCards = []
  outcomeEvents = []
  managerErrors = []
  manager = new ApprovalSurfaceManager({
    store,
    onError: (error) => managerErrors.push(error),
  })
  trust = new TrustLayer({
    rootDir,
    approvalCardPort: manager,
    onApprovalCard: (card) => approvalCards.push(card),
    appendOutcomeEvent: (spaceId, payload) => outcomeEvents.push({ spaceId, payload }),
    now,
  })
  manager.setTrust(trust)
})

afterEach(() => {
  trust.dispose()
  manager.dispose()
  rmSync(rootDir, { recursive: true, force: true })
})

/** Creates one card via the real trust layer + manager, returns its ids. */
async function createCard<TSchema extends z.ZodTypeAny>(
  tool: ToolDef<TSchema>,
  meta: ToolMeta<z.infer<TSchema>>,
  input: z.infer<TSchema>,
): Promise<{ approvalId: string; surfaceId: string }> {
  trust.register(tool, meta)
  const [wrapped] = trust.wrapTools([tool])
  if (!wrapped) throw new Error('wrapTools returned no tool')
  await wrapped.handler(input, toolContext())
  const card = approvalCards[approvalCards.length - 1]
  if (!card) throw new Error('no approval card was created')
  return { approvalId: card.id, surfaceId: card.surfaceId }
}

function pressButton(surfaceId: string, nodeId: string): void {
  store.invokeSurfaceAction(surfaceId, { nodeId, name: 'press', payload: { value: true } })
}

describe('ApprovalSurfaceManager (real Store + TrustLayer)', () => {
  it('resolves approve on a fast-path click on the Approve button', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      sendMessageTool((input) => executed.push(input)),
      sendMessageMeta,
      { to: 'a@b.com', body: 'hello' },
    )

    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toEqual([{ to: 'a@b.com', body: 'hello' }])
    expect(store.getSurface(surfaceId)).toBeUndefined() // archived
    expect(outcomeEvents).toHaveLength(1)
    expect(outcomeEvents[0]?.payload.outcome).toBe('executed')
    expect(managerErrors).toHaveLength(0)
  })

  it('resolves reject on a fast-path click on the Reject button, never executing the tool', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      sendMessageTool((input) => executed.push(input)),
      sendMessageMeta,
      { to: 'a@b.com', body: 'hello' },
    )

    pressButton(surfaceId, 'decision-reject')
    await manager.flush()

    expect(executed).toEqual([])
    expect(store.getSurface(surfaceId)).toBeUndefined() // archived
    expect(outcomeEvents).toHaveLength(1)
    expect(outcomeEvents[0]?.payload.outcome).toBe('rejected')
  })

  it('passes an edited field through readEditedFields into the executed input', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      sendMessageTool((input) => executed.push(input)),
      sendMessageMeta,
      { to: 'a@b.com', body: 'hello' },
    )

    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'field-body',
      name: 'change',
      payload: { value: 'edited text' },
    })
    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toEqual([{ to: 'a@b.com', body: 'edited text' }])
  })

  it('patches a validation-error Caption and keeps the card alive when the edit is invalid', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      sendMessageTool((input) => executed.push(input)),
      sendMessageMeta,
      { to: 'a@b.com', body: 'hello' },
    )

    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'field-body',
      name: 'change',
      payload: { value: '' }, // violates z.string().min(1)
    })
    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toEqual([])
    const stillPending = store.getSurface(surfaceId)
    expect(stillPending).toBeDefined()
    const errorText = findNode(stillPending!.tree, 'error')?.props?.['text']
    expect(typeof errorText).toBe('string')
    expect(errorText as string).not.toBe('')

    // Fixing the field and approving again now goes through.
    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'field-body',
      name: 'change',
      payload: { value: 'fixed' },
    })
    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toEqual([{ to: 'a@b.com', body: 'fixed' }])
    expect(store.getSurface(surfaceId)).toBeUndefined()
  })

  it('grants an allowlist rule when the checkbox is checked before approving', async () => {
    const { surfaceId } = await createCard(sendMessageTool(), sendMessageMeta, {
      to: 'a@b.com',
      body: 'hello',
    })

    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'decision-allowlist',
      name: 'toggle',
      payload: { value: true },
    })
    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    const rules = trust.listAllowlistRules()
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ toolName: 'send_message', params: { to: 'a@b.com' } })
  })

  it('never renders the allowlist checkbox for an L2 tool, and archive() still works with no edits', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      transferFundsTool((input) => executed.push(input)),
      transferFundsMeta,
      { to: 'a@b.com', amountUsd: 10 },
    )

    const surface = store.getSurface(surfaceId)
    expect(surface).toBeDefined()
    expect(findNode(surface!.tree, 'decision-allowlist')).toBeUndefined()

    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toEqual([{ to: 'a@b.com', amountUsd: 10 }])
    expect(store.getSurface(surfaceId)).toBeUndefined()
  })

  it('a doubled Approve click before the first resolution commits does not throw or execute twice', async () => {
    const executed: unknown[] = []
    const { surfaceId } = await createCard(
      sendMessageTool((input) => executed.push(input)),
      sendMessageMeta,
      { to: 'a@b.com', body: 'hello' },
    )

    // Two clicks, back-to-back, before either resolution has had a chance
    // to run: both produce non-duplicate fast mutations (no idempotencyKey),
    // so both are queued onto the manager's serialized resolution chain.
    pressButton(surfaceId, 'decision-approve')
    pressButton(surfaceId, 'decision-approve')
    await manager.flush()

    expect(executed).toHaveLength(1)
    expect(managerErrors).toHaveLength(0)
    expect(outcomeEvents).toHaveLength(1)
  })

  it('readEditedFields reflects the live Surface state, including the decision keys', async () => {
    const { surfaceId } = await createCard(sendMessageTool(), sendMessageMeta, {
      to: 'a@b.com',
      body: 'hello',
    })
    store.invokeSurfaceAction(surfaceId, {
      nodeId: 'field-body',
      name: 'change',
      payload: { value: 'edited' },
    })

    const fields = manager.readEditedFields(surfaceId)
    expect(fields[fieldStateKey('body')]).toBe('edited')
    expect(fields[DECISION_APPROVE_KEY]).toBe(false)
  })

  it('archive() is a graceful no-op on an already-archived (or unknown) surface', async () => {
    const { surfaceId } = await createCard(sendMessageTool(), sendMessageMeta, {
      to: 'a@b.com',
      body: 'hello',
    })
    manager.archive(surfaceId)
    expect(store.getSurface(surfaceId)).toBeUndefined()
    expect(() => manager.archive(surfaceId)).not.toThrow()
    expect(() => manager.archive('srf-approval-does-not-exist')).not.toThrow()
  })

  describe('start() — restart rehydration', () => {
    it('a pending card survives a restart as a clickable Approve/Reject card: fresh Store+TrustLayer+manager over the same rootDir, then an approve click executes the tool exactly once', async () => {
      const executed: unknown[] = []
      const { surfaceId } = await createCard(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
        { to: 'a@b.com', body: 'hello' },
      )
      // Nothing pressed yet: without rehydration, this card's clicks would
      // be silently dropped by a fresh manager (empty `cardSurfaces`).
      expect(executed).toEqual([])

      // Simulate a daemon restart: dispose the first generation, then wire
      // brand-new Store + TrustLayer + ApprovalSurfaceManager instances over
      // the exact same rootDir — nothing shared in memory with the above.
      trust.dispose()
      manager.dispose()

      const store2 = new Store({ rootDir, now })
      const manager2 = new ApprovalSurfaceManager({ store: store2 })
      const trust2 = new TrustLayer({
        rootDir,
        approvalCardPort: manager2,
        onApprovalCard: () => {},
        appendOutcomeEvent: () => {},
        now,
      })
      manager2.setTrust(trust2)
      trust2.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      await trust2.start()
      manager2.start()

      try {
        store2.invokeSurfaceAction(surfaceId, {
          nodeId: 'decision-approve',
          name: 'press',
          payload: { value: true },
        })
        await manager2.flush()

        expect(executed).toEqual([{ to: 'a@b.com', body: 'hello' }])
        expect(store2.getSurface(surfaceId)).toBeUndefined() // archived
      } finally {
        trust2.dispose()
        manager2.dispose()
      }
    })

    it('a click resolves correctly even before start() has run at all (Fix A: no dependency on the in-memory rehydration order)', async () => {
      const executed: unknown[] = []
      const { surfaceId } = await createCard(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
        { to: 'a@b.com', body: 'hello' },
      )

      // Simulate a daemon restart, same as above, but this time the click
      // lands before either `trust2.start()` (boot recovery) or
      // `manager2.start()` (Surface repair) has been called — the exact
      // race the review flagged: a click racing ahead of rehydration must
      // still resolve, not silently no-op.
      trust.dispose()
      manager.dispose()

      const store2 = new Store({ rootDir, now })
      const manager2 = new ApprovalSurfaceManager({ store: store2 })
      const trust2 = new TrustLayer({
        rootDir,
        approvalCardPort: manager2,
        onApprovalCard: () => {},
        appendOutcomeEvent: () => {},
        now,
      })
      manager2.setTrust(trust2)
      trust2.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      // Deliberately no `trust2.start()` / `manager2.start()` before the click.

      try {
        store2.invokeSurfaceAction(surfaceId, {
          nodeId: 'decision-approve',
          name: 'press',
          payload: { value: true },
        })
        await manager2.flush()

        expect(executed).toEqual([{ to: 'a@b.com', body: 'hello' }])
        expect(store2.getSurface(surfaceId)).toBeUndefined() // archived
      } finally {
        trust2.dispose()
        manager2.dispose()
      }
    })
  })

  describe('start() — null surface_id repair and impostor rejection (issue #14 review fix)', () => {
    /** Raw db access: simulates `createCard()` crashing between `insertApprovalRow` and `setSurfaceId` (D7), which no public API can otherwise construct. */
    interface RawDb {
      prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown }
    }
    function dbOf(t: TrustLayer): RawDb {
      return (t as unknown as { store: { db: RawDb } }).store.db
    }

    function insertNullSurfaceRow(id: string): void {
      const nowIso = now().toISOString()
      const expiresAt = new Date(clock.getTime() + 60_000).toISOString()
      dbOf(trust)
        .prepare(
          `insert into pending_approvals
             (id, tool_name, level, input_json, effective_origin, origin_chain_json, trigger_json,
              context_hash, tool_call_id, space_id, surface_id, created_at, expires_at, status, decision_at)
           values (?, 'send_message', 'L1', ?, 'trusted:user', ?, null, 'hash', 'call-1',
                   'spc-health', null, ?, ?, 'pending', null)`,
        )
        .run(
          id,
          JSON.stringify({ to: 'a@b.com', body: 'hello' }),
          JSON.stringify(['trusted:user']),
          nowIso,
          expiresAt,
        )
    }

    it('a click on the canonical surfaceId is rejected while surface_id is still null (forged/premature Surface)', async () => {
      const executed: unknown[] = []
      trust.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      insertNullSurfaceRow('effect-forged-1')
      const canonicalSurfaceId = approvalCardSurfaceId('effect-forged-1')
      // A well-formed card Surface already sits at the canonical id (e.g. an
      // attacker or a stale write raced ahead of repair) — its shape alone
      // must never be enough to accept a click before the trust store's own
      // row records this exact surface_id.
      store.createSurface(
        buildApprovalCardSurface(pendingApproval({ id: 'effect-forged-1' }), cardModel()),
        'job',
        { origin: 'trusted:system', daemonOwned: true },
      )

      pressButton(canonicalSurfaceId, 'decision-approve')
      await manager.flush()

      expect(executed).toEqual([])
      expect(managerErrors).toHaveLength(0) // handleFastMutation just no-ops; nothing to log here
    })

    it('recreates the canonical card from scratch when repairing a null surface_id row with no Surface yet', async () => {
      const executed: unknown[] = []
      trust.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      insertNullSurfaceRow('effect-repair-1')
      const canonicalSurfaceId = approvalCardSurfaceId('effect-repair-1')
      expect(store.getSurface(canonicalSurfaceId)).toBeUndefined()

      manager.start()

      expect(store.getSurface(canonicalSurfaceId)).toBeDefined()
      pressButton(canonicalSurfaceId, 'decision-approve')
      await manager.flush()
      expect(executed).toEqual([{ to: 'a@b.com', body: 'hello' }])
      expect(managerErrors).toHaveLength(0)
    })

    it('reattaches an existing daemon-owned Surface at the canonical id instead of recreating it', async () => {
      const executed: unknown[] = []
      trust.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      insertNullSurfaceRow('effect-reattach-1')
      const canonicalSurfaceId = approvalCardSurfaceId('effect-reattach-1')
      store.createSurface(
        buildApprovalCardSurface(pendingApproval({ id: 'effect-reattach-1' }), cardModel()),
        'job',
        { origin: 'trusted:system', daemonOwned: true },
      )

      manager.start()

      pressButton(canonicalSurfaceId, 'decision-approve')
      await manager.flush()
      expect(executed).toEqual([{ to: 'a@b.com', body: 'hello' }])
      expect(managerErrors).toHaveLength(0)
    })

    it('refuses to adopt a non-daemon-owned impostor Surface at the canonical id, leaves the approval pending, and logs via onError', async () => {
      const executed: unknown[] = []
      trust.register(
        sendMessageTool((input) => executed.push(input)),
        sendMessageMeta,
      )
      insertNullSurfaceRow('effect-impostor-1')
      const canonicalSurfaceId = approvalCardSurfaceId('effect-impostor-1')
      // Not daemon-owned: e.g. created by the Agent's own `create_surface`
      // tool, or a client write that merely collided with the guessable id.
      store.createSurface(
        buildApprovalCardSurface(pendingApproval({ id: 'effect-impostor-1' }), cardModel()),
        'agent',
      )

      manager.start()

      expect(managerErrors).toHaveLength(1)
      expect(String(managerErrors[0])).toContain(canonicalSurfaceId)
      // The row was never attached — start() must not have archived or
      // touched the impostor Surface, and the approval stays un-clickable.
      const [record] = trust.listPending().filter((r) => r.approval.id === 'effect-impostor-1')
      expect(record?.surfaceId).toBeUndefined()
      expect(store.getSurface(canonicalSurfaceId)).toBeDefined() // impostor left untouched

      pressButton(canonicalSurfaceId, 'decision-approve')
      await manager.flush()
      expect(executed).toEqual([])
    })
  })
})
