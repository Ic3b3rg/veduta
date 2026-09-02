import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_CHAT_PENDING_DECISION_REFERENCES,
  PENDING_DECISION_FALLBACK_FEEDBACK,
  SurfaceSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type ToolContext, type ToolDef } from './agent-runner.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { createChatLoop, type ChatLoop } from './chat-loop.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createGlobalChatTools, type GlobalChatTurnHooks } from './global-chat-tools.ts'
import {
  createFakeProvider,
  fakeFailure,
  fakeFailureWithText,
  fakeText,
  fakeTextAndToolCall,
  fakeToolCall,
  fakeUsage,
} from './fake-provider.ts'
import { ModelRouter, SpendingCapError, type RoutingConfig } from './model-routing.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'
import { TemplateEngine } from './template-engine.ts'
import { textBetweenMarkers } from './text-section.test-helpers.ts'

/**
 * Integration harness for the chat loop (issue #37): a real `Store`,
 * `ModelRouter`, and `PiJsonlSessionStore`, driven by `createFakeProvider()`
 * instead of a live model — the same "acceptance rests on the fake provider,
 * not live keys" contract `pi-agent-runner.ts`'s doc comments describe.
 */
interface Harness {
  store: Store
  router: ModelRouter
  fake: ReturnType<typeof createFakeProvider>
  chatLoop: ChatLoop
  frames: { clientId: string; frame: GatewayServerMessage }[]
  toolExecutions: { name: string; input: unknown }[]
  toolContexts: ToolContext[]
  toolsForCalls: (string | undefined)[]
  sessionStore: PiJsonlSessionStore
  /** `<rootDir>` the `Store` and `ModelRouter` both persist under — used to read `usage/<date>.jsonl` back for AC1's spend-attribution tail. */
  rootDir: string
  cleanup: () => void
}

