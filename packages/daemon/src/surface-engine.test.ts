import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { Store } from './store.ts'

describe('Surface engine store', () => {
  it('persists Surface state and version metadata in SQLite across Store restarts', async () => {
    const rootDir = await tempRoot()
    const first = new Store({ rootDir, now: fixedNow })

    first.applyFastAction('srf-groceries', 'milk', true, 'tap-milk-on')

    const second = new Store({ rootDir, now: fixedNow })

    expect(second.getSurface('srf-groceries')?.state['milk']).toBe(true)
    expect(second.getSurfaceVersion('srf-groceries')).toMatchObject({
      version: 2,
      treeVersion: 1,
    })
    expect(second.surfaceEventsAfter(0).map((event) => event.cursor)).toEqual([1])
  })

  it('exposes Agent tools for create_surface, patch_state, patch_tree and archive_surface', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const tools = store.surfaceTools()

    await runTool(tools, 'create_surface', {
      id: 'srf-water',
      spaceId: 'spc-health',
      title: 'Water',
      tree: {
        id: 'root',
        type: 'Box',
        children: [{ id: 'cups', type: 'Stat', binding: 'cups', props: { label: 'Cups' } }],
      },
      state: { cups: 0 },
    })

    expect(store.getSurface('srf-water')?.state['cups']).toBe(0)

    await runTool(tools, 'patch_state', {
      surfaceId: 'srf-water',
      operations: [{ target: 'state', op: 'replace', path: '/cups', value: 1 }],
    })

    expect(store.getSurface('srf-water')?.state['cups']).toBe(1)

    const version = store.getSurfaceVersion('srf-water')
    if (!version) throw new Error('expected Surface version')

    await runTool(tools, 'patch_tree', {
      surfaceId: 'srf-water',
      expectedTreeVersion: version.treeVersion,
      operations: [
        {
          target: 'tree',
          op: 'add',
          path: '/children/1',
          value: { id: 'hint', type: 'Caption', props: { text: 'Keep going.' } },
        },
      ],
    })

    expect(store.getSurface('srf-water')?.tree.children?.map((node) => node.id)).toEqual([
      'cups',
      'hint',
    ])

    await runTool(tools, 'archive_surface', { surfaceId: 'srf-water' })

    expect(store.getSurface('srf-water')).toBeUndefined()
    expect(store.listSurfaces('spc-health').map((surface) => surface.id)).not.toContain('srf-water')
  })

  it('declares every Surface tool L0 (daemon-internal, no outbound effect)', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const tools = store.surfaceTools()
    expect(tools.map((tool) => tool.level)).toEqual(['L0', 'L0', 'L0', 'L0'])
  })

  it('stamps a tainted turn origin onto the surface.patch_state event, re-tainting future context', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const tools = store.surfaceTools()

    await runTool(
      tools,
      'create_surface',
      {
        id: 'srf-tainted',
        spaceId: 'spc-health',
        title: 'Tainted',
        tree: { id: 'root', type: 'Box', children: [] },
        state: { count: 0 },
      },
      'untrusted:gmail',
    )

    await runTool(
      tools,
      'patch_state',
      {
        surfaceId: 'srf-tainted',
        operations: [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
      },
      'untrusted:gmail',
    )

    const events = store
      .eventLog('spc-health')
      .filter((event) => event.type === 'surface.patch_state' || event.type === 'surface.create')
    expect(events.every((event) => event.origin === 'untrusted:gmail')).toBe(true)
    expect(store.spacesEngine.contextOrigins('spc-health')).toContain('untrusted:gmail')
  })

  it('rejects stale Agent tree patches so the Agent can re-read and re-patch', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    store.createSurface(checklistSurface('srf-tree-conflict', 1), 'agent')
    const version = store.getSurfaceVersion('srf-tree-conflict')
    if (!version) throw new Error('expected Surface version')

    store.patchTree(
      'srf-tree-conflict',
      [
        {
          target: 'tree',
          op: 'add',
          path: '/children/1',
          value: { id: 'note', type: 'Caption', props: { text: 'Fresh patch' } },
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )

    expect(() =>
      store.patchTree(
        'srf-tree-conflict',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'stale-note', type: 'Caption', props: { text: 'Stale patch' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      ),
    ).toThrow('tree version conflict')
  })

  it('deduplicates repeated fast-path invocations with the same idempotency key', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })

    const first = store.applyFastAction('srf-groceries', 'milk', true, 'tap-milk-on')
    const second = store.applyFastAction('srf-groceries', 'milk', true, 'tap-milk-on')

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(store.surfaceEventsAfter(0)).toHaveLength(1)
    expect(store.eventLog('spc-health').filter((event) => event.type === 'fast_path')).toHaveLength(
      1,
    )
  })

  it('converges 50 concurrent fast-path taps from two devices without dropping events', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    store.createSurface(checklistSurface('srf-stress', 50), 'agent')
    const timings: number[] = []

    await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const device = index % 2 === 0 ? 'phone' : 'laptop'
        const startedAt = performance.now()
        store.applyFastAction('srf-stress', `item${index}`, true, `${device}-tap-${index}`)
        timings.push(performance.now() - startedAt)
      }),
    )

    const surface = store.getSurface('srf-stress')
    expect(surface).toBeDefined()
    expect(Object.values(surface?.state ?? {}).every((value) => value === true)).toBe(true)
    expect(
      store.surfaceEventsAfter(0).filter((event) => event.patch.surfaceId === 'srf-stress'),
    ).toHaveLength(50)
    expect(store.eventLog('spc-health').filter((event) => event.type === 'fast_path')).toHaveLength(
      50,
    )
    expect(p95(timings)).toBeLessThan(100)
    expect(store.llmCallCount()).toBe(0)
  })
})

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-surfaces-'))
}

async function runTool(
  tools: ReturnType<Store['surfaceTools']>,
  name: string,
  input: unknown,
  origin: 'trusted:user' | 'trusted:system' | `untrusted:${string}` = 'trusted:user',
): Promise<void> {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  await tool.handler(tool.schema.parse(input), { toolCallId: `call-${name}`, origin })
}

function checklistSurface(id: string, count: number): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId: 'spc-health',
    title: 'Stress checklist',
    tree: {
      id: 'root',
      type: 'Box',
      children: Array.from({ length: count }, (_, index) => ({
        id: `node-${index}`,
        type: 'Checkbox',
        binding: `item${index}`,
        props: { label: `Item ${index}` },
        actions: [{ name: 'toggle', path: 'fast', stateKey: `item${index}` }],
      })),
    },
    state: Object.fromEntries(Array.from({ length: count }, (_, index) => [`item${index}`, false])),
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'seed' },
  })
}

function p95(values: number[]): number {
  if (values.length === 0) throw new Error('cannot compute p95 for no values')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1]!
}
