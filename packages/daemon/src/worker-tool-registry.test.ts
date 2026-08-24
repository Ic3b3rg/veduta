import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { MemoryConfigSchema } from './memory-config.ts'
import { MemoryIndex } from './memory-index.ts'
import { MemoryRetrieval } from './memory-retrieval.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'
import { piToolParameters } from './tool-parameters.ts'
import { workerToolRegistry } from './worker-tool-registry.ts'

describe('workerToolRegistry', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('offers exactly the three read-only L0 memory tools with Pi parameter schemas', () => {
    const { engine, index, retrieval } = harness()
    const tools = workerToolRegistry({ spacesEngine: engine, memoryRetrieval: retrieval })

    expect(tools.map((tool) => tool.name)).toEqual(['read_recent', 'search_log', 'search_memory'])
    expect(tools.every((tool) => tool.level === 'L0' && tool.egressDomains.length === 0)).toBe(true)
    expect(Object.keys(piToolParameters(tools))).toEqual([
      'read_recent',
      'search_log',
      'search_memory',
    ])

    index.close()
  })

  it("binds reads to the Worker's ToolContext Space", async () => {
    const { engine, index, retrieval } = harness()
    const other = engine.createSpace({ name: 'Other' })
    engine.appendEvent('spc-health', { text: 'health-only note', origin: 'trusted:user' })
    engine.appendEvent(other.id, { text: 'other-only note', origin: 'trusted:user' })

    const readRecent = workerToolRegistry({
      spacesEngine: engine,
      memoryRetrieval: retrieval,
    }).find((tool) => tool.name === 'read_recent')
    if (!readRecent) throw new Error('missing read_recent')

    const context = fromPartial<ToolContext>({
      toolCallId: 'read-1',
      origin: 'untrusted:worker',
      origins: ['untrusted:worker'],
      taint: new TurnTaintAccumulator(['untrusted:worker']),
      spaceId: 'spc-health',
    })
    const result = await readRecent.handler(readRecent.schema.parse({ limit: 20 }), context)

    expect(result.content).toContain('health-only note')
    expect(result.content).not.toContain('other-only note')
    await expect(
      Promise.resolve().then(() =>
        readRecent.handler(readRecent.schema.parse({ spaceId: other.id, limit: 20 }), context),
      ),
    ).rejects.toThrow(/different Space/)
    index.close()
  })

  function harness(): {
    engine: SpacesEngine
    index: MemoryIndex
    retrieval: MemoryRetrieval
  } {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-worker-tools-'))
    roots.push(rootDir)
    const now = () => new Date('2026-08-24T10:00:00.000Z')
    const engine = new SpacesEngine({ rootDir, now, seed: seedSpaces() })
    const index = new MemoryIndex({ rootDir, spacesEngine: engine, now })
    const retrieval = new MemoryRetrieval({
      index,
      spacesEngine: engine,
      config: MemoryConfigSchema.parse({}),
      now,
    })
    return { engine, index, retrieval }
  }
})