function buildHarness(
  options: {
    reasoningCandidates?: number
    reasoningModelIds?: string[]
    now?: () => Date
    timeZone?: string
    /**
     * Issue #37 fix: makes `send` throw on the FIRST `chat.turn-delta` frame
     * only, simulating a delivery/accounting failure inside the runner's
     * event-bus subscriber — proving it never fails the turn, and that later
     * frames are still attempted (`h.frames` keeps recording every send that
     * doesn't throw, including subsequent deltas and the closing frame).
     */
    throwOnFirstDelta?: boolean
  } = {},
): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-chat-loop-root-'))
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'veduta-chat-loop-sessions-'))
  const cwd = mkdtempSync(join(tmpdir(), 'veduta-chat-loop-cwd-'))

  const store = new Store({ rootDir })
  const candidateCount = options.reasoningCandidates ?? 1
  // Distinct model ids per candidate only when the caller asks for them
  // (the failover test's session-marker assertion needs candidates the
  // fake provider — and therefore the session's `model-change` entries —
  // can actually tell apart); every other caller keeps the single
  // 'fake-model' every candidate has always shared.
  const reasoningModelIds =
    options.reasoningModelIds ?? Array.from({ length: candidateCount }, () => 'fake-model')
  const [firstModelId, ...additionalModelIds] = reasoningModelIds
  const fake = createFakeProvider({ modelId: firstModelId ?? 'fake-model', additionalModelIds })

  const config: RoutingConfig = {
    tiers: {
      reasoning: reasoningModelIds.map((modelId) => ({ provider: 'fake', modelId })),
      triage: [{ provider: 'fake', modelId: 'fake-model' }],
    },
    // No entry for 'fake': keyless, allowed (model-routing.ts's `candidates()`).
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 20 },
  }
  // No real backoff delay between failover attempts in tests.
  const router = new ModelRouter({ config, rootDir, sleep: async () => {} })
  const sessionStore = new PiJsonlSessionStore({ cwd, sessionsRoot })

  const toolExecutions: { name: string; input: unknown }[] = []
  const toolContexts: ToolContext[] = []
  const testTool: ToolDef = defineTool({
    name: 'test_tool',
    description: 'a test tool with an observable side effect',
    schema: z.object({ value: z.string() }),
    level: 'L0',
    egressDomains: [],
    handler: (input, context) => {
      toolExecutions.push({ name: 'test_tool', input })
      toolContexts.push(context)
      return { content: 'tool ok' }
    },
  })

  const toolsForCalls: (string | undefined)[] = []
  const frames: { clientId: string; frame: GatewayServerMessage }[] = []
  let deltaSendAttempts = 0

  const chatLoop = createChatLoop({
    store,
    router,
    sessionStore,
    bridge: fake,
    isTrustWrapped: () => false,
    toolsFor: (spaceId, hooks?: GlobalChatTurnHooks) => {
      toolsForCalls.push(spaceId)
      if (spaceId !== undefined) return [testTool]
      return [
        defineTool({
          ...testTool,
          handler: (input, context) => {
            const target = store.getSpace(input.value)
            if (!target) throw new Error(`unknown test Space: ${input.value}`)
            hooks?.onSpaceEntered?.(target)
            hooks?.onResultTarget?.({
              spaceId: target.id,
              spaceSlug: target.slug,
              spaceName: target.name,
            })
            toolExecutions.push({ name: 'test_tool', input })
            toolContexts.push(context)
            return {
              content: store.assembleSpaceContext(target.id),
              origins: store.spacesEngine.contextOrigins(target.id),
            }
          },
        }),
        defineTool({
          name: 'test_proposal',
          description: 'emit a pending Space proposal for the chat result',
          schema: z.object({}),
          level: 'L0',
          egressDomains: [],
          handler: () => {
            hooks?.onPendingDecision?.({
              id: 'space-proposal:proposal-test',
              kind: 'space-proposal',
              summary: 'Create Space “Travel”',
              scope: { type: 'global' },
              allowedResolutions: ['accept', 'reject'],
              state: 'pending',
              createdAt: '2026-08-25T10:00:00.000Z',
            })
            return { content: 'proposal ready' }
          },
        }),
        defineTool({
          name: 'test_unprojected_decision',
          description: 'observe a Pending decision unavailable to this chat projection',
          schema: z
            .object({
              count: z
                .number()
                .int()
                .min(1)
                .max(MAX_CHAT_PENDING_DECISION_REFERENCES + 1)
                .default(1),
            })
            .strict(),
          level: 'L0',
          egressDomains: [],
          handler: ({ count }) => {
            for (let index = 0; index < count; index += 1) {
              const suffix = index === 0 ? '' : `-${index + 1}`
              hooks?.onPendingDecisionObserved?.(`approval:effect-unavailable${suffix}`)
            }
            return { content: 'decision observed' }
          },
        }),
      ]
    },
    send: (clientId, frame) => {
      if (options.throwOnFirstDelta && frame.type === 'chat.turn-delta') {
        deltaSendAttempts += 1
        if (deltaSendAttempts === 1) {
          throw new Error('simulated delivery failure on the first delta')
        }
      }
      frames.push({ clientId, frame })
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  })

  return {
    store,
    router,
    fake,
    chatLoop,
    frames,
    toolExecutions,
    toolContexts,
    toolsForCalls,
    sessionStore,
    rootDir,
    cleanup: () => {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(sessionsRoot, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function chatEvent(
  overrides: Partial<NormalizedChannelEvent> & { text: string },
): NormalizedChannelEvent {
  return { adapterId: 'pwa', clientId: 'c1', receivedAt: new Date().toISOString(), ...overrides }
}

function globalSurfaceChatLoop(harness: Harness): ChatLoop {
  const templateEngine = new TemplateEngine({ store: harness.store })
  const focusedToolsFor = (spaceId: string) =>
    createFocusedSurfaceTools({ store: harness.store, templateEngine, spaceId })
  return createChatLoop({
    store: harness.store,
    router: harness.router,
    sessionStore: harness.sessionStore,
    bridge: harness.fake,
    isTrustWrapped: () => false,
    toolsFor: (spaceId, hooks?: GlobalChatTurnHooks) =>
      spaceId === undefined
        ? createGlobalChatTools({
            store: harness.store,
            focusedToolsFor,
            ...(hooks === undefined ? {} : { hooks }),
          })
        : focusedToolsFor(spaceId),
    send: (clientId, frame) => harness.frames.push({ clientId, frame }),
  })
}

describe('createChatLoop', () => {
  const harnesses: Harness[] = []
  function harness(options?: {
    reasoningCandidates?: number
    reasoningModelIds?: string[]
    now?: () => Date
    timeZone?: string
    throwOnFirstDelta?: boolean
  }): Harness {
    const built = buildHarness(options)
    harnesses.push(built)
    return built
  }

  afterEach(() => {
    for (const built of harnesses.splice(0)) built.cleanup()
  })

  it('streams a scripted text reply and logs the turn with spend attributed', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([{ message: fakeText('Hello there.'), usage: fakeUsage(0.05) }])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId }))

    const types = h.frames.map((f) => f.frame.type)
    expect(types[0]).toBe('chat.turn-start')
    expect(types.at(-1)).toBe('chat.turn-end')
    expect(types.filter((type) => type === 'chat.turn-delta').length).toBeGreaterThanOrEqual(1)
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      spaceId,
      message: { role: 'assistant', text: 'Hello there.' },
    })

    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    expect(turnEvents).toHaveLength(2)
    expect(turnEvents[0]).toMatchObject({
      origin: 'trusted:user',
      text: 'hi',
      payload: { role: 'user' },
    })
    expect(turnEvents[1]).toMatchObject({
      origin: 'trusted:system',
      text: 'Hello there.',
      payload: { role: 'assistant' },
    })

    expect(h.router.usage().tiers.reasoning.spentUsd).toBeCloseTo(0.05)

    // AC1's spend-attribution tail: the durable record under
    // `<rootDir>/usage/<today>.jsonl` (model-routing.ts's `usagePath`/
    // `recordSpend`), not just the in-memory snapshot above — attributed to
    // the `reasoning` tier, the same day.
    const today = new Date().toISOString().slice(0, 10)
    const usageLines = readFileSync(join(h.rootDir, 'usage', `${today}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const spendEntries = usageLines.filter((entry) => entry['kind'] === 'spend')
    expect(spendEntries).toHaveLength(1)
    expect(spendEntries[0]).toMatchObject({ tier: 'reasoning', usd: 0.05 })
  })

  it('gives a focused model the clock, tool boundary, and complete Surface-update contract', async () => {
    const h = harness({
      now: () => new Date('2026-08-11T17:53:00.000Z'),
      timeZone: 'Europe/Rome',
    })
    const spaceId = h.store.listSpaces()[0]!.id
    let systemPrompt: string | undefined
    h.fake.setResponses([
      {
        factory: (context) => {
          systemPrompt = context.systemPrompt ?? ''
          return fakeText('Understood.')
        },
      },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'update the visible card', spaceId }))

    expect(systemPrompt).toContain('list_surfaces')
    expect(systemPrompt).toContain('read_surface')
    expect(systemPrompt).toContain('patch_state')
    expect(systemPrompt).toContain('append_event does not change a Surface')
    expect(systemPrompt).toContain('Only claim a Surface changed after a successful mutation tool')
    expect(systemPrompt).toContain('identify every Surface in this Space affected by the message')
    expect(systemPrompt).toContain('update every dependent state field')
    expect(systemPrompt).toContain('Do not stop after the first applicable Surface or state field')
    expect(systemPrompt).toContain('create the complete layout with Pending leaf Atoms')
    expect(systemPrompt).toContain('replace each Pending Atom in place with a separate patch_tree')
    expect(systemPrompt).toContain('A newly created Surface starts at tree version 1')
    expect(systemPrompt).toContain('Never leave a Pending Atom unresolved after composition fails')
    expect(systemPrompt).toContain('declare relativeTime when creating it')
    expect(systemPrompt).toContain('give every new source record an ISO occurredAt')
    expect(systemPrompt).toContain('update every declared projectionStateKey in the same patch')
    expect(systemPrompt).toContain('never present an expired projection as current')
    expect(systemPrompt).toContain(
      'Current user-local date and time: 2026-08-11 19:53 (Europe/Rome)',
    )
    expect(systemPrompt).toContain('Use only the Veduta tools explicitly provided in this turn')
    expect(systemPrompt).toContain('Never call provider-native shell')
  })

  it('keeps System chat conversational and visibly redirects personal content without changing scope', async () => {
    const h = harness()
    const system = ensureSystemSpace(h.store.spacesEngine)
    const health = h.store.getSpace('spc-health')!
    const systemEventsBefore = h.store.eventLog(system.id).length
    const healthEventsBefore = h.store.eventLog(health.id)
    let systemPrompt = ''
    h.fake.setResponses([
      {
        factory: (context) => {
          systemPrompt = context.systemPrompt ?? ''
          return fakeText(
            'I cannot store personal content in System. Open Health and ask me there instead.',
          )
        },
      },
    ])

    await h.chatLoop.handleChatMessage(
      chatEvent({ text: 'Remember that my next run is Friday', spaceId: system.id }),
    )

    expect(systemPrompt).toContain('Gateway-owned System Space')
    expect(systemPrompt).toContain('read-only status')
    expect(systemPrompt).toContain('Never create or patch')
    expect(systemPrompt).toContain('Do not write FACTS or INSTRUCTIONS')
    expect(systemPrompt).toContain('do not silently change scope')
    expect(systemPrompt).toContain('visibly direct the user')
    expect(systemPrompt).toContain('# User life-area Spaces')
    expect(systemPrompt).toContain(`- ${health.name} (slug: ${health.slug}; id: ${health.id})`)
    expect(systemPrompt).not.toContain('Surface authoring also applies')
    expect(h.frames.at(-1)?.frame).toMatchObject({
      type: 'chat.turn-end',
      spaceId: system.id,
      message: {
        text: 'I cannot store personal content in System. Open Health and ask me there instead.',
      },
    })
    expect(h.store.eventLog(system.id).slice(systemEventsBefore)).toMatchObject([
      { type: 'turn', payload: { role: 'user' } },
      { type: 'turn', payload: { role: 'assistant' } },
    ])
    expect(h.store.eventLog(health.id)).toEqual(healthEventsBefore)
    expect(h.toolsForCalls).toContain(system.id)
  })

  it('bounds the System Space Event context and keeps an omitted origin out of live turn taint', async () => {
    const h = harness()
    const system = ensureSystemSpace(h.store.spacesEngine)
    h.store.spacesEngine.appendEvent(system.id, {
      type: 'budget.system',
      text: `oversized-system-event-${'x'.repeat(8_000)}`,
      origin: 'untrusted:webhook',
    })
    let systemPrompt = ''
    h.fake.setResponses([
      {
        factory: (context) => {
          systemPrompt = context.systemPrompt ?? ''
          return fakeTextAndToolCall('Checking status.', 'test_tool', { value: 'status' })
        },
      },
      { message: fakeText('System status checked.') },
    ])

    await h.chatLoop.handleChatMessage(
      chatEvent({ text: 'Check the System status', spaceId: system.id }),
    )

    const eventSection = textBetweenMarkers(
      systemPrompt,
      '# Recent Event log',
      '\n\n# User life-area Spaces',
    )
    expect(eventSection.length).toBeLessThanOrEqual(8_000)
    expect(eventSection).not.toContain('oversized-system-event-')
    expect(eventSection).toContain(
      '1 Event record omitted from automatic context under the 20-Event and 8,000 UTF-16-code-unit rendered limits',
    )
    expect(h.toolContexts[0]?.origins).not.toContain('untrusted:webhook')
  })

  it('an observer failure (send throwing on the first delta) never fails the turn, still delivers later frames, and never triggers failover (issue #37 fix)', async () => {
    const h = harness({ throwOnFirstDelta: true })
    const spaceId = h.store.listSpaces()[0]!.id
    // Long enough that the faux stream's token-chunking (~12-20 chars per
    // delta) splits it into more than one `text-delta` event — the whole
    // point is that only the FIRST delta's `send` call throws, so a second
    // one has to exist for "later frames still delivered" to mean anything.
    h.fake.setResponses([
      {
        message: fakeText(
          'This is a deliberately long scripted reply so the fake provider streams it as ' +
            'several delta chunks instead of just one, exercising the observer past its first failure.',
        ),
      },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId }))

    const types = h.frames.map((f) => f.frame.type)
    // The turn still completed end to end despite the mid-stream delivery
    // failure: start and end frames both present, and the closing frame
    // carries the FULL text — the accumulator that builds it lives outside
    // the try/catch that swallowed the failed send, so a delivery failure
    // never corrupts the turn's own bookkeeping.
    expect(types[0]).toBe('chat.turn-start')
    expect(types.at(-1)).toBe('chat.turn-end')
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { role: 'assistant', text: expect.stringContaining('deliberately long scripted') },
    })

    // Later deltas were still attempted after the first one threw — the
    // failure is scoped to that one `send` call, not fatal to the whole
    // subscriber for the rest of the turn.
    expect(types.filter((type) => type === 'chat.turn-delta').length).toBeGreaterThan(0)

    // Exactly one router call, and it succeeded: the observer's throw never
    // propagated into `runner.prompt()`'s rejection path, so `ModelRouter`
    // never saw a retryable failure and never failed over to another candidate.
    expect(h.router.callLog()).toHaveLength(1)
    expect(h.router.callLog()[0]?.outcome).toBe('ok')

    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    expect(turnEvents).toHaveLength(2)
    expect(turnEvents[1]).toMatchObject({ payload: { role: 'assistant' } })
  })

  it('executes a tool call before finishing with text, as one logical turn', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([
      { message: fakeToolCall('test_tool', { value: 'x' }) },
      { message: fakeText('done') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'do it', spaceId }))

    expect(h.toolExecutions).toEqual([{ name: 'test_tool', input: { value: 'x' } }])

    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    expect(turnEvents).toHaveLength(2)
    expect(turnEvents[0]!.payload).toMatchObject({ role: 'user' })
    expect(turnEvents[1]!.payload).toMatchObject({
      role: 'assistant',
      toolCalls: [{ toolName: 'test_tool' }],
    })
    // The tool-call call carried no text of its own, so it contributes no
    // segment: the final text is just the closing call's, with no leading
    // separator (chat-loop.ts's `runTurn`: a call with no text of its own
    // never introduces a spurious blank-line separator).
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { role: 'assistant', text: 'done' },
    })
  })

  it('provides the initiating PWA client and Gateway turn id to every chat tool call', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([
      { message: fakeToolCall('test_tool', { value: 'x' }) },
      { message: fakeText('done') },
    ])

    await h.chatLoop.handleChatMessage(
      chatEvent({ clientId: 'pwa-initiator', text: 'create it', spaceId }),
    )

    const start = h.frames.find(({ frame }) => frame.type === 'chat.turn-start')?.frame
    if (!start || start.type !== 'chat.turn-start') throw new Error('expected a turn start')
    expect(h.toolContexts).toHaveLength(1)
    expect(h.toolContexts[0]?.initiatingTurn).toEqual({
      clientId: 'pwa-initiator',
      turnId: start.turnId,
    })
  })

  it('joins a multi-model-call turn segments with a blank line instead of concatenating them', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([
      { message: fakeTextAndToolCall('Logged: a pizza.', 'test_tool', { value: 'x' }) },
      { message: fakeText('Done — patch_state completed.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'log a pizza', spaceId }))

    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: {
        role: 'assistant',
        text: 'Logged: a pizza.\n\nDone — patch_state completed.',
      },
    })

    // The streamed deltas reconstruct into the exact same text: the
    // synthetic `\n\n` separator delta lands between the two real segments,
    // never before the first or after the last.
    const deltaText = h.frames
      .filter((f) => f.frame.type === 'chat.turn-delta')
      .map((f) => (f.frame as { text: string }).text)
      .join('')
    expect(deltaText).toBe('Logged: a pizza.\n\nDone — patch_state completed.')

    // The Event log entry for the assistant turn carries the same joined text.
    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    expect(turnEvents[1]).toMatchObject({
      text: 'Logged: a pizza.\n\nDone — patch_state completed.',
    })
  })

  it('fails over to the next candidate: one user event, error-then-ok call log, one stored user message, session model marker updated', async () => {
    // Distinct model ids per candidate (fake-model-1/-2) so the session's
    // model marker after failover can only match if it genuinely reflects
    // the SECOND candidate, not just "a" candidate identical to the first.
    const h = harness({
      reasoningCandidates: 2,
      reasoningModelIds: ['fake-model-1', 'fake-model-2'],
    })
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([{ message: fakeFailure(500) }, { message: fakeText('recovered') }])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'retry me', spaceId }))

    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { text: 'recovered' },
    })

    const userEvents = h.store
      .eventLog(spaceId)
      .filter((event) => event.type === 'turn' && event.payload?.['role'] === 'user')
    expect(userEvents).toHaveLength(1)

    const calls = h.router.callLog()
    expect(calls.map((call) => call.outcome)).toEqual(['error', 'ok'])
    expect(calls[0]?.model.modelId).toBe('fake-model-1')
    expect(calls[1]?.model.modelId).toBe('fake-model-2')

    const branch = await h.sessionStore.load(`space:${spaceId}`)
    const storedUserMessages = branch.messages.filter(
      (message) => message.role === 'user' && message.content === 'retry me',
    )
    expect(storedUserMessages).toHaveLength(1)

    // AC3's tail: the session's model marker (`SessionBranch.model`,
    // surfaced through the branch's `model-change` entries —
    // pi-agent-runner.ts) reflects the candidate that actually completed
    // the turn, the second one, not the one that failed first.
    expect(branch.model?.modelId).toBe('fake-model-2')
  })

  it("does not concatenate a failed attempt's already-streamed partial text onto the successful retry's reply", async () => {
    // The failed candidate streams real text before erroring
    // (`fakeFailureWithText`: pi-ai's faux core emits every content block's
    // text as delta events before checking `stopReason`) — proving the
    // per-attempt accumulator reset actually discards it, rather than the
    // retry's genuine reply concatenating onto a stale prefix.
    const h = harness({
      reasoningCandidates: 2,
      reasoningModelIds: ['fake-model-1', 'fake-model-2'],
    })
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([
      { message: fakeFailureWithText(500, 'stale partial text from the failed attempt') },
      { message: fakeText('Recovered answer.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'retry me', spaceId }))

    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { role: 'assistant', text: 'Recovered answer.' },
    })

    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    const assistantEvent = turnEvents.find((event) => event.payload?.['role'] === 'assistant')
    expect(assistantEvent).toMatchObject({ text: 'Recovered answer.' })
  })

  it('does not fail over once a tool has already executed this attempt, even with a next candidate available (issue #37 fix)', async () => {
    // Two reasoning candidates: without the fix, the failing second model
    // call (after `test_tool` already ran) would be retryable and the
    // router would fail over into a SECOND `runner.prompt()` attempt —
    // re-seeding the agent from the session store and risking re-executing
    // the already-executed tool. With the fix, a tool having executed this
    // attempt forces `NonRetryableModelError`, so the router never tries
    // candidate 2 at all.
    const h = harness({
      reasoningCandidates: 2,
      reasoningModelIds: ['fake-model-1', 'fake-model-2'],
    })
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([
      { message: fakeToolCall('test_tool', { value: 'x' }) },
      { message: fakeFailure(500) },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'do it then fail', spaceId }))

    // The tool ran exactly once — a failover retry would have replayed it.
    expect(h.toolExecutions).toEqual([{ name: 'test_tool', input: { value: 'x' } }])

    // A single error entry: no failover attempt against candidate 2.
    const calls = h.router.callLog()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.outcome).toBe('error')

    const types = h.frames.map((f) => f.frame.type)
    expect(types.filter((type) => type === 'chat.turn-error')).toHaveLength(1)
    expect(types).not.toContain('chat.turn-end')

    // The user event was appended exactly once — no duplicate from a retry.
    const userEvents = h.store
      .eventLog(spaceId)
      .filter((event) => event.type === 'turn' && event.payload?.['role'] === 'user')
    expect(userEvents).toHaveLength(1)
  })

  it('does not fail over on a non-retryable error: single turn-error frame, no assistant event', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([{ message: fakeFailure(400) }])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'bad', spaceId }))

    const types = h.frames.map((f) => f.frame.type)
    expect(types[0]).toBe('chat.turn-start')
    expect(types.filter((type) => type === 'chat.turn-error')).toHaveLength(1)
    expect(types).not.toContain('chat.turn-end')
    expect(h.router.callLog()).toHaveLength(1)
    expect(h.router.callLog()[0]!.outcome).toBe('error')

    const turnEvents = h.store.eventLog(spaceId).filter((event) => event.type === 'turn')
    expect(turnEvents).toHaveLength(1)
    expect(turnEvents[0]!.payload).toMatchObject({ role: 'user' })
  })

  it('serializes two turns on the same Space: no frame interleaving', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    h.fake.setResponses([{ message: fakeText('first') }, { message: fakeText('second') }])

    const first = h.chatLoop.handleChatMessage(chatEvent({ text: 'one', spaceId }))
    const second = h.chatLoop.handleChatMessage(chatEvent({ text: 'two', spaceId }))
    await Promise.all([first, second])

    const startIndexes = h.frames.flatMap((f, i) => (f.frame.type === 'chat.turn-start' ? [i] : []))
    const endIndexes = h.frames.flatMap((f, i) => (f.frame.type === 'chat.turn-end' ? [i] : []))
    expect(startIndexes).toHaveLength(2)
    expect(endIndexes).toHaveLength(2)
    // Every frame of turn 1 (start..end) precedes turn 2's start frame.
    expect(endIndexes[0]).toBeLessThan(startIndexes[1]!)
  })

  it('caps: an exhausted reasoning tier still lets a user chat turn execute, but refuses a proactive reasoning call', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id

    // Exhaust the reasoning tier's daily cap directly (model-routing.ts's
    // per-tier semantics: only PROACTIVE calls consult `proactivityAllowed`).
    h.router.recordSpend({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' }, 1000)
    expect(h.router.proactivityAllowed('reasoning')).toBe(false)

    // (i) a user-origin chat turn still executes — the cap never blocks
    // `origin: 'user'` calls (`assertSpendingAllowed`), so the turn's frames
    // end normally, exactly as an unexhausted tier would.
    h.fake.setResponses([{ message: fakeText('still here') }])
    await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId }))
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { role: 'assistant', text: 'still here' },
    })

    // (ii) a proactive execute against the same exhausted tier is refused
    // before `fn` ever runs — `heartbeat-reasoning` always routes to the
    // `reasoning` tier (model-routing.ts's `tierForRequest`).
    let proactiveFnCalled = false
    await expect(
      h.router.execute({ purpose: 'heartbeat-reasoning', origin: 'proactive' }, async () => {
        proactiveFnCalled = true
        return 'never'
      }),
    ).rejects.toThrow(SpendingCapError)
    expect(proactiveFnCalled).toBe(false)
  })

  it('a global chat turn that enters no Space leaves every Space Event log untouched', async () => {
    const h = harness()
    const spaceId = h.store.listSpaces()[0]!.id
    const before = h.store.eventLog(spaceId).length
    h.fake.setResponses([{ message: fakeText('hello globally') }])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi global' }))

    const types = h.frames.map((f) => f.frame.type)
    expect(types[0]).toBe('chat.turn-start')
    expect(types.at(-1)).toBe('chat.turn-end')
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { role: 'assistant', text: 'hello globally' },
    })
    expect(h.store.eventLog(spaceId)).toHaveLength(before)
    expect(h.toolsForCalls).toContain(undefined)
  })

  it('gives global chat a bounded active roster and an honest multi-Space targeting policy', async () => {
    const h = harness()
    ensureSystemSpace(h.store.spacesEngine)
    const privateSpace = h.store.spacesEngine.createSpace({ name: 'Private Notes' })
    h.store.spacesEngine.appendEvent(privateSpace.id, {
      type: 'private.test',
      text: 'UNRELATED-SPACE-CONTEXT-MUST-STAY-OUT',
      origin: 'trusted:user',
    })
    for (let index = 0; index < 55; index += 1) {
      h.store.spacesEngine.createSpace({ name: `Roster ${String(index).padStart(2, '0')}` })
    }
    const archived = h.store.spacesEngine.createSpace({ name: 'Archived roster entry' })
    h.store.archiveSpace(archived.id)
    let systemPrompt = ''
    h.fake.setResponses([
      {
        factory: (context) => {
          systemPrompt = context.systemPrompt ?? ''
          return fakeText('Understood.')
        },
      },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'coordinate my plans' }))

    const roster = systemPrompt.split('# Active Spaces\n\n')[1]?.split('\n\n')[0] ?? ''
    expect(roster.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(50)
    expect(roster).toContain('additional active Spaces omitted')
    expect(roster).not.toContain('Archived roster entry')
    expect(roster).not.toContain('System (slug: system')
    expect(systemPrompt).toContain('call enter_space before any scoped tool')
    expect(systemPrompt).toContain('Enter every target again on each turn')
    expect(systemPrompt).toContain('When exactly one existing Space is unambiguous, act directly')
    expect(systemPrompt).toContain('When multiple Spaces are plausible, ask the user')
    expect(systemPrompt).toContain('use propose_space and stop before creating a Space or Surface')
    expect(systemPrompt).toContain('One turn may enter and work in multiple Spaces')
    expect(systemPrompt).not.toContain('this conversation is for talking only')
    expect(systemPrompt).not.toContain('UNRELATED-SPACE-CONTEXT-MUST-STAY-OUT')
  })

  it('keeps a previously entered Space context out of a later unrelated global turn', async () => {
    const h = harness()
    const health = h.store.getSpace('spc-health')!
    h.store.spacesEngine.appendEvent(health.id, {
      type: 'private.test',
      text: 'HEALTH-ONLY-CONTEXT-MUST-NOT-CROSS-TURNS',
      origin: 'untrusted:gmail',
    })
    let secondTurnContext = ''
    h.fake.setResponses([
      { message: fakeToolCall('test_tool', { value: health.id }) },
      { message: fakeText('Health summary retained in conversation.') },
      {
        factory: (context) => {
          secondTurnContext = JSON.stringify(context.messages)
          return fakeText('Work only.')
        },
      },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Summarize Health' }))
    expect(
      (await h.sessionStore.load('global')).messages.find(
        (message) => message.content === 'Health summary retained in conversation.',
      ),
    ).toMatchObject({ role: 'assistant', origin: 'untrusted:gmail' })
    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Now discuss Work only' }))

    expect(secondTurnContext).toContain('Health summary retained in conversation.')
    expect(secondTurnContext).not.toContain('HEALTH-ONLY-CONTEXT-MUST-NOT-CROSS-TURNS')
    expect(secondTurnContext).not.toContain('FACTS')
  })

  it('asks on an ambiguous global request and writes no Space Event', async () => {
    const h = harness()
    const work = h.store.spacesEngine.createSpace({ name: 'Work' })
    const before = new Map(
      h.store.listSpaces().map((space) => [space.id, h.store.eventLog(space.id).length]),
    )
    h.fake.setResponses([{ message: fakeText('Do you mean Health or Work?') }])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Update my plan' }))

    expect(h.frames.at(-1)?.frame).toMatchObject({
      type: 'chat.turn-end',
      message: { text: 'Do you mean Health or Work?' },
    })
    expect(h.toolExecutions).toEqual([])
    for (const space of [h.store.getSpace('spc-health')!, work]) {
      expect(h.store.eventLog(space.id)).toHaveLength(before.get(space.id)!)
    }
  })

  it('logs one correlated global turn only in entered Spaces and returns deduplicated result targets', async () => {
    const h = harness()
    const space = h.store.listSpaces()[0]!
    h.fake.setResponses([
      { message: fakeToolCall('test_tool', { value: space.id }) },
      { message: fakeText('Health updated.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'update Health' }))

    const start = h.frames.find(({ frame }) => frame.type === 'chat.turn-start')?.frame
    if (!start || start.type !== 'chat.turn-start') throw new Error('expected a turn start')
    expect(h.frames.at(-1)!.frame).toMatchObject({
      type: 'chat.turn-end',
      message: {
        role: 'assistant',
        text: 'Health updated.',
        targets: [
          {
            spaceId: space.id,
            spaceSlug: space.slug,
            spaceName: space.name,
          },
        ],
      },
    })

    const turns = h.store.eventLog(space.id).filter((event) => event.type === 'turn')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      text: 'update Health',
      origin: 'trusted:user',
      payload: { role: 'user', correlationId: start.turnId },
    })
    expect(turns[1]).toMatchObject({
      text: 'Health updated.',
      payload: {
        role: 'assistant',
        correlationId: start.turnId,
        toolCalls: [{ toolName: 'test_tool' }],
      },
    })

    for (const other of h.store.listSpaces().filter((candidate) => candidate.id !== space.id)) {
      expect(
        h.store
          .eventLog(other.id)
          .filter((event) => event.payload?.['correlationId'] === start.turnId),
      ).toEqual([])
    }
  })

  it('refuses a blind global mutation through AgentRunner before entering its Space', async () => {
    const h = harness()
    const health = h.store.getSpace('spc-health')!
    h.store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-blind-plan',
        spaceId: health.id,
        title: 'Blind plan',
        tree: { id: 'root', type: 'Stat', binding: 'status', props: { label: 'Status' } },
        state: { status: 'Before' },
        freshness: { updatedAt: '2026-08-25T10:00:00.000Z', updatedBy: 'seed' },
      }),
      'agent',
    )
    const loop = globalSurfaceChatLoop(h)
    h.fake.setResponses([
      {
        message: fakeToolCall('patch_state', {
          spaceId: health.id,
          surfaceId: 'srf-blind-plan',
          operations: [{ target: 'state', op: 'replace', path: '/status', value: 'Changed' }],
        }),
      },
      { message: fakeText('I need to enter Health first.') },
    ])

    try {
      await loop.handleChatMessage(chatEvent({ text: 'Change the Health plan' }))

      expect(h.store.getSurface('srf-blind-plan')?.state['status']).toBe('Before')
      expect(h.frames.at(-1)?.frame).toMatchObject({
        type: 'chat.turn-end',
        message: { text: 'I need to enter Health first.' },
      })
      expect(
        h.store
          .eventLog(health.id)
          .filter((event) => event.payload?.['correlationId'] !== undefined),
      ).toEqual([])
    } finally {
      await loop.stop()
    }
  })

  it('refuses an archived global target through AgentRunner without writing it', async () => {
    const h = harness()
    const archived = h.store.spacesEngine.createSpace({ name: 'Archived Plans' })
    h.store.archiveSpace(archived.id)
    const before = h.store.eventLog(archived.id).length
    const loop = globalSurfaceChatLoop(h)
    h.fake.setResponses([
      { message: fakeToolCall('enter_space', { spaceId: archived.id }) },
      { message: fakeText('That Space is archived.') },
    ])

    try {
      await loop.handleChatMessage(chatEvent({ text: 'Read Archived Plans' }))

      expect(h.frames.at(-1)?.frame).toMatchObject({
        type: 'chat.turn-end',
        message: { text: 'That Space is archived.' },
      })
      expect(h.store.eventLog(archived.id)).toHaveLength(before)
    } finally {
      await loop.stop()
    }
  })

  it('runs one Agent turn that enters and mutates two Spaces with one correlation', async () => {
    const h = harness()
    const health = h.store.getSpace('spc-health')!
    const work = h.store.spacesEngine.createSpace({ name: 'Work' })
    for (const [space, surfaceId, title] of [
      [health, 'srf-health-plan', 'Health plan'],
      [work, 'srf-work-plan', 'Work plan'],
    ] as const) {
      h.store.createSurface(
        SurfaceSchema.parse({
          id: surfaceId,
          spaceId: space.id,
          title,
          tree: { id: 'root', type: 'Stat', binding: 'status', props: { label: 'Status' } },
          state: { status: 'Before' },
          freshness: { updatedAt: '2026-08-25T10:00:00.000Z', updatedBy: 'seed' },
        }),
        'agent',
      )
    }
    const multiSpaceLoop = globalSurfaceChatLoop(h)
    h.fake.setResponses([
      { message: fakeToolCall('enter_space', { spaceId: health.id }) },
      { message: fakeToolCall('enter_space', { spaceId: work.id }) },
      {
        message: fakeToolCall('patch_state', {
          spaceId: health.id,
          surfaceId: 'srf-health-plan',
          operations: [{ target: 'state', op: 'replace', path: '/status', value: 'Ready' }],
        }),
      },
      {
        message: fakeToolCall('patch_state', {
          spaceId: work.id,
          surfaceId: 'srf-work-plan',
          operations: [{ target: 'state', op: 'replace', path: '/status', value: 'Ready' }],
        }),
      },
      { message: fakeText('Both plans are ready.') },
    ])

    try {
      await multiSpaceLoop.handleChatMessage(
        chatEvent({ text: 'Coordinate Health training with Work deadlines' }),
      )

      const start = h.frames.find(({ frame }) => frame.type === 'chat.turn-start')?.frame
      if (!start || start.type !== 'chat.turn-start') throw new Error('expected global turn start')
      expect(h.store.getSurface('srf-health-plan')?.state['status']).toBe('Ready')
      expect(h.store.getSurface('srf-work-plan')?.state['status']).toBe('Ready')
      expect(h.frames.at(-1)?.frame).toMatchObject({
        type: 'chat.turn-end',
        message: {
          text: 'Both plans are ready.',
          targets: [
            expect.objectContaining({ spaceId: health.id, surfaceId: 'srf-health-plan' }),
            expect.objectContaining({ spaceId: work.id, surfaceId: 'srf-work-plan' }),
          ],
        },
      })

      for (const [spaceId, surfaceId] of [
        [health.id, 'srf-health-plan'],
        [work.id, 'srf-work-plan'],
      ] as const) {
        const correlated = h.store
          .eventLog(spaceId)
          .filter((event) => event.payload?.['correlationId'] === start.turnId)
        expect(correlated.some((event) => event.payload?.['role'] === 'user')).toBe(true)
        expect(
          correlated.some(
            (event) =>
              event.type === 'surface.patch_state' && event.payload?.['surfaceId'] === surfaceId,
          ),
        ).toBe(true)
        expect(correlated.some((event) => event.payload?.['role'] === 'assistant')).toBe(true)
      }
    } finally {
      await multiSpaceLoop.stop()
    }
  })

  it('returns a pending Space proposal for one-tap resolution without entering a Space', async () => {
    const h = harness()
    h.fake.setResponses([
      {
        message: fakeTextAndToolCall('Done — the Travel Space was created.', 'test_proposal', {}),
      },
      { message: fakeText('Done — the Travel Space was created.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Plan a trip to Japan' }))

    expect(h.frames.at(-1)?.frame).toMatchObject({
      type: 'chat.turn-end',
      message: {
        role: 'assistant',
        text: 'Awaiting your decision: Create Space “Travel”.',
        pendingDecisions: [
          {
            id: 'space-proposal:proposal-test',
            kind: 'space-proposal',
            state: 'pending',
          },
        ],
      },
    })
    const replacementIndex = h.frames.findIndex(({ frame }) => frame.type === 'chat.turn-replace')
    expect(replacementIndex).toBeGreaterThan(0)
    expect(h.frames[replacementIndex]?.frame).toMatchObject({
      type: 'chat.turn-replace',
      message: {
        text: 'Awaiting your decision: Create Space “Travel”.',
        pendingDecisions: [{ id: 'space-proposal:proposal-test' }],
      },
    })
    expect(
      h.frames
        .slice(0, replacementIndex)
        .filter(({ frame }) => frame.type === 'chat.turn-delta')
        .map(({ frame }) => (frame as { text: string }).text)
        .join(''),
    ).toContain('Done — the Travel Space was created.')
    expect(
      h.frames.slice(replacementIndex + 1).filter(({ frame }) => frame.type === 'chat.turn-delta'),
    ).toEqual([])
    const pendingFrames = h.frames.filter(
      ({ frame }) =>
        (frame.type === 'chat.turn-replace' || frame.type === 'chat.turn-end') &&
        frame.message.pendingDecisions?.some(
          (decision) => decision.id === 'space-proposal:proposal-test',
        ),
    )
    expect(new Set(pendingFrames.map(({ clientId }) => clientId))).toEqual(new Set(['c1']))
    expect(
      new Set(
        pendingFrames.flatMap(({ frame }) =>
          frame.type === 'chat.turn-replace' || frame.type === 'chat.turn-end'
            ? [frame.turnId]
            : [],
        ),
      ).size,
    ).toBe(1)
    for (const space of h.store.listSpaces()) {
      expect(
        h.store
          .eventLog(space.id)
          .filter((event) => event.payload?.['correlationId'] !== undefined),
      ).toEqual([])
    }
  })

  it('retains the exact id when an observed Pending decision cannot be projected', async () => {
    const h = harness()
    h.fake.setResponses([
      {
        message: fakeTextAndToolCall(
          'Done — the operation completed.',
          'test_unprojected_decision',
          {},
        ),
      },
      { message: fakeText('Done — the operation completed.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Run the operation' }))

    expect(h.frames.find(({ frame }) => frame.type === 'chat.turn-replace')?.frame).toMatchObject({
      type: 'chat.turn-replace',
      message: {
        text: PENDING_DECISION_FALLBACK_FEEDBACK,
        pendingDecisionIds: ['approval:effect-unavailable'],
      },
    })
    expect(h.frames.at(-1)?.frame).toMatchObject({
      type: 'chat.turn-end',
      message: {
        text: PENDING_DECISION_FALLBACK_FEEDBACK,
        pendingDecisionIds: ['approval:effect-unavailable'],
      },
    })
  })

  it('keeps an unprojected Pending decision visible beside a projected one', async () => {
    const h = harness()
    h.fake.setResponses([
      { message: fakeTextAndToolCall('First decision.', 'test_proposal', {}) },
      {
        message: fakeTextAndToolCall('Second decision.', 'test_unprojected_decision', {}),
      },
      { message: fakeText('Both decisions are ready.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Prepare both operations' }))

    expect(h.frames.at(-1)?.frame).toMatchObject({
      type: 'chat.turn-end',
      message: {
        text: `Awaiting your decision: Create Space “Travel”.\n${PENDING_DECISION_FALLBACK_FEEDBACK}`,
        pendingDecisions: [{ id: 'space-proposal:proposal-test' }],
        pendingDecisionIds: ['approval:effect-unavailable'],
      },
    })
  })

  it('caps observed Pending-decision references and still delivers a valid final frame', async () => {
    const h = harness()
    h.fake.setResponses([
      {
        message: fakeTextAndToolCall('Many decisions.', 'test_unprojected_decision', {
          count: MAX_CHAT_PENDING_DECISION_REFERENCES,
        }),
      },
      { message: fakeTextAndToolCall('One more decision.', 'test_proposal', {}) },
      { message: fakeText('The decisions are ready.') },
    ])

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'Prepare the operations' }))

    const final = h.frames.at(-1)?.frame
    expect(final?.type).toBe('chat.turn-end')
    if (final?.type !== 'chat.turn-end') throw new Error('expected a completed turn')
    expect(
      (final.message.pendingDecisions?.length ?? 0) +
        (final.message.pendingDecisionIds?.length ?? 0),
    ).toBe(MAX_CHAT_PENDING_DECISION_REFERENCES)
    expect(final.message.pendingDecisionIds).toHaveLength(MAX_CHAT_PENDING_DECISION_REFERENCES)
    expect(final.message.pendingDecisions).toBeUndefined()
    expect(final.message.text).toBe(PENDING_DECISION_FALLBACK_FEEDBACK)
    expect(h.frames.some(({ frame }) => frame.type === 'chat.turn-error')).toBe(false)
  })

  it('unknown spaceId: a turn-start frame precedes the turn-error frame, same turnId, nothing else', async () => {
    const h = harness()

    await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId: 'spc-does-not-exist' }))

    expect(h.frames).toHaveLength(2)
    expect(h.frames[0]!.frame).toMatchObject({
      type: 'chat.turn-start',
      spaceId: 'spc-does-not-exist',
    })
    expect(h.frames[1]!.frame).toMatchObject({
      type: 'chat.turn-error',
      spaceId: 'spc-does-not-exist',
    })
    expect((h.frames[1]!.frame as { turnId: string }).turnId).toBe(
      (h.frames[0]!.frame as { turnId: string }).turnId,
    )
    expect(h.router.callLog()).toHaveLength(0)
  })

  describe('stop() (issue #37 fix)', () => {
    it('rejects a new chat message after stop() with a calm turn-error frame and never calls the router', async () => {
      const h = harness()
      const spaceId = h.store.listSpaces()[0]!.id

      await h.chatLoop.stop()

      await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId }))

      // The error frame closes a turn its own `chat.turn-start` opened
      // (same lifecycle contract as the unknown-Space path).
      expect(h.frames).toHaveLength(2)
      expect(h.frames[0]!.frame).toMatchObject({ type: 'chat.turn-start', spaceId })
      expect(h.frames[1]!.frame).toMatchObject({
        type: 'chat.turn-error',
        spaceId,
        error: expect.stringContaining('shutting down'),
      })
      const startTurnId = (h.frames[0]!.frame as { turnId: string }).turnId
      expect(h.frames[1]!.frame).toMatchObject({ turnId: startTurnId })
      // No model call was ever attempted: the shutdown check runs before
      // the Space-existence check and everything else in `handleChatMessage`.
      expect(h.router.callLog()).toHaveLength(0)
    })

    it('rejects a global chat message after stop() the same way, with no spaceId on the frames', async () => {
      const h = harness()

      await h.chatLoop.stop()
      await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi' }))

      expect(h.frames).toHaveLength(2)
      expect(h.frames[0]!.frame).toMatchObject({ type: 'chat.turn-start' })
      expect(h.frames[1]!.frame).toMatchObject({ type: 'chat.turn-error' })
      expect(h.frames[0]!.frame).not.toHaveProperty('spaceId')
      expect(h.frames[1]!.frame).not.toHaveProperty('spaceId')
    })

    it('resolves without hanging once every turn it started has already settled', async () => {
      // Deliberately not asserting the abort-mid-stream path here: the fake
      // provider's faux stream schedules its delta chunks via a bare
      // `queueMicrotask` (no `tokensPerSecond` configured anywhere this repo
      // constructs one), so a turn started and left unawaited settles within
      // a handful of microtasks -- there is no reliable window in which to
      // observe `stop()` actually interrupt one without the test's own
      // timing racing the fake stream's. This covers the two paths that
      // are deterministic instead: `stop()` completes promptly once a
      // started turn has already finished, and (the test above) it rejects
      // any turn that starts after it.
      const h = harness()
      const spaceId = h.store.listSpaces()[0]!.id
      h.fake.setResponses([{ message: fakeText('done before shutdown') }])

      await h.chatLoop.handleChatMessage(chatEvent({ text: 'hi', spaceId }))
      expect(h.frames.at(-1)!.frame).toMatchObject({ type: 'chat.turn-end' })

      await h.chatLoop.stop()

      // A second stop() call must also resolve promptly -- idempotent, not a
      // fresh wait on anything.
      await h.chatLoop.stop()
    })
  })
})
