import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ChatResultTarget, PendingDecision, Space } from '@veduta/protocol'
import { defineTool, type ToolContext } from './agent-runner.ts'
import { chatToolRegistry, type ChatToolRegistryDeps } from './chat-tool-registry.ts'
import { createMemoryTools } from './memory-tools.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { toPiAgentTool } from './pi-agent-runner.ts'
import { Scheduler } from './scheduler.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { gateToolsForOrigins, TurnTaintAccumulator } from './taint.ts'
import { piToolParameters } from './tool-parameters.ts'
import type { ApprovalCardPort, PendingApproval } from './trust-contracts.ts'
import { isTrustWrapped, TrustLayer } from './trust-layer.ts'
import { WorkerPool } from './worker.ts'

/**
 * `chatToolRegistry` is the single builder both `server.ts` and
 * `tool-parameters.test.ts` build the real chat tool registry through, so a
 * hand-duplicated list in a test can never drift from what the daemon
 * actually wires up (a previous copy in `tool-parameters.test.ts` had
 * silently dropped `archive_surface`). These tests exercise the builder
 * itself: the stable scoped global registry, the exact focused registry,
 * the gated `create_surface` variant, and no duplicate names.
 */

const ACTIVE_SPACE_ID = 'spc-health'

const createdDataDirs: string[] = []

function tempRootDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-chat-tool-registry-'))
  createdDataDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function testRoutingConfig(): RoutingConfig {
  return {
    tiers: {
      reasoning: [{ provider: 'mock', modelId: 'strong' }],
      triage: [{ provider: 'mock', modelId: 'cheap' }],
    },
    providerKeys: {},
    connectionKeys: {},
    dailyCapUsd: { triage: 5, reasoning: 5 },
  }
}

function globalToolContext(): ToolContext {
  return fromPartial<ToolContext>({
    toolCallId: 'call-global',
    origin: 'trusted:user',
    origins: ['trusted:user'],
    taint: new TurnTaintAccumulator(['trusted:user']),
    contextHash: 'context-hash',
    initiatingTurn: { clientId: 'pwa-1', turnId: 'turn-global' },
  })
}

