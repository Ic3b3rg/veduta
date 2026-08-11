import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool, type ToolContext, type ToolDef } from './agent-runner.ts'
import { chatToolRegistry } from './chat-tool-registry.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { ModelRouter, type RoutingConfig } from './model-routing.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { toPiAgentTool } from './pi-agent-runner.ts'
import { Scheduler } from './scheduler.ts'
import { createSpawnWorkerTool } from './spawn-worker-tool.ts'
import { Store } from './store.ts'
import type { TurnTaint } from './taint.ts'
import { TemplateEngine } from './template-engine.ts'
import { piToolParameters } from './tool-parameters.ts'
import type { ApprovalCardPort } from './trust-contracts.ts'
import { TrustLayer } from './trust-layer.ts'
import { WorkerPool } from './worker.ts'

/**
 * Issue #37: `piToolParameters` must give every `ToolDef` offered to
 * the Agent a pi-facing parameter schema, built from the exact chat
 * registry `chat-tool-registry.ts`'s `chatToolRegistry` builds — the same
 * builder `server.ts` wires into the daemon — not a hand-duplicated stand-in
 * registry, so a schema shape the real tools actually produce (the one
 * intersection, `gateCreateSurfaceTool`'s `allOf`) is exercised for real
 * rather than assumed, and this test can never silently drift from what the
 * daemon actually offers a chat turn.
 */

const ACTIVE_SPACE_ID = 'spc-health'

const createdDataDirs: string[] = []

function tempRootDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-tool-parameters-'))
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

/**
 * Builds the exact tool registry issue #37 wires into the Agent loop, THROUGH
 * `chat-tool-registry.ts`'s `chatToolRegistry` builder — the same one
 * `server.ts` calls — using the same construction patterns as
 * trust-acceptance.test.ts, worker.test.ts, and scheduler.test.ts: an
 * in-memory `Store`, a real `TrustLayer` wrapping the outbound tools, a real
 * `MemoryIndex`/`MemoryRetrieval` pair (so `search_memory` is offered, same
 * as every real Space turn), and a `WorkerPool` that never actually spawns a
 * Worker in this test (only `createSpawnWorkerTool`'s own `ToolDef` — its
 * `schema` — is under test).
 */
function buildRealRegistry(): { tools: ToolDef[]; dispose: () => void } {
  const rootDir = tempRootDir()
  const store = new Store({ rootDir })

  const trust = new TrustLayer({
    rootDir,
    approvalCardPort: fromPartial<ApprovalCardPort>({}),
    onApprovalCard: () => {},
    appendOutcomeEvent: () => {},
  })
  const outboundTransport = createMockOutboundTransport(store.spacesEngine)
  const outboundRegistrations = createOutboundTools(outboundTransport)
  for (const { tool, meta } of outboundRegistrations) trust.register(tool, meta)
  const wrappedOutboundTools = trust.wrapTools(outboundRegistrations.map(({ tool }) => tool))

  const templateEngine = new TemplateEngine({ store })

  const memoryIndex = new MemoryIndex({ rootDir, spacesEngine: store.spacesEngine })
  const memoryRetrieval = new MemoryRetrieval({
    index: memoryIndex,
    spacesEngine: store.spacesEngine,
    config: MemoryConfigSchema.parse({}),
  })

  const router = new ModelRouter({
    config: testRoutingConfig(),
    now: () => new Date('2026-08-03T10:00:00.000Z'),
    sleep: async () => {},
  })
  const scheduler = new Scheduler({
    rootDir,
    store,
    now: () => new Date('2026-08-03T10:00:00.000Z'),
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

  const tools = chatToolRegistry({
    store,
    wrappedOutboundTools,
    memoryRetrieval,
    templateEngine,
    scheduler,
    spawnWorkerTool,
  })(ACTIVE_SPACE_ID)

  return {
    tools,
    dispose: () => {
      trust.dispose()
      scheduler.stop()
      workerPool.dispose()
      memoryIndex.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

function isPlainObjectSchema(value: unknown): value is { type: 'object'; properties?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'object' &&
    'properties' in (value as Record<string, unknown>)
  )
}

function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef)
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if ('$ref' in record) return true
  return Object.values(record).some(containsRef)
}

describe('piToolParameters', () => {
  it('gives every tool in the real chat registry a top-level object schema, no $ref, no top-level allOf', () => {
    const { tools, dispose } = buildRealRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const parameters = piToolParameters(tools)

      expect(warn).not.toHaveBeenCalled()

      expect(Object.keys(parameters).sort()).toEqual([...new Set(tools.map((t) => t.name))].sort())

      for (const tool of tools) {
        const schema = parameters[tool.name]
        expect(schema, `missing pi parameters for "${tool.name}"`).toBeDefined()
        expect(isPlainObjectSchema(schema), `"${tool.name}" is not a top-level object schema`).toBe(
          true,
        )
        expect(
          (schema as Record<string, unknown>)['allOf'],
          `"${tool.name}" still has a top-level allOf`,
        ).toBeUndefined()
        expect(containsRef(schema), `"${tool.name}"'s schema still contains a $ref`).toBe(false)
      }
    } finally {
      warn.mockRestore()
      dispose()
    }
  })

  it("merges gateCreateSurfaceTool's allOf (a zod intersection) into a single object schema covering every field from all three schemas", () => {
    const { tools, dispose } = buildRealRegistry()
    try {
      const parameters = piToolParameters(tools)
      const createSurfaceParameters = parameters['create_surface']
      expect(createSurfaceParameters).toBeDefined()
      const schema = createSurfaceParameters as {
        type: string
        properties: Record<string, unknown>
      }
      expect(schema.type).toBe('object')
      // Fields from the wrapped create_surface schema itself.
      expect(schema.properties['id']).toBeDefined()
      expect(schema.properties['spaceId']).toBeDefined()
      expect(schema.properties['title']).toBeDefined()
      expect(schema.properties['tree']).toBeDefined()
      // Fields gateCreateSurfaceTool's own extension schemas add.
      expect(schema.properties['intent']).toBeDefined()
      expect(schema.properties['justification']).toBeDefined()
    } finally {
      dispose()
    }
  })

  it('does not throw when toPiAgentTool maps every derived parameter schema (the cheapest honest proxy for PiAgentRunner.toPiTools)', () => {
    const { tools, dispose } = buildRealRegistry()
    try {
      const parameters = piToolParameters(tools)
      for (const tool of tools) {
        const schema = parameters[tool.name]
        if (!schema) throw new Error(`missing pi parameters for "${tool.name}"`)
        expect(() =>
          toPiAgentTool(
            tool,
            schema,
            () =>
              fromPartial<ToolContext>({
                toolCallId: 'tool-call-1',
                origin: 'trusted:user',
                origins: ['trusted:user'],
                taint: fromPartial<TurnTaint>({ origins: () => ['trusted:user'], add: () => {} }),
                contextHash: 'test-hash',
              }),
            () => {},
          ),
        ).not.toThrow()
      }
    } finally {
      dispose()
    }
  })

  it('throws when the input carries a duplicate tool name', () => {
    const tool: ToolDef = defineTool({
      name: 'duplicate_tool',
      description: 'a tool',
      schema: z.object({ value: z.string() }),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
    expect(() => piToolParameters([tool, tool])).toThrow(/duplicate tool name/)
  })

  it('throws for a non-object top-level schema', () => {
    const tool: ToolDef = defineTool({
      name: 'stringy_tool',
      description: 'a tool with a bare string schema',
      schema: z.string(),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
    expect(() => piToolParameters([tool])).toThrow(/non-object top-level parameter schema/)
  })
})
