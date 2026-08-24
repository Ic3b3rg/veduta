import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatToolRegistry, type ChatToolRegistryDeps } from './chat-tool-registry.ts'
import { createMemoryTools } from './memory-tools.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { Scheduler } from './scheduler.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { piToolParameters } from './tool-parameters.ts'
import type { ApprovalCardPort } from './trust-contracts.ts'
import { TrustLayer } from './trust-layer.ts'
import { WorkerPool } from './worker.ts'

/**
 * `chatToolRegistry` is the single builder both `server.ts` and
 * `tool-parameters.test.ts` build the real chat tool registry through, so a
 * hand-duplicated list in a test can never drift from what the daemon
 * actually wires up (a previous copy in `tool-parameters.test.ts` had
 * silently dropped `archive_surface`). These tests exercise the builder
 * itself: the empty global-chat registry, the exact Space registry, the
 * gated `create_surface` variant, and no duplicate names.
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

/** Builds real `ChatToolRegistryDeps` — the same construction shape `server.ts` uses. */
function buildDeps(): { deps: ChatToolRegistryDeps; dispose: () => void } {
  const rootDir = tempRootDir()
  const store = new Store({ rootDir })

  const trust = new TrustLayer({
    rootDir,
    approvalCardPort: fromPartial<ApprovalCardPort>({}),
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

describe('chatToolRegistry', () => {
  it('offers no tools to the global chat (no active Space)', () => {
    const { deps, dispose } = buildDeps()
    try {
      expect(chatToolRegistry(deps)(undefined)).toEqual([])
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
