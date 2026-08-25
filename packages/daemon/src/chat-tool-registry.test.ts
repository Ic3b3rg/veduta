import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
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
})
