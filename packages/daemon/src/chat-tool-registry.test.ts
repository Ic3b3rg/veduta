import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, SYSTEM_SPACE_ID, type PendingDecision } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolContext } from './agent-runner.ts'
import { chatToolRegistry, type ChatToolRegistryDeps } from './chat-tool-registry.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { createMemoryTools } from './memory-tools.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { Scheduler } from './scheduler.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { Store } from './store.ts'
import { TurnTaintAccumulator } from './taint.ts'
import { TemplateEngine } from './template-engine.ts'
import { piToolParameters } from './tool-parameters.ts'
import type { ApprovalCardPort, PendingApproval } from './trust-contracts.ts'
import { TrustLayer } from './trust-layer.ts'
import { WorkerPool } from './worker.ts'

/**
 * Registry composition only. Global adapter behavior belongs beside
 * `global-chat-tools.ts`; keeping it out of this suite makes registry drift
 * visible without turning this file into a second integration suite.
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

function buildDeps(): { deps: ChatToolRegistryDeps; dispose: () => void } {
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

  const memoryIndex = new MemoryIndex({ rootDir, spacesEngine: store.spacesEngine })
  const memoryRetrieval = new MemoryRetrieval({
    index: memoryIndex,
    spacesEngine: store.spacesEngine,
    config: MemoryConfigSchema.parse({}),
  })
  const scheduler = new Scheduler({ rootDir, store })
  const router = new ModelRouter({ config: testRoutingConfig(), rootDir, sleep: async () => {} })
  const workerPool = new WorkerPool({
    store,
    router,
    workerTools: [],
    runnerFactory: () => {
      throw new Error('this test never actually spawns a Worker')
    },
    reviewComplete: async () => ({ text: '{}' }),
  })

  return {
    deps: {
      store,
      wrappedOutboundTools: trust.wrapTools(outboundRegistrations.map(({ tool }) => tool)),
      memoryRetrieval,
      templateEngine: new TemplateEngine({ store }),
      scheduler,
      spawnWorkerTool: createSpawnWorkerTool(workerPool),
      pendingDecisions: { get: async () => undefined },
    },
    dispose: () => {
      trust.dispose()
      scheduler.stop()
      workerPool.dispose()
      memoryIndex.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

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

const EXPECTED_SYSTEM_TOOL_NAMES = ['list_surfaces', 'read_surface', 'list_automations'].sort()

function toolContext(toolCallId: string): ToolContext {
  return fromPartial<ToolContext>({
    toolCallId,
    origin: 'trusted:user',
    origins: ['trusted:user'],
    taint: new TurnTaintAccumulator(['trusted:user']),
    contextHash: 'chat-tool-registry-test',
    spaceId: ACTIVE_SPACE_ID,
    initiatingTurn: { clientId: 'client-1', turnId: 'turn-1' },
  })
}

describe('chatToolRegistry', () => {
  it('offers only explicit safe status reads to a System-scoped turn', () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(SYSTEM_SPACE_ID)
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_SYSTEM_TOOL_NAMES)
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    } finally {
      dispose()
    }
  })

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
        expect((parameters[name] as { required?: string[] }).required, name).toContain('spaceId')
      }
    } finally {
      dispose()
    }
  })

  it("offers the complete focused-Space tool set once, including createMemoryTools's search branch", () => {
    const { deps, dispose } = buildDeps()
    try {
      const tools = chatToolRegistry(deps)(ACTIVE_SPACE_ID)
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_SPACE_TOOL_NAMES)
      expect(
        createMemoryTools(deps.store.spacesEngine, {
          activeSpaceId: ACTIVE_SPACE_ID,
          retrieval: deps.memoryRetrieval,
        }).some((tool) => tool.name === 'search_memory'),
      ).toBe(true)
    } finally {
      dispose()
    }
  })

  it('uses the Template-reuse-gated create_surface variant', () => {
    const { deps, dispose } = buildDeps()
    try {
      const createSurface = chatToolRegistry(deps)(ACTIVE_SPACE_ID).find(
        (tool) => tool.name === 'create_surface',
      )
      expect(createSurface?.schema).toBeInstanceOf(z.ZodIntersection)
    } finally {
      dispose()
    }
  })

  it('offers only Space-bound Automation schemas to a focused turn', () => {
    const { deps, dispose } = buildDeps()
    try {
      const parameters = piToolParameters(chatToolRegistry(deps)(ACTIVE_SPACE_ID))
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

  it('observes Tree proposals returned by focused and global patch_tree', async () => {
    const { deps, dispose } = buildDeps()
    const decision: PendingDecision = {
      id: 'tree-proposal:1',
      kind: 'tree-proposal',
      summary: 'Change the “Pinned plan” Surface tree',
      scope: { type: 'space', spaceId: ACTIVE_SPACE_ID },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-08-25T10:00:00.000Z',
    }
    const get = vi.fn(async (id: string) => ({ ...decision, id }))
    deps.pendingDecisions = { get }
    const onPendingDecision = vi.fn()
    try {
      deps.store.createSurface(
        SurfaceSchema.parse({
          id: 'srf-pinned-plan',
          spaceId: ACTIVE_SPACE_ID,
          title: 'Pinned plan',
          tree: {
            id: 'root',
            type: 'Box',
            children: [{ id: 'caption', type: 'Caption', props: { text: 'Plan' } }],
          },
          state: {},
          freshness: { updatedAt: '2026-08-25T09:00:00.000Z', updatedBy: 'agent' },
        }),
        'agent',
      )
      deps.store.setPinned('srf-pinned-plan', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      const version = deps.store.getSurfaceVersion('srf-pinned-plan')
      if (!version) throw new Error('missing test Surface version')
      const patchTree = chatToolRegistry(deps)(ACTIVE_SPACE_ID, { onPendingDecision }).find(
        (tool) => tool.name === 'patch_tree',
      )
      if (!patchTree) throw new Error('missing patch_tree')

      await patchTree.handler(
        patchTree.schema.parse({
          surfaceId: 'srf-pinned-plan',
          expectedTreeVersion: version.treeVersion,
          operations: [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'next', type: 'Caption', props: { text: 'Next' } },
            },
          ],
        }),
        toolContext('call-tree-proposal'),
      )

      expect(get).toHaveBeenCalledWith('tree-proposal:1')
      expect(onPendingDecision).toHaveBeenCalledWith(decision)

      const globalTools = chatToolRegistry(deps)(undefined, { onPendingDecision })
      const enterSpace = globalTools.find((tool) => tool.name === 'enter_space')
      const globalPatchTree = globalTools.find((tool) => tool.name === 'patch_tree')
      if (!enterSpace || !globalPatchTree) throw new Error('missing global tree tools')
      await enterSpace.handler(
        enterSpace.schema.parse({ spaceId: ACTIVE_SPACE_ID }),
        toolContext('call-enter-space'),
      )
      await globalPatchTree.handler(
        globalPatchTree.schema.parse({
          spaceId: ACTIVE_SPACE_ID,
          surfaceId: 'srf-pinned-plan',
          expectedTreeVersion: version.treeVersion,
          operations: [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'global-next', type: 'Caption', props: { text: 'Global next' } },
            },
          ],
        }),
        toolContext('call-global-tree-proposal'),
      )

      expect(get).toHaveBeenCalledWith('tree-proposal:2')
      expect(onPendingDecision).toHaveBeenLastCalledWith({
        ...decision,
        id: 'tree-proposal:2',
      })
    } finally {
      dispose()
    }
  })

  it('does not fail a completed approval-card tool when decision projection fails', async () => {
    const { deps, dispose } = buildDeps()
    const projectionError = new Error('projection unavailable')
    deps.pendingDecisions = {
      get: vi.fn(async () => {
        throw projectionError
      }),
    }
    const onPendingDecision = vi.fn()
    const onPendingDecisionObserved = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const sendMessage = chatToolRegistry(deps)(ACTIVE_SPACE_ID, {
        onPendingDecision,
        onPendingDecisionObserved,
      }).find((tool) => tool.name === 'send_message')
      if (!sendMessage) throw new Error('missing send_message')

      const outcome = await sendMessage.handler(
        sendMessage.schema.parse({ to: 'alice@example.com', body: 'Hello' }),
        toolContext('call-approval'),
      )

      expect(outcome.content).toContain('needs your approval')
      expect(onPendingDecision).not.toHaveBeenCalled()
      expect(onPendingDecisionObserved).toHaveBeenCalledWith(expect.stringMatching(/^approval:/))
      expect(error).toHaveBeenCalledWith('Pending decision projection failed', projectionError)
    } finally {
      error.mockRestore()
      dispose()
    }
  })
})
