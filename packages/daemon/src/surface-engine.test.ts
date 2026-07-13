import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { Store } from './store.ts'
import { SurfaceEngine, type SurfaceEngineEvent } from './surface-engine.ts'

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
    expect(second.surfaceEventsAfter(0).map((entry) => entry.event.cursor)).toEqual([1])
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
      store
        .surfaceEventsAfter(0)
        .filter((entry) => entry.kind === 'patch' && entry.event.patch.surfaceId === 'srf-stress'),
    ).toHaveLength(50)
    expect(store.eventLog('spc-health').filter((event) => event.type === 'fast_path')).toHaveLength(
      50,
    )
    expect(p95(timings)).toBeLessThan(100)
    expect(store.llmCallCount()).toBe(0)
  })

  it('backfills kind="patch" for surface_events rows written before the column existed', async () => {
    const rootDir = await tempRoot()
    // Simulate a `surfaces.sqlite` created before the `kind` column existed:
    // one legacy patch-event row, no `kind` column at all.
    const legacyDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    legacyDb.exec(`
      create table surface_events (
        cursor integer primary key,
        at text not null,
        space_id text not null,
        surface_id text not null,
        event_json text not null
      );
    `)
    const legacyEvent = {
      cursor: 1,
      at: fixedNow().toISOString(),
      spaceId: 'spc-health',
      patch: {
        surfaceId: 'srf-legacy',
        operations: [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
      },
      freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'seed' },
    }
    legacyDb
      .prepare(
        `insert into surface_events (cursor, at, space_id, surface_id, event_json)
         values (?, ?, ?, ?, ?)`,
      )
      .run(1, legacyEvent.at, legacyEvent.spaceId, 'srf-legacy', JSON.stringify(legacyEvent))
    legacyDb.close()

    const engine = new SurfaceEngine({
      rootDir,
      now: fixedNow,
      hasSpace: () => true,
      appendSpaceEvent: () => undefined,
    })

    expect(engine.surfaceEventsAfter(0)).toMatchObject([
      { kind: 'patch', event: { cursor: 1, spaceId: 'spc-health' } },
    ])
  })

  it('notifies the Surface-event observer exactly once per committed event, after commit', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const observed: SurfaceEngineEvent[] = []
    const dispose = store.onSurfaceEvent((event) => observed.push(event))

    store.createSurface(checklistSurface('srf-observed', 1), 'agent')
    store.patchState(
      'srf-observed',
      [{ target: 'state', op: 'replace', path: '/item0', value: true }],
      { updatedBy: 'agent' },
    )
    const first = store.applyFastAction('srf-observed', 'item0', false, 'tap-once')
    const second = store.applyFastAction('srf-observed', 'item0', false, 'tap-once')
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    store.archiveSurface('srf-observed', 'agent')

    expect(observed.map((event) => event.kind)).toEqual(['created', 'patch', 'patch', 'archived'])
    dispose()

    // Disposed observers hear nothing further.
    store.createSurface(checklistSurface('srf-after-dispose', 1), 'agent')
    expect(observed).toHaveLength(4)
  })

  describe('daemon-owned Surfaces (trust-owned write protection)', () => {
    it('refuses Agent patch_state on a daemon-owned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-1', 1), 'job', { daemonOwned: true })

      expect(() =>
        store.patchState(
          'srf-approval-1',
          [{ target: 'state', op: 'replace', path: '/item0', value: true }],
          { updatedBy: 'agent' },
        ),
      ).toThrow(/daemon-owned/)

      // Refused before any side effect: the state is untouched.
      expect(store.getSurface('srf-approval-1')?.state['item0']).toBe(false)
    })

    it('refuses Agent patch_tree on a daemon-owned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-2', 1), 'job', { daemonOwned: true })
      const version = store.getSurfaceVersion('srf-approval-2')
      if (!version) throw new Error('expected Surface version')

      expect(() =>
        store.patchTree(
          'srf-approval-2',
          [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'injected', type: 'Caption', props: { text: 'laundered' } },
            },
          ],
          { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
        ),
      ).toThrow(/daemon-owned/)

      expect(store.getSurfaceVersion('srf-approval-2')?.treeVersion).toBe(version.treeVersion)
    })

    it('refuses Agent archive_surface on a daemon-owned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-3', 1), 'job', { daemonOwned: true })

      expect(() => store.archiveSurface('srf-approval-3', 'agent')).toThrow(/daemon-owned/)
      expect(store.getSurface('srf-approval-3')).toBeDefined()
    })

    it('rejects daemon-owned writes through the Agent tools too (not just the Store API)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-4', 1), 'job', { daemonOwned: true })
      const tools = store.surfaceTools()

      await expect(
        runTool(tools, 'patch_state', {
          surfaceId: 'srf-approval-4',
          operations: [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        }),
      ).rejects.toThrow(/daemon-owned/)
    })

    it('still allows a fast-path user action on a daemon-owned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-5', 1), 'job', { daemonOwned: true })

      const mutation = store.applyFastAction('srf-approval-5', 'item0', true, 'tap-once')
      expect(mutation.duplicate).toBe(false)
      expect(store.getSurface('srf-approval-5')?.state['item0']).toBe(true)
    })

    it("still allows the owning manager's own updatedBy: 'job' writes on a daemon-owned Surface", async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-approval-6', 1), 'job', { daemonOwned: true })
      const version = store.getSurfaceVersion('srf-approval-6')
      if (!version) throw new Error('expected Surface version')

      store.patchState(
        'srf-approval-6',
        [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        { updatedBy: 'job' },
      )
      expect(store.getSurface('srf-approval-6')?.state['item0']).toBe(true)

      const archived = store.archiveSurface('srf-approval-6', 'job')
      expect(archived.freshness.updatedBy).toBe('job')
      expect(store.getSurface('srf-approval-6')).toBeUndefined()
    })

    it('leaves an ordinary Agent-created Surface fully writable by the Agent (default not daemon-owned)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-app-1', 1), 'agent')

      store.patchState(
        'srf-app-1',
        [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        { updatedBy: 'agent' },
      )
      expect(store.getSurface('srf-app-1')?.state['item0']).toBe(true)

      const archived = store.archiveSurface('srf-app-1', 'agent')
      expect(archived.freshness.updatedBy).toBe('agent')
    })
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
  await tool.handler(
    tool.schema.parse(input),
    fromPartial<ToolContext>({ toolCallId: `call-${name}`, origin }),
  )
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