/** Builds real `ChatToolRegistryDeps` — the same construction shape `server.ts` uses. */
function buildDeps(): {
  deps: ChatToolRegistryDeps
  pendingApprovals: PendingApproval[]
  dispose: () => void
} {
  const rootDir = tempRootDir()
  const store = new Store({ rootDir })
  const pendingApprovals: PendingApproval[] = []

  const trust = new TrustLayer({
    rootDir,
    approvalCardPort: fromPartial<ApprovalCardPort>({
      create(approval: PendingApproval) {
        pendingApprovals.push(approval)
        return { surfaceId: `srf-approval-${approval.id}` }
      },
    }),
    onApprovalCard: () => {},
    appendOutcomeEvent: () => {},
  })
  const outboundRegistrations = createOutboundTools(createMockOutboundTransport(store.spacesEngine))
  for (const { tool, meta } of outboundRegistrations) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundRegistrations.map(({ tool }) => tool))

  const templateEngine = new TemplateEngine({ store })

  const memoryIndex = new MemoryIndex({ rootDir, spacesEngine: store.spacesEngine })
  const memoryRetrieval = new MemoryRetrieval({
    index: memoryIndex,
    spacesEngine: store.spacesEngine,
    config: MemoryConfigSchema.parse({}),
  })

  const scheduler = new Scheduler({ rootDir, store })

  const router = new ModelRouter({
    config: testRoutingConfig(),
    rootDir,
    sleep: async () => {},
  })
  const workerPool = new WorkerPool({
    store,
    router,
    workerTools: [],
    runnerFactory: () => {
      throw new Error('this test never actually spawns a Worker')
    },
    reviewComplete: async () => ({ text: '{}' }),
  })
  const spawnWorkerTool = createSpawnWorkerTool(workerPool)

  return {
    deps: {
      store,
      wrappedOutboundTools,
      memoryRetrieval,
      templateEngine,
      scheduler,
      spawnWorkerTool,
    },
    pendingApprovals,
    dispose: () => {
      trust.dispose()
      scheduler.stop()
      workerPool.dispose()
      memoryIndex.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

/** The exact tool set `server.ts` wires into a focused-Space chat turn. */
const EXPECTED_SPACE_TOOL_NAMES = [
  'send_message',
  'transfer_funds',
  'list_surfaces',
  'read_surface',
  'create_surface',
  'patch_state',
  'patch_tree',
  'archive_surface',
  'write_fact',
  'append_event',
  'read_recent',
  'search_log',
  'search_memory',
  'list_templates',
  'create_surface_from_template',
  'pin_surface',
  'list_automations',
  'arm_timer',
  'create_job',
  'set_automation_enabled',
  'cancel',
  'spawn_worker',
].sort()

const EXPECTED_GLOBAL_TOOL_NAMES = [
  'enter_space',
  'propose_space',
  ...EXPECTED_SPACE_TOOL_NAMES,
].sort()

describe('chatToolRegistry', () => {
  it('offers one stable scoped registry to global chat', () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(undefined)
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_GLOBAL_TOOL_NAMES)
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    } finally {
      dispose()
    }
  })

  it('requires an explicit Space target on every focused tool exposed globally', () => {
    const { deps, dispose } = buildDeps()
    try {
      const parameters = piToolParameters(chatToolRegistry(deps)(undefined))
      for (const name of EXPECTED_SPACE_TOOL_NAMES) {
        const schema = parameters[name] as { required?: string[] }
        expect(schema.required, name).toContain('spaceId')
      }
    } finally {
      dispose()
    }
  })

  it('enters by slug, reports context origins, and refuses a blind scoped write', async () => {
    const { deps, dispose } = buildDeps()
    const entered: Space[] = []
    const targets: ChatResultTarget[] = []
    try {
      deps.store.spacesEngine.appendEvent(ACTIVE_SPACE_ID, {
        type: 'reader.summary',
        text: 'Untrusted mail summary',
        origin: 'untrusted:gmail',
      })
      const tools = chatToolRegistry(deps)(undefined, {
        onSpaceEntered: (space) => entered.push(space),
        onResultTarget: (target) => targets.push(target),
      })
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const writeFact = tools.find((tool) => tool.name === 'write_fact')!
      const context = globalToolContext()

      await expect(
        writeFact.handler(
          writeFact.schema.parse({ spaceId: 'health', fact: 'Weight goal set.' }),
          context,
        ),
      ).rejects.toThrow(/enter_space first/)

      const enteredResult = await enterSpace.handler(
        enterSpace.schema.parse({ spaceId: 'health' }),
        context,
      )
      expect(enteredResult.content).toContain('Health (health)')
      expect(enteredResult.origins).toContain('untrusted:gmail')
      expect(entered).toEqual([expect.objectContaining({ id: ACTIVE_SPACE_ID })])

      await expect(
        writeFact.handler(
          writeFact.schema.parse({ spaceId: 'health', fact: 'Weight goal set.' }),
          context,
        ),
      ).resolves.toMatchObject({ content: expect.stringContaining('FACTS') })
      expect(targets).toContainEqual({
        spaceId: ACTIVE_SPACE_ID,
        spaceSlug: 'health',
        spaceName: 'Health',
      })
    } finally {
      dispose()
    }
  })

  it('records successful global tool calls with one turn correlation in the target Event log', async () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(undefined)
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const writeFact = tools.find((tool) => tool.name === 'write_fact')!
      const appendEvent = tools.find((tool) => tool.name === 'append_event')!

      await enterSpace.handler(enterSpace.schema.parse({ spaceId: 'health' }), globalToolContext())
      await writeFact.handler(
        writeFact.schema.parse({ spaceId: ACTIVE_SPACE_ID, fact: 'Training is on Tuesday.' }),
        { ...globalToolContext(), toolCallId: 'call-write' },
      )
      await appendEvent.handler(
        appendEvent.schema.parse({
          spaceId: ACTIVE_SPACE_ID,
          text: 'A correlated plan note',
          payload: { correlationId: 'forged-correlation' },
        }),
        { ...globalToolContext(), toolCallId: 'call-append' },
      )

      const calls = deps.store
        .eventLog(ACTIVE_SPACE_ID)
        .filter((event) => event.type === 'turn.tool')
      expect(calls).toHaveLength(3)
      expect(calls.map((event) => event.payload)).toEqual([
        expect.objectContaining({
          correlationId: 'turn-global',
          toolCallId: 'call-global',
          toolName: 'enter_space',
          outcome: 'completed',
          mutation: false,
        }),
        expect.objectContaining({
          correlationId: 'turn-global',
          toolCallId: 'call-write',
          toolName: 'write_fact',
          outcome: 'completed',
          mutation: true,
        }),
        expect.objectContaining({
          correlationId: 'turn-global',
          toolCallId: 'call-append',
          toolName: 'append_event',
          outcome: 'completed',
          mutation: true,
        }),
      ])
      expect(
        deps.store.eventLog(ACTIVE_SPACE_ID).find((event) => event.type === 'fact.write'),
      ).toMatchObject({ payload: { correlationId: 'turn-global' } })
      expect(
        deps.store
          .eventLog(ACTIVE_SPACE_ID)
          .find((event) => event.text === 'A correlated plan note'),
      ).toMatchObject({ payload: { correlationId: 'turn-global' } })
    } finally {
      dispose()
    }
  })

  it('keeps trust-wrapped outbound actions available for live-taint decisions', () => {
    const { deps, dispose } = buildDeps()
    try {
      const gated = gateToolsForOrigins(
        chatToolRegistry(deps)(undefined),
        ['untrusted:gmail'],
        isTrustWrapped,
      )
      expect(gated.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['send_message', 'transfer_funds']),
      )
    } finally {
      dispose()
    }
  })

  it('grows live taint from an entered Space before a later outbound decision', async () => {
    const { deps, pendingApprovals, dispose } = buildDeps()
    try {
      deps.store.spacesEngine.appendEvent(ACTIVE_SPACE_ID, {
        type: 'reader.summary',
        text: 'Untrusted instruction-shaped mail content',
        origin: 'untrusted:gmail',
      })
      const tools = chatToolRegistry(deps)(undefined)
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const sendMessage = tools.find((tool) => tool.name === 'send_message')!
      const context = globalToolContext()
      const enterParameters = piToolParameters([enterSpace])['enter_space']
      if (!enterParameters) throw new Error('missing enter_space parameters')
      const piEnterSpace = toPiAgentTool(
        enterSpace,
        enterParameters,
        (toolCallId) => ({ ...context, toolCallId }),
        () => undefined,
      )

      await piEnterSpace.execute('call-enter-tainted', { spaceId: 'health' })
      expect(context.taint.origins()).toEqual(
        expect.arrayContaining(['trusted:user', 'untrusted:gmail']),
      )
      const result = await sendMessage.handler(
        sendMessage.schema.parse({
          spaceId: 'health',
          to: 'coach@example.com',
          body: 'Share the plan.',
        }),
        { ...context, toolCallId: 'call-send-tainted' },
      )

      expect(result.content).toContain('needs your approval')
      expect(pendingApprovals).toHaveLength(1)
      expect(pendingApprovals[0]).toMatchObject({
        toolName: 'send_message',
        spaceId: ACTIVE_SPACE_ID,
        effectiveOrigin: 'untrusted:gmail',
        originChain: expect.arrayContaining(['untrusted:gmail']),
      })
      expect(
        deps.store.eventLog(ACTIVE_SPACE_ID).some((event) => event.type === 'outbound.delivery'),
      ).toBe(false)
    } finally {
      dispose()
    }
  })

  it('rejects unknown and archived targets without entering or writing either', async () => {
    const { deps, dispose } = buildDeps()
    const archived = deps.store.spacesEngine.createSpace({ name: 'Archived Target' })
    deps.store.archiveSpace(archived.id)
    const entered: Space[] = []
    try {
      const enterSpace = chatToolRegistry(deps)(undefined, {
        onSpaceEntered: (space) => entered.push(space),
      }).find((tool) => tool.name === 'enter_space')!

      expect(() =>
        enterSpace.handler(
          enterSpace.schema.parse({ spaceId: 'does-not-exist' }),
          globalToolContext(),
        ),
      ).toThrow(/unknown Space/)
      expect(() =>
        enterSpace.handler(
          enterSpace.schema.parse({ spaceId: archived.slug }),
          globalToolContext(),
        ),
      ).toThrow(/archived Space/)
      expect(entered).toEqual([])
      expect(
        deps.store
          .eventLog(archived.id)
          .filter((event) => event.payload?.['correlationId'] === 'turn-global'),
      ).toEqual([])
    } finally {
      dispose()
    }
  })

  it('creates only a pending Space proposal until the user confirms it', async () => {
    const { deps, dispose } = buildDeps()
    const decisions: PendingDecision[] = []
    try {
      const beforeSpaceIds = deps.store.spacesEngine.listAllSpaces().map((space) => space.id)
      const proposeSpace = chatToolRegistry(deps)(undefined, {
        onPendingDecision: (decision) => decisions.push(decision),
      }).find((tool) => tool.name === 'propose_space')!
      const result = await proposeSpace.handler(
        proposeSpace.schema.parse({ name: 'Travel', reason: 'Plan future trips.' }),
        globalToolContext(),
      )
      const proposal = deps.store.spacesEngine.listSpaceProposals().at(-1)!

      expect(result.content).toContain('for user confirmation')
      expect(proposal).toMatchObject({ name: 'Travel', status: 'pending' })
      expect(decisions).toEqual([
        expect.objectContaining({
          id: `space-proposal:${proposal.id}`,
          kind: 'space-proposal',
          summary: 'Create Space “Travel”',
          allowedResolutions: ['accept', 'reject'],
          state: 'pending',
        }),
      ])
      expect(deps.store.spacesEngine.listAllSpaces().map((space) => space.id)).toEqual(
        beforeSpaceIds,
      )
      expect(deps.store.getSurface(proposal.spaceId)).toBeUndefined()

      const created = deps.store.spacesEngine.confirmSpaceProposal(proposal.id, 'trusted:user')
      expect(created.id).toBe(proposal.spaceId)
      expect(deps.store.listAuthorableSurfaces(created.id).surfaces).toEqual([])
    } finally {
      dispose()
    }
  })

  it('returns a specific result target and correlates a scoped Surface creation', async () => {
    const { deps, dispose } = buildDeps()
    const targets: ChatResultTarget[] = []
    try {
      const tools = chatToolRegistry(deps)(undefined, {
        onResultTarget: (target) => targets.push(target),
      })
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const createSurface = tools.find((tool) => tool.name === 'create_surface')!
      await enterSpace.handler(enterSpace.schema.parse({ spaceId: 'health' }), globalToolContext())
      await createSurface.handler(
        createSurface.schema.parse({
          spaceId: 'health',
          id: 'srf-global-weight',
          title: 'Weight tracker',
          tree: { id: 'root', type: 'Stat', binding: 'weight', props: { label: 'Weight' } },
          state: { weight: 72 },
        }),
        { ...globalToolContext(), toolCallId: 'call-create' },
      )

      expect(targets.at(-1)).toEqual({
        spaceId: ACTIVE_SPACE_ID,
        spaceSlug: 'health',
        spaceName: 'Health',
        surfaceId: 'srf-global-weight',
        surfaceTitle: 'Weight tracker',
      })
      expect(
        deps.store
          .eventLog(ACTIVE_SPACE_ID)
          .find(
            (event) =>
              event.type === 'surface.create' &&
              event.payload?.['surfaceId'] === 'srf-global-weight',
          ),
      ).toMatchObject({ payload: { correlationId: 'turn-global' } })
    } finally {
      dispose()
    }
  })

  it('refuses to pin a Surface through a different entered Space', async () => {
    const { deps, dispose } = buildDeps()
    const otherSpace = deps.store.spacesEngine.createSpace({ name: 'Other Pin Scope' })
    try {
      deps.store.createSurface(
        {
          id: 'srf-other-pin-scope',
          spaceId: otherSpace.id,
          title: 'Other pin scope',
          tree: { id: 'root', type: 'Box', children: [] },
          state: {},
          pinned: false,
          pinnable: true,
          freshness: {
            updatedAt: new Date('2026-08-25T10:00:00.000Z').toISOString(),
            updatedBy: 'agent',
          },
        },
        'agent',
      )
      const tools = chatToolRegistry(deps)(undefined)
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const pinSurface = tools.find((tool) => tool.name === 'pin_surface')!
      await enterSpace.handler(
        enterSpace.schema.parse({ spaceId: ACTIVE_SPACE_ID }),
        globalToolContext(),
      )

      await expect(
        pinSurface.handler(
          pinSurface.schema.parse({
            spaceId: ACTIVE_SPACE_ID,
            surfaceId: 'srf-other-pin-scope',
            pinned: true,
          }),
          { ...globalToolContext(), toolCallId: 'call-pin' },
        ),
      ).rejects.toThrow(/not authorable in this Space/)
      expect(deps.store.getSurface('srf-other-pin-scope')?.pinned).not.toBe(true)
      expect(deps.store.spacesEngine.listTemplates(otherSpace.id)).toEqual([])
    } finally {
      dispose()
    }
  })

  it('keeps completed work durable when a later mutation in another Space fails', async () => {
    const { deps, dispose } = buildDeps()
    const work = deps.store.spacesEngine.createSpace({ name: 'Cross Space Work' })
    try {
      const tools = chatToolRegistry(deps)(undefined)
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const createSurface = tools.find((tool) => tool.name === 'create_surface')!
      const patchState = tools.find((tool) => tool.name === 'patch_state')!
      for (const target of [ACTIVE_SPACE_ID, work.id]) {
        await enterSpace.handler(enterSpace.schema.parse({ spaceId: target }), {
          ...globalToolContext(),
          toolCallId: `call-enter-${target}`,
        })
      }
      for (const [spaceId, surfaceId, title] of [
        [ACTIVE_SPACE_ID, 'srf-health-plan', 'Health plan'],
        [work.id, 'srf-work-plan', 'Work plan'],
      ] as const) {
        await createSurface.handler(
          createSurface.schema.parse({
            spaceId,
            id: surfaceId,
            title,
            tree: { id: 'root', type: 'Stat', binding: 'count', props: { label: 'Count' } },
            state: { count: 0 },
          }),
          { ...globalToolContext(), toolCallId: `call-create-${surfaceId}` },
        )
      }

      await patchState.handler(
        patchState.schema.parse({
          spaceId: ACTIVE_SPACE_ID,
          surfaceId: 'srf-health-plan',
          operations: [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
        }),
        { ...globalToolContext(), toolCallId: 'call-patch-health' },
      )
      await expect(
        patchState.handler(
          patchState.schema.parse({
            spaceId: work.id,
            surfaceId: 'srf-work-plan',
            operations: [{ target: 'state', op: 'remove', path: '/missing' }],
          }),
          { ...globalToolContext(), toolCallId: 'call-patch-work' },
        ),
      ).rejects.toThrow()

      expect(deps.store.getSurface('srf-health-plan')?.state['count']).toBe(1)
      expect(deps.store.getSurface('srf-work-plan')?.state['count']).toBe(0)
      expect(
        deps.store
          .eventLog(ACTIVE_SPACE_ID)
          .find(
            (event) =>
              event.type === 'surface.patch_state' &&
              event.payload?.['surfaceId'] === 'srf-health-plan',
          ),
      ).toMatchObject({ payload: { correlationId: 'turn-global' } })
      expect(
        deps.store
          .eventLog(work.id)
          .find(
            (event) =>
              event.type === 'turn.tool' && event.payload?.['toolCallId'] === 'call-patch-work',
          ),
      ).toMatchObject({
        payload: {
          correlationId: 'turn-global',
          toolName: 'patch_state',
          outcome: 'failed',
          mutation: true,
        },
      })
      expect(
        deps.store
          .eventLog(work.id)
          .some((event) => event.payload?.['surfaceId'] === 'srf-health-plan'),
      ).toBe(false)
    } finally {
      dispose()
    }
  })

  it('scopes an ephemeral Worker to exactly the entered target Space', async () => {
    const { deps, dispose } = buildDeps()
    const observed: { input: unknown; context: ToolContext }[] = []
    deps.spawnWorkerTool = defineTool({
      name: 'spawn_worker',
      description: 'test Worker spawn',
      schema: z.object({ goal: z.string().min(1) }),
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        observed.push({ input, context })
        return { content: 'worker queued', details: { workerId: 'wrk-test' } }
      },
    })
    try {
      const tools = chatToolRegistry(deps)(undefined)
      const enterSpace = tools.find((tool) => tool.name === 'enter_space')!
      const spawnWorker = tools.find((tool) => tool.name === 'spawn_worker')!
      await enterSpace.handler(
        enterSpace.schema.parse({ spaceId: ACTIVE_SPACE_ID }),
        globalToolContext(),
      )
      await spawnWorker.handler(
        spawnWorker.schema.parse({ spaceId: 'health', goal: 'Investigate training recovery' }),
        { ...globalToolContext(), toolCallId: 'call-worker' },
      )

      expect(observed).toHaveLength(1)
      expect(observed[0]?.input).toEqual({ goal: 'Investigate training recovery' })
      expect(observed[0]?.context.spaceId).toBe(ACTIVE_SPACE_ID)
      expect(
        deps.store
          .eventLog(ACTIVE_SPACE_ID)
          .find(
            (event) =>
              event.type === 'turn.tool' && event.payload?.['toolCallId'] === 'call-worker',
          ),
      ).toMatchObject({
        payload: {
          correlationId: 'turn-global',
          toolName: 'spawn_worker',
          outcome: 'completed',
          mutation: true,
        },
      })
    } finally {
      dispose()
    }
  })

  it("offers the complete focused-Space tool set once, matching createMemoryTools's search_memory branch", () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(ACTIVE_SPACE_ID)
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_SPACE_TOOL_NAMES)

      // Sanity: search_memory is present because a retrieval instance was
      // supplied, matching createMemoryTools's own documented behavior.
      const withRetrieval = createMemoryTools(deps.store.spacesEngine, {
        activeSpaceId: ACTIVE_SPACE_ID,
        retrieval: deps.memoryRetrieval,
      })
      expect(withRetrieval.some((tool) => tool.name === 'search_memory')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('gates create_surface behind the Template-reuse justification check (gateCreateSurfaceTool), not the raw Surface tool', () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(ACTIVE_SPACE_ID)
      const createSurface = tools.find((tool) => tool.name === 'create_surface')
      expect(createSurface).toBeDefined()
      // gateCreateSurfaceTool builds its schema as `tool.schema.and(...).and(...)`
      // (template-engine.ts): a real zod intersection, never the raw
      // create_surface tool's plain object schema — the marker that this is
      // the gated variant, not `Store.surfaceTools()`'s own tool.
      expect(createSurface!.schema).toBeInstanceOf(z.ZodIntersection)
    } finally {
      dispose()
    }
  })

  it('has no duplicate tool names in the Space registry', () => {
    const { deps, dispose } = buildDeps()
    try {
      const names = chatToolRegistry(deps)(ACTIVE_SPACE_ID).map((tool) => tool.name)
      expect(new Set(names).size).toBe(names.length)
    } finally {
      dispose()
    }
  })

  it('offers only Space-bound Automation schemas to a focused turn', () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(ACTIVE_SPACE_ID)
      const parameters = piToolParameters(tools)
      const expectedProperties: Record<string, string[]> = {
        list_automations: [],
        arm_timer: ['action', 'condition', 'targetSurfaceId', 'when'],
        create_job: ['briefing', 'condition', 'cron'],
        set_automation_enabled: ['automationId', 'enabled'],
        cancel: ['automationId'],
      }

      for (const [name, fields] of Object.entries(expectedProperties)) {
        const schema = parameters[name] as { properties: Record<string, unknown> }
        expect(Object.keys(schema.properties).sort(), name).toEqual(fields)
        expect(schema.properties['spaceId'], name).toBeUndefined()
      }
    } finally {
      dispose()
    }
  })
})
