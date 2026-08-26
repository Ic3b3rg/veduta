import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fromPartial } from '@total-typescript/shoehorn'
import { SYSTEM_SPACE_ID, SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { Store } from './store.ts'
import { TurnTaintAccumulator } from './taint.ts'
import {
  SurfaceEngine,
  SurfaceNotPinnableError,
  SurfaceOwnershipError,
  SurfaceReadError,
  type SurfaceEngineEvent,
  type TreeProposal,
} from './surface-engine.ts'
import { ensureSystemSpace } from './system-space.ts'

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

  it('lists authorable Surfaces in stable order and reads one with current versions and content origins', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const space = store.spacesEngine.createSpace({ name: 'Surface Reads' })
    for (const [id, title, origin] of [
      ['srf-zulu', 'Zulu', 'trusted:user'],
      ['srf-alpha-b', 'Alpha', 'untrusted:gmail'],
      ['srf-alpha-a', 'Alpha', 'trusted:system'],
    ] as const) {
      store.createSurface(
        SurfaceSchema.parse({
          id,
          spaceId: space.id,
          title,
          tree: { id: 'root', type: 'Box', children: [] },
          state: { count: 0 },
          freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
        }),
        'agent',
        { contentOrigin: origin },
      )
    }
    store.patchState(
      'srf-alpha-a',
      [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
      { updatedBy: 'agent' },
    )

    const inventory = store.listAuthorableSurfaces(space.id)
    expect(inventory.surfaces).toEqual([
      expect.objectContaining({ id: 'srf-alpha-a', title: 'Alpha', pinned: false }),
      expect.objectContaining({ id: 'srf-alpha-b', title: 'Alpha', pinned: false }),
      expect.objectContaining({ id: 'srf-zulu', title: 'Zulu', pinned: false }),
    ])
    expect(
      inventory.surfaces.every((surface) => !('tree' in surface) && !('state' in surface)),
    ).toBe(true)
    expect(inventory.origins).toEqual(['trusted:system', 'untrusted:gmail', 'trusted:user'])

    const read = store.readAuthorableSurface(space.id, 'srf-alpha-a')
    expect(SurfaceSchema.parse(read.surface)).toEqual(read.surface)
    expect(read.surface.state).toEqual({ count: 1 })
    expect(read).toMatchObject({ version: 2, treeVersion: 1, origins: ['trusted:system'] })
  })

  it('refuses unknown, archived, daemon-owned, projected FACTS, and other-Space reads identically', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const activeSpace = store.spacesEngine.createSpace({ name: 'Active Reads' })
    const otherSpace = store.spacesEngine.createSpace({ name: 'Other Reads' })
    store.createSurface(emptySurface('srf-archived-read', activeSpace.id), 'agent')
    store.archiveSurface('srf-archived-read', 'agent')
    store.createSurface(emptySurface('srf-daemon-read', activeSpace.id), 'job', {
      daemonOwned: true,
    })
    store.createSurface(emptySurface('srf-other-read', otherSpace.id), 'agent')

    const rejectedIds = [
      'srf-missing-read',
      'srf-archived-read',
      'srf-daemon-read',
      store.spacesEngine.factsSurface(activeSpace.id).id,
      'srf-other-read',
    ]
    const messages = rejectedIds.map((surfaceId) => {
      try {
        store.readAuthorableSurface(activeSpace.id, surfaceId)
        throw new Error(`expected ${surfaceId} to be refused`)
      } catch (error) {
        expect(error).toBeInstanceOf(SurfaceReadError)
        if (!(error instanceof Error)) throw error
        return error.message
      }
    })

    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).not.toMatch(/missing|archived|daemon|facts|other/i)
    expect(store.listAuthorableSurfaces(activeSpace.id).surfaces).toEqual([])
  })

  it('excludes every System Surface from Agent authoring reads and Template harvesting', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    ensureSystemSpace(store.spacesEngine)
    store.createSurface(emptySurface('srf-system-legacy', SYSTEM_SPACE_ID), 'job')
    store.createSurface(emptySurface('srf-system-daemon', SYSTEM_SPACE_ID), 'job', {
      daemonOwned: true,
    })

    expect(store.listAuthorableSurfaces(SYSTEM_SPACE_ID)).toEqual({ surfaces: [], origins: [] })
    for (const surfaceId of ['srf-system-legacy', 'srf-system-daemon']) {
      expect(() => store.readAuthorableSurface(SYSTEM_SPACE_ID, surfaceId)).toThrow(
        SurfaceReadError,
      )
    }
    expect(
      store
        .stableSurfaces(new Date(fixedNow().getTime() + 1_000).toISOString())
        .map((surface) => surface.id),
    ).not.toContain('srf-system-legacy')
  })

  it('rejects every generic Agent Surface write into the System Space without side effects', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    ensureSystemSpace(store.spacesEngine)
    const legacy = SurfaceSchema.parse({
      ...checklistSurface('srf-system-legacy-write', 1),
      spaceId: SYSTEM_SPACE_ID,
    })
    const storedLegacy = store.createSurface(legacy, 'job')
    const tools = store.surfaceTools()
    const eventsBefore = store.eventLog(SYSTEM_SPACE_ID)

    await expect(
      runTool(tools, 'create_surface', {
        id: 'srf-system-agent-create',
        spaceId: SYSTEM_SPACE_ID,
        title: 'Personal notes',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
      }),
    ).rejects.toBeInstanceOf(SurfaceOwnershipError)
    await expect(
      runTool(tools, 'patch_state', {
        surfaceId: legacy.id,
        operations: [{ target: 'state', op: 'replace', path: '/item0', value: true }],
      }),
    ).rejects.toBeInstanceOf(SurfaceOwnershipError)
    await expect(
      runTool(tools, 'patch_tree', {
        surfaceId: legacy.id,
        expectedTreeVersion: 1,
        operations: [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Text', props: { text: 'Personal content' } },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(SurfaceOwnershipError)
    await expect(
      runTool(tools, 'archive_surface', { surfaceId: legacy.id }),
    ).rejects.toBeInstanceOf(SurfaceOwnershipError)

    expect(store.getSurface('srf-system-agent-create')).toBeUndefined()
    expect(store.getSurface(legacy.id)).toEqual(storedLegacy)
    expect(store.eventLog(SYSTEM_SPACE_ID)).toEqual(eventsBefore)
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

  it('publishes a Pending layout before independently committed fills and rejects a malformed fill without removing its slot', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const tools = store.surfaceTools()
    const observed: SurfaceEngineEvent[] = []
    store.onSurfaceEvent((event) => observed.push(event))

    await runTool(tools, 'create_surface', {
      id: 'srf-progressive-tools',
      spaceId: 'spc-health',
      title: 'Progressive tools',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'progressive-summary',
            type: 'Pending',
            props: { variant: 'text', label: 'Summary' },
          },
          {
            id: 'progressive-stat',
            type: 'Pending',
            props: { variant: 'stat', label: 'Distance', timeoutMs: 5_000 },
          },
          {
            id: 'progressive-route',
            type: 'Pending',
            props: { variant: 'image', label: 'Route preview', timeoutMs: 5_000 },
          },
        ],
      },
      state: {},
    })

    expect(store.getSurfaceVersion('srf-progressive-tools')?.treeVersion).toBe(1)
    expect(store.getSurface('srf-progressive-tools')?.tree.children).toMatchObject([
      {
        id: 'progressive-summary',
        type: 'Pending',
        props: { startedAt: fixedNow().toISOString() },
      },
      {
        id: 'progressive-stat',
        type: 'Pending',
        props: { startedAt: fixedNow().toISOString() },
      },
      {
        id: 'progressive-route',
        type: 'Pending',
        props: { startedAt: fixedNow().toISOString() },
      },
    ])

    await runTool(tools, 'patch_tree', {
      surfaceId: 'srf-progressive-tools',
      expectedTreeVersion: 1,
      operations: [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/0',
          value: {
            id: 'progressive-summary',
            type: 'Text',
            props: { text: 'Summary ready.' },
          },
        },
      ],
    })

    expect(store.getSurface('srf-progressive-tools')?.tree.children).toMatchObject([
      { id: 'progressive-summary', type: 'Text' },
      { id: 'progressive-stat', type: 'Pending' },
      { id: 'progressive-route', type: 'Pending' },
    ])

    await runTool(tools, 'patch_tree', {
      surfaceId: 'srf-progressive-tools',
      expectedTreeVersion: 2,
      operations: [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/1',
          value: {
            id: 'progressive-stat',
            type: 'Stat',
            props: { label: 'Distance', value: '12 km' },
          },
        },
      ],
    })

    const patchTree = tools.find((tool) => tool.name === 'patch_tree')
    if (!patchTree) throw new Error('missing tool: patch_tree')
    const malformedFill = {
      surfaceId: 'srf-progressive-tools',
      expectedTreeVersion: 3,
      operations: [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/2',
          value: {
            id: 'progressive-route',
            type: 'Pending',
            props: { variant: 'meter' },
          },
        },
      ],
    }
    expect(patchTree.schema.safeParse(malformedFill).success).toBe(false)
    expect(store.getSurface('srf-progressive-tools')?.tree.children?.[2]).toMatchObject({
      id: 'progressive-route',
      type: 'Pending',
      props: { variant: 'image' },
    })

    expect(observed.map((entry) => entry.kind)).toEqual(['created', 'patch', 'patch'])
    const patchEvents = observed.filter(
      (entry): entry is Extract<SurfaceEngineEvent, { kind: 'patch' }> => entry.kind === 'patch',
    )
    expect(patchEvents.map((entry) => entry.event.patch.operations[0]?.path)).toEqual([
      '/children/0',
      '/children/1',
    ])
    expect(store.getSurfaceVersion('srf-progressive-tools')?.treeVersion).toBe(3)
  })

  it('owns the persisted Pending start time for both creation and later tree insertion', async () => {
    let now = new Date('2026-08-21T12:00:00.000Z')
    const store = new Store({ rootDir: await tempRoot(), now: () => now })
    const tools = store.surfaceTools()

    await runTool(tools, 'create_surface', {
      id: 'srf-pending-clock',
      spaceId: 'spc-health',
      title: 'Pending clock',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'initial-slot',
            type: 'Pending',
            props: { variant: 'text', startedAt: '2099-01-01T00:00:00.000Z' },
          },
        ],
      },
      state: {},
    })

    expect(store.getSurface('srf-pending-clock')?.tree.children?.[0]?.props?.['startedAt']).toBe(
      now.toISOString(),
    )

    now = new Date('2026-08-21T12:00:05.000Z')
    await runTool(tools, 'patch_tree', {
      surfaceId: 'srf-pending-clock',
      expectedTreeVersion: 1,
      operations: [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/0',
          value: {
            id: 'replacement-slot',
            type: 'Pending',
            props: { variant: 'chart', startedAt: '2099-01-01T00:00:00.000Z' },
          },
        },
      ],
    })

    expect(store.getSurface('srf-pending-clock')?.tree.children?.[0]?.props?.['startedAt']).toBe(
      now.toISOString(),
    )
  })

  it('adds chat correlation to a live create_surface notification without persisting it for replay', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    const observed: SurfaceEngineEvent[] = []
    store.onSurfaceEvent((event) => observed.push(event))
    const createSurface = store.surfaceTools().find((tool) => tool.name === 'create_surface')
    if (!createSurface) throw new Error('missing tool: create_surface')

    await createSurface.handler(
      createSurface.schema.parse({
        id: 'srf-correlated-create',
        spaceId: 'spc-health',
        title: 'Correlated create',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
      }),
      fromPartial<ToolContext>({
        toolCallId: 'call-correlated-create',
        origin: 'trusted:user',
        taint: new TurnTaintAccumulator(['trusted:user']),
        initiatingTurn: { clientId: 'pwa-1', turnId: 'trn-1' },
      }),
    )

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      kind: 'created',
      initiatingTurn: { clientId: 'pwa-1', turnId: 'trn-1' },
      event: { surface: { id: 'srf-correlated-create' } },
    })
    expect(store.surfaceEventsAfter(0)[0]).not.toHaveProperty('initiatingTurn')
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

  it('derives a Surface tool write origin from the live taint accumulator, not just context.origin (docs/SECURITY.md §3.2, mirrors memory-tools.ts writeOriginFor)', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
    store.createSurface(checklistSurface('srf-live-taint', 1), 'agent')
    const tools = store.surfaceTools()
    const tool = tools.find((candidate) => candidate.name === 'patch_state')
    if (!tool) throw new Error('missing tool: patch_state')

    // The turn started trusted (`context.origin`), but its live taint
    // accumulator already holds an untrusted origin — the way `read_recent`
    // would grow it mid-turn — so the write must reflect that, not the
    // stale pre-turn `context.origin` alone.
    await tool.handler(
      tool.schema.parse({
        surfaceId: 'srf-live-taint',
        operations: [{ target: 'state', op: 'replace', path: '/item0', value: true }],
      }),
      fromPartial<ToolContext>({
        toolCallId: 'call-patch_state',
        origin: 'trusted:user',
        taint: { origins: () => ['untrusted:gmail'], add: () => {} },
      }),
    )

    const events = store
      .eventLog('spc-health')
      .filter((event) => event.type === 'surface.patch_state')
    expect(events).toHaveLength(1)
    expect(events[0]?.origin).toBe('untrusted:gmail')
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

  /**
   * `issues/007-surface-engine.md` promises a fast-path p95 under 100 ms —
   * native-app latency, zero LLM. That number is a claim about the daemon on an
   * otherwise idle machine, and it holds: run this file on its own
   * (`pnpm --filter @veduta/daemon exec vitest run src/surface-engine.test.ts`)
   * and the p95 is single-digit milliseconds.
   *
   * Inside the full suite this file shares the CPU with every other worker,
   * several of which drive SQLite databases and spawn subprocesses, so
   * wall-clock here measures the runner's load as much as the fast path. The
   * bound below is therefore deliberately loose: what it still catches is an
   * order-of-magnitude regression (an LLM call, an O(n^2) read, a lost
   * transaction batch), which is what this test is for. The convergence
   * assertions above it — every tap applied, 50 events, no duplicates — are
   * exact and load-independent, and `llmCallCount` pins the "zero LLM" half of
   * the criterion outright.
   */
  const FAST_PATH_P95_BOUND_MS = 400

  it(
    'converges 50 concurrent fast-path taps from two devices without dropping events',
    { retry: 2 },
    async () => {
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
          .filter(
            (entry) => entry.kind === 'patch' && entry.event.patch.surfaceId === 'srf-stress',
          ),
      ).toHaveLength(50)
      expect(
        store.eventLog('spc-health').filter((event) => event.type === 'fast_path'),
      ).toHaveLength(50)
      expect(p95(timings)).toBeLessThan(FAST_PATH_P95_BOUND_MS)
      expect(store.llmCallCount()).toBe(0)
    },
  )

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

  describe('pinning (issue 022: user locks the tree)', () => {
    it('pins a Surface, appends surface.pin to the Space Event log, and notifies observers once with a replayable event', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-pin-1', 1), 'agent')
      const cursorBefore = store.latestSurfaceCursor()

      const observed: SurfaceEngineEvent[] = []
      const dispose = store.onSurfaceEvent((event) => observed.push(event))

      const pinned = store.setPinned('srf-pin-1', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })

      expect(pinned.pinned).toBe(true)
      expect(store.getSurface('srf-pin-1')?.pinned).toBe(true)

      const pinEntries = store
        .eventLog('spc-health')
        .filter((entry) => entry.type === 'surface.pin')
      expect(pinEntries).toHaveLength(1)
      expect(pinEntries[0]?.payload).toMatchObject({ surfaceId: 'srf-pin-1', pinned: true })
      expect(pinEntries[0]?.origin).toBe('trusted:user')

      const replayed = store.surfaceEventsAfter(cursorBefore)
      expect(replayed).toHaveLength(1)
      expect(replayed[0]).toMatchObject({
        kind: 'pinned',
        event: { surfaceId: 'srf-pin-1', pinned: true },
      })

      expect(observed).toHaveLength(1)
      expect(observed[0]).toMatchObject({
        kind: 'pinned',
        event: { surfaceId: 'srf-pin-1', pinned: true },
      })
      dispose()
    })

    it('the surface.pinned event carries the bumped freshness, not just pinned (the PWA reducer needs it to move updatedAt/updatedBy off whatever it last observed)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-pin-freshness', 1), 'agent')

      const pinned = store.setPinned('srf-pin-freshness', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })

      const replayed = store.surfaceEventsAfter(0)
      const pinnedEvent = replayed.find((entry) => entry.kind === 'pinned')
      if (!pinnedEvent || pinnedEvent.kind !== 'pinned') throw new Error('expected a pinned event')
      expect(pinnedEvent.event.freshness).toEqual(pinned.freshness)
      expect(pinnedEvent.event.freshness.updatedBy).toBe('user')
    })

    it('unpins a previously pinned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-pin-2', 1), 'agent')
      store.setPinned('srf-pin-2', true, { origin: 'trusted:user', updatedBy: 'user' })

      const unpinned = store.setPinned('srf-pin-2', false, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })

      expect(unpinned.pinned).toBe(false)
      expect(store.getSurface('srf-pin-2')?.pinned).toBe(false)
    })

    it('refuses to pin a daemon-owned Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-pin-daemon', 1), 'job', { daemonOwned: true })

      expect(() =>
        store.setPinned('srf-pin-daemon', true, { origin: 'trusted:user', updatedBy: 'user' }),
      ).toThrow(SurfaceNotPinnableError)
      expect(store.getSurface('srf-pin-daemon')?.pinned).toBe(false)
    })

    it('refuses to pin an unknown Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })

      expect(() =>
        store.setPinned('srf-does-not-exist', true, { origin: 'trusted:user', updatedBy: 'user' }),
      ).toThrow(SurfaceNotPinnableError)
    })

    it("never hardcodes trusted:user/updatedBy: a tool-driven pin stamps the caller's own origin and updatedBy, with the rendered title neutralized and truncated", async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const taintedTitle = `<<<evil>>> ${'x'.repeat(250)}`
      store.createSurface(
        SurfaceSchema.parse({
          id: 'srf-pin-tainted',
          spaceId: 'spc-health',
          title: taintedTitle,
          tree: { id: 'root', type: 'Box', children: [] },
          state: {},
          freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
        }),
        'agent',
      )

      // A tool-driven pin (not a human tap): if `updatedBy`/`origin` were
      // still hardcoded to `'user'`/`'trusted:user'`, this would forge a
      // genuine user event a scheduler condition rule could self-satisfy.
      const pinned = store.setPinned('srf-pin-tainted', true, {
        origin: 'untrusted:gmail',
        updatedBy: 'agent',
      })

      expect(pinned.freshness.updatedBy).toBe('agent')
      expect(store.getSurface('srf-pin-tainted')?.freshness.updatedBy).toBe('agent')

      const pinEntries = store
        .eventLog('spc-health')
        .filter((entry) => entry.type === 'surface.pin')
      expect(pinEntries).toHaveLength(1)
      // Never the hardcoded 'trusted:user' the old implementation always used.
      expect(pinEntries[0]?.origin).toBe('untrusted:gmail')
      expect(pinEntries[0]?.text).not.toContain('<<<evil>>>')
      expect(pinEntries[0]?.text).toContain('…') // truncated, same as approval-surface.ts's card text
    })
  })

  describe('tree freshness (issue 022: stability harvest)', () => {
    it('moves tree_updated_at on patchTree but not on patchState', async () => {
      const rootDir = await tempRoot()
      const store = new Store({ rootDir, now: fixedNow })
      store.createSurface(checklistSurface('srf-fresh-1', 1), 'agent')

      const laterNow = () => new Date('2026-07-10T00:00:00.000Z')
      const laterStore = new Store({ rootDir, now: laterNow })

      // A cutoff just before the Surface was created: it must be reported
      // stable (its tree has not moved since).
      expect(laterStore.stableSurfaces('2026-07-04T00:00:00.000Z').map((s) => s.id)).toContain(
        'srf-fresh-1',
      )

      laterStore.patchState(
        'srf-fresh-1',
        [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        { updatedBy: 'agent' },
      )
      // patchState must not move tree_updated_at: still stable at the same cutoff.
      expect(laterStore.stableSurfaces('2026-07-04T00:00:00.000Z').map((s) => s.id)).toContain(
        'srf-fresh-1',
      )

      const version = laterStore.getSurfaceVersion('srf-fresh-1')
      if (!version) throw new Error('expected Surface version')
      laterStore.patchTree(
        'srf-fresh-1',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Caption', props: { text: 'restructured' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      // patchTree moves tree_updated_at to `laterNow`: no longer stable at
      // the original cutoff.
      expect(laterStore.stableSurfaces('2026-07-04T00:00:00.000Z').map((s) => s.id)).not.toContain(
        'srf-fresh-1',
      )
      expect(laterStore.stableSurfaces('2026-07-10T00:00:00.000Z').map((s) => s.id)).toContain(
        'srf-fresh-1',
      )
    })
  })

  describe('stableSurfaces (issue 022: Template harvest stability query)', () => {
    it('selects only Surfaces past the cutoff and never a daemon-owned one', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-stable-1', 1), 'agent')
      store.createSurface(checklistSurface('srf-stable-daemon', 1), 'job', { daemonOwned: true })

      const cutoffAfterCreation = new Date(fixedNow().getTime() + 1000).toISOString()
      const stable = store.stableSurfaces(cutoffAfterCreation).map((s) => s.id)

      expect(stable).toContain('srf-stable-1')
      expect(stable).not.toContain('srf-stable-daemon')

      const cutoffBeforeCreation = new Date(fixedNow().getTime() - 1000).toISOString()
      expect(store.stableSurfaces(cutoffBeforeCreation).map((s) => s.id)).not.toContain(
        'srf-stable-1',
      )
    })
  })

  describe('tree proposals (issue 022: pinned Surface intercepts patch_tree)', () => {
    it('records a pending proposal instead of mutating for an Agent patch_tree on a pinned Surface, appends surface.tree_proposal, emits no patch event, and still accepts patch_state', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-1', 2), 'agent')
      store.setPinned('srf-proposal-1', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-proposal-1')
      if (!version) throw new Error('expected Surface version')

      const observed: SurfaceEngineEvent[] = []
      const dispose = store.onSurfaceEvent((event) => observed.push(event))

      const result = store.patchTree(
        'srf-proposal-1',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/2',
            value: { id: 'note', type: 'Caption', props: { text: 'proposed' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )

      if (!('proposed' in result)) throw new Error('expected a Tree proposal, got a mutation')
      expect(result).toMatchObject({ proposed: true, surfaceId: 'srf-proposal-1' })
      const proposalId = result.proposalId

      // Nothing mutated: tree and tree_version are untouched.
      expect(store.getSurface('srf-proposal-1')?.tree.children).toHaveLength(2)
      expect(store.getSurfaceVersion('srf-proposal-1')?.treeVersion).toBe(version.treeVersion)

      // Exactly one pending proposal recorded.
      const pending = store.listTreeProposals({ surfaceId: 'srf-proposal-1', status: 'pending' })
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        id: proposalId,
        surfaceId: 'srf-proposal-1',
        status: 'pending',
        expectedTreeVersion: version.treeVersion,
      })
      expect(store.getTreeProposal(proposalId)).toMatchObject({ status: 'pending' })

      // A surface.tree_proposal entry landed in the Space Event log.
      const proposalEntries = store
        .eventLog('spc-health')
        .filter((entry) => entry.type === 'surface.tree_proposal')
      expect(proposalEntries).toHaveLength(1)
      expect(proposalEntries[0]?.payload).toMatchObject({
        surfaceId: 'srf-proposal-1',
        proposalId,
        operations: 1,
      })

      // No surface patch event was emitted for the intercepted tree patch.
      expect(observed.map((event) => event.kind)).not.toContain('patch')
      dispose()

      // AC2: the tree is locked, but patch_state keeps applying.
      store.patchState(
        'srf-proposal-1',
        [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        { updatedBy: 'agent' },
      )
      expect(store.getSurface('srf-proposal-1')?.state['item0']).toBe(true)
    })

    it('throws at proposal time for an invalid proposed patch and records nothing', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-invalid', 1), 'agent')
      store.setPinned('srf-proposal-invalid', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-proposal-invalid')
      if (!version) throw new Error('expected Surface version')

      expect(() =>
        store.patchTree(
          'srf-proposal-invalid',
          [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'broken', type: 'Checkbox', binding: 'does-not-exist' },
            },
          ],
          { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
        ),
      ).toThrow(/does not exist in Surface state/)

      expect(store.listTreeProposals({ surfaceId: 'srf-proposal-invalid' })).toHaveLength(0)
      expect(store.getSurfaceVersion('srf-proposal-invalid')?.treeVersion).toBe(version.treeVersion)
    })

    it('applies on a pinned Surface when bypassPin is true, bumping tree_version', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-bypass', 1), 'agent')
      store.setPinned('srf-proposal-bypass', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-proposal-bypass')
      if (!version) throw new Error('expected Surface version')

      const result = store.patchTree(
        'srf-proposal-bypass',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Caption', props: { text: 'accepted' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'job', bypassPin: true },
      )

      if ('proposed' in result) throw new Error('expected a mutation, got a Tree proposal')
      expect(result.surface.tree.children).toHaveLength(2)
      expect(store.getSurfaceVersion('srf-proposal-bypass')?.treeVersion).toBe(
        version.treeVersion + 1,
      )
      expect(store.listTreeProposals({ surfaceId: 'srf-proposal-bypass' })).toHaveLength(0)
    })

    it('resolves a pending proposal exactly once (a doubled Accept/Reject click resolves once)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-resolve', 1), 'agent')
      store.setPinned('srf-proposal-resolve', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-proposal-resolve')
      if (!version) throw new Error('expected Surface version')

      const result = store.patchTree(
        'srf-proposal-resolve',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Caption', props: { text: 'pending' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')

      const first = store.resolveTreeProposal(result.proposalId, 'accepted', 'trusted:user')
      expect(first?.status).toBe('accepted')
      expect(first?.resolvedAt).toBeDefined()

      const second = store.resolveTreeProposal(result.proposalId, 'accepted', 'trusted:user')
      expect(second).toBeUndefined()
    })

    it('leaves an unpinned Surface patch_tree behaving exactly as before (regression)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-unpinned', 1), 'agent')
      const version = store.getSurfaceVersion('srf-proposal-unpinned')
      if (!version) throw new Error('expected Surface version')

      const result = store.patchTree(
        'srf-proposal-unpinned',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Caption', props: { text: 'ordinary' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )

      if ('proposed' in result) throw new Error('expected a mutation, got a Tree proposal')
      expect(result.surface.tree.children).toHaveLength(2)
      expect(store.getSurfaceVersion('srf-proposal-unpinned')?.treeVersion).toBe(
        version.treeVersion + 1,
      )
      expect(store.listTreeProposals()).toHaveLength(0)
    })

    it('tells the Agent plainly through the patch_tree tool that a pinned Surface produced a proposal, never an error', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-tool', 1), 'agent')
      store.setPinned('srf-proposal-tool', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-proposal-tool')
      if (!version) throw new Error('expected Surface version')
      const tools = store.surfaceTools()
      const tool = tools.find((candidate) => candidate.name === 'patch_tree')
      if (!tool) throw new Error('missing tool: patch_tree')

      const outcome = await tool.handler(
        tool.schema.parse({
          surfaceId: 'srf-proposal-tool',
          expectedTreeVersion: version.treeVersion,
          operations: [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'note', type: 'Caption', props: { text: 'proposed' } },
            },
          ],
        }),
        fromPartial<ToolContext>({
          toolCallId: 'call-patch_tree',
          origin: 'trusted:user',
          taint: new TurnTaintAccumulator(['trusted:user']),
        }),
      )

      expect(outcome.content).toBe(
        'tree change proposed for Surface srf-proposal-tool, awaiting the user',
      )
      expect(outcome.details).toMatchObject({ proposalId: expect.any(Number) })
    })

    it('an untrusted target Surface folds its content_origin into surface.tree_proposal, neutralizing and truncating the interpolated title', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const taintedTitle = `<<<evil>>> ${'x'.repeat(250)}`
      store.createSurface(
        SurfaceSchema.parse({
          id: 'srf-proposal-untrusted-target',
          spaceId: 'spc-health',
          title: taintedTitle,
          tree: {
            id: 'root',
            type: 'Box',
            children: [
              { id: 'node-0', type: 'Checkbox', binding: 'item0', props: { label: 'Item 0' } },
            ],
          },
          state: { item0: false },
          freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
        }),
        'agent',
        { contentOrigin: 'untrusted:hermes' },
      )
      store.setPinned('srf-proposal-untrusted-target', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      const version = store.getSurfaceVersion('srf-proposal-untrusted-target')
      if (!version) throw new Error('expected Surface version')

      const result = store.patchTree(
        'srf-proposal-untrusted-target',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'note', type: 'Caption', props: { text: 'proposed' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')

      const proposalEntries = store
        .eventLog('spc-health')
        .filter((entry) => entry.type === 'surface.tree_proposal')
      expect(proposalEntries).toHaveLength(1)
      // Never the patching caller's own (trusted) origin alone: the target's
      // untrusted stored content_origin must be folded in.
      expect(proposalEntries[0]?.origin).toBe('untrusted:hermes')
      expect(proposalEntries[0]?.text).not.toContain('<<<evil>>>')
      expect(proposalEntries[0]?.text).toContain('…') // truncated

      expect(store.getTreeProposal(result.proposalId)?.origin).toBe('untrusted:hermes')
    })

    it('a throwing onTreeProposal observer does not escape patchTree, and the proposal is still recorded exactly once', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-proposal-observer-throws', 1), 'agent')
      store.setPinned('srf-proposal-observer-throws', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      const version = store.getSurfaceVersion('srf-proposal-observer-throws')
      if (!version) throw new Error('expected Surface version')

      const seen: TreeProposal[] = []
      const dispose = store.onTreeProposal((proposal) => {
        seen.push(proposal)
        throw new Error('boom: observer failure')
      })

      expect(() =>
        store.patchTree(
          'srf-proposal-observer-throws',
          [
            {
              target: 'tree',
              op: 'add',
              path: '/children/1',
              value: { id: 'note', type: 'Caption', props: { text: 'proposed' } },
            },
          ],
          { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
        ),
      ).not.toThrow()

      expect(seen).toHaveLength(1)
      expect(store.listTreeProposals({ surfaceId: 'srf-proposal-observer-throws' })).toHaveLength(1)
      dispose()
    })
  })

  describe('content origin and provenance (issue 022: no laundering imported Template text)', () => {
    it('produces an agent_path Event log entry carrying trusted:user for an ordinary Surface', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(agentActionSurface('srf-origin-trusted'), 'agent')

      store.invokeSurfaceAction('srf-origin-trusted', { nodeId: 'trigger', name: 'go' })

      const events = store.eventLog('spc-health').filter((event) => event.type === 'agent_path')
      expect(events).toHaveLength(1)
      expect(events[0]?.origin).toBe('trusted:user')
    })

    it('produces an agent_path Event log entry carrying the untrusted content origin for a Surface instantiated from an untrusted Template', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(agentActionSurface('srf-origin-untrusted'), 'agent', {
        contentOrigin: 'untrusted:hermes',
      })

      expect(store.surfaceProvenance('srf-origin-untrusted')).toMatchObject({
        contentOrigin: 'untrusted:hermes',
      })

      store.invokeSurfaceAction('srf-origin-untrusted', { nodeId: 'trigger', name: 'go' })

      const events = store.eventLog('spc-health').filter((event) => event.type === 'agent_path')
      expect(events).toHaveLength(1)
      expect(events[0]?.origin).toBe('untrusted:hermes')
    })

    it('records templateSpaceId alongside templateId (a Template id is only unique within its own Space, so templateId alone is ambiguous about which Template a reused Surface came from)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(agentActionSurface('srf-provenance-space'), 'agent', {
        templateId: 'tpl-tracker-abc123',
        templateSpaceId: 'spc-source',
      })

      expect(store.surfaceProvenance('srf-provenance-space')).toMatchObject({
        templateId: 'tpl-tracker-abc123',
        templateSpaceId: 'spc-source',
      })
    })

    it('a tainted patch_tree re-marks content_origin (content_origin was write-once), so a later agent_path event carries the untrusted origin', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(agentActionSurface('srf-origin-relaundered'), 'agent')
      expect(store.surfaceProvenance('srf-origin-relaundered')).toMatchObject({
        contentOrigin: 'trusted:user',
      })

      const version = store.getSurfaceVersion('srf-origin-relaundered')
      if (!version) throw new Error('expected Surface version')
      store.patchTree(
        'srf-origin-relaundered',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'injected', type: 'Caption', props: { text: 'attacker text' } },
          },
        ],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent', origin: 'untrusted:gmail' },
      )

      expect(store.surfaceProvenance('srf-origin-relaundered')).toMatchObject({
        contentOrigin: 'untrusted:gmail',
      })

      store.invokeSurfaceAction('srf-origin-relaundered', { nodeId: 'trigger', name: 'go' })

      const events = store.eventLog('spc-health').filter((event) => event.type === 'agent_path')
      expect(events).toHaveLength(1)
      expect(events[0]?.origin).toBe('untrusted:gmail')
    })

    it('a state patch from an untrusted turn moves content_origin too, not only a tree patch (content_origin used to move only on a tree patch, missing that a state patch can carry attacker text into Surface state)', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-origin-state-tainted', 1), 'agent')
      expect(store.surfaceProvenance('srf-origin-state-tainted')).toMatchObject({
        contentOrigin: 'trusted:user',
      })

      store.patchState(
        'srf-origin-state-tainted',
        [{ target: 'state', op: 'replace', path: '/item0', value: true }],
        { updatedBy: 'agent', origin: 'untrusted:gmail' },
      )

      expect(store.surfaceProvenance('srf-origin-state-tainted')).toMatchObject({
        contentOrigin: 'untrusted:gmail',
      })
    })

    it('a tainted-turn create_surface tool call yields an untrusted content_origin, not the hardcoded trusted:user the tool used to default to', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const tools = store.surfaceTools()

      await runTool(
        tools,
        'create_surface',
        {
          id: 'srf-tainted-create',
          spaceId: 'spc-health',
          title: 'Tainted create',
          tree: { id: 'root', type: 'Box', children: [] },
          state: {},
        },
        'untrusted:gmail',
      )

      expect(store.surfaceProvenance('srf-tainted-create')).toMatchObject({
        contentOrigin: 'untrusted:gmail',
      })
    })

    it('a fast-path tap on an untrusted-content Surface logs an untrusted fast_path event, not a hardcoded trusted:user', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-fast-tainted', 1), 'agent', {
        contentOrigin: 'untrusted:hermes',
      })

      store.applyFastAction('srf-fast-tainted', 'item0', true, 'tap-tainted')

      const events = store.eventLog('spc-health').filter((event) => event.type === 'fast_path')
      expect(events).toHaveLength(1)
      expect(events[0]?.origin).toBe('untrusted:hermes')
    })

    it('a fast-path tap on an ordinary Surface still logs trusted:user', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      store.createSurface(checklistSurface('srf-fast-ordinary', 1), 'agent')

      store.applyFastAction('srf-fast-ordinary', 'item0', true, 'tap-ordinary')

      const events = store.eventLog('spc-health').filter((event) => event.type === 'fast_path')
      expect(events).toHaveLength(1)
      expect(events[0]?.origin).toBe('trusted:user')
    })
  })

  describe('pre-022 database migration', () => {
    it('migrates a surfaces.sqlite without pinned/tree_updated_at/template_id/content_origin, backfilling tree_updated_at from updated_at', async () => {
      const rootDir = await tempRoot()
      const legacyUpdatedAt = '2026-06-01T00:00:00.000Z'
      const legacyDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
      // Pre-022 schema: no `pinned`, `tree_updated_at`, `template_id` or
      // `content_origin` columns at all (mirrors the pre-`daemon_owned`
      // migration test above).
      legacyDb.exec(`
        create table surfaces (
          id text primary key,
          space_id text not null,
          title text not null,
          tree_json text not null,
          state_json text not null,
          version integer not null,
          tree_version integer not null,
          updated_at text not null,
          updated_by text not null,
          archived integer not null default 0,
          daemon_owned integer not null default 0
        );
        create table surface_events (
          cursor integer primary key,
          at text not null,
          space_id text not null,
          surface_id text not null,
          kind text not null default 'patch',
          event_json text not null
        );
        create table idempotency_keys (
          key text primary key,
          event_cursor integer not null references surface_events(cursor)
        );
        create table agent_turns (
          id integer primary key autoincrement,
          at text not null,
          space_id text not null,
          surface_id text not null,
          atom_id text not null,
          action_name text not null,
          payload_json text not null,
          surface_json text not null,
          atom_json text not null
        );
      `)
      const legacySurface = checklistSurface('srf-pre-022', 1)
      legacyDb
        .prepare(
          `insert into surfaces
             (id, space_id, title, tree_json, state_json, version, tree_version,
              updated_at, updated_by, archived, daemon_owned)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacySurface.id,
          legacySurface.spaceId,
          legacySurface.title,
          JSON.stringify(legacySurface.tree),
          JSON.stringify(legacySurface.state),
          1,
          1,
          legacyUpdatedAt,
          'seed',
          0,
          0,
        )
      legacyDb.close()

      const engine = new SurfaceEngine({
        rootDir,
        now: fixedNow,
        hasSpace: () => true,
        appendSpaceEvent: () => undefined,
      })

      const migrated = engine.getSurface('srf-pre-022')
      expect(migrated).toMatchObject({ pinned: false, pinnable: true })
      // Backfilled from `updated_at`, not left at the migration default ('').
      expect(engine.stableSurfaces(legacyUpdatedAt).map((s) => s.id)).toContain('srf-pre-022')
      expect(engine.surfaceProvenance('srf-pre-022')).toMatchObject({
        contentOrigin: 'trusted:user',
      })
    })
  })

  describe('Gateway-owned Surface order migration (issue #108)', () => {
    it('backfills once from Surface events, uses stable fallbacks, excludes archived Surfaces, and preserves manual order across restarts', async () => {
      const rootDir = await tempRoot()
      const first = new Store({ rootDir, now: fixedNow })
      const otherSpace = first.spacesEngine.createSpace({ name: 'Other ordering' })

      for (const id of [
        'srf-backfill-regular-old',
        'srf-backfill-regular-new',
        'srf-backfill-pin-old',
        'srf-backfill-pin-new',
        'srf-backfill-unpinned-recent',
        'srf-backfill-fallback-ä',
        'srf-backfill-fallback-z',
        'srf-backfill-archived',
      ]) {
        first.createSurface(checklistSurface(id, 1), 'agent')
      }
      first.setPinned('srf-backfill-pin-old', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      first.setPinned('srf-backfill-pin-new', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      first.setPinned('srf-backfill-unpinned-recent', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      first.setPinned('srf-backfill-unpinned-recent', false, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      first.archiveSurface('srf-backfill-archived', 'agent')
      first.createSurface(
        SurfaceSchema.parse({
          ...checklistSurface('srf-backfill-other-space', 1),
          spaceId: otherSpace.id,
        }),
        'agent',
      )

      const cursorBeforeBackfill = first.latestSurfaceCursor()
      const healthEventsBeforeBackfill = first.eventLog('spc-health')
      const rawDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
      rawDb.exec(`
        delete from surface_order_items;
        delete from surface_order_state;
        delete from surface_events
          where surface_id in ('srf-backfill-fallback-ä', 'srf-backfill-fallback-z');
      `)
      rawDb.close()

      const second = new Store({ rootDir, now: fixedNow })
      const healthOrder = second
        .snapshot()
        .spaces.find((space) => space.id === 'spc-health')
        ?.surfaces.map((surface) => surface.id)
        .filter((id) => id.startsWith('srf-backfill-'))
      const otherOrder = second
        .snapshot()
        .spaces.find((space) => space.id === otherSpace.id)
        ?.surfaces.map((surface) => surface.id)
        .filter((id) => id.startsWith('srf-backfill-'))

      expect(healthOrder).toEqual([
        'srf-backfill-pin-new',
        'srf-backfill-pin-old',
        'srf-backfill-unpinned-recent',
        'srf-backfill-regular-new',
        'srf-backfill-regular-old',
        'srf-backfill-fallback-z',
        'srf-backfill-fallback-ä',
      ])
      expect(otherOrder).toEqual(['srf-backfill-other-space'])
      expect(healthOrder).not.toContain('srf-backfill-archived')
      expect(second.latestSurfaceCursor()).toBeLessThanOrEqual(cursorBeforeBackfill)
      expect(second.eventLog('spc-health')).toEqual(healthEventsBeforeBackfill)

      second.moveSurface('spc-health', 'srf-backfill-regular-old', 'up')
      const manuallyOrdered = second.surfaceOrder('spc-health')
      const third = new Store({ rootDir, now: fixedNow })

      expect(third.surfaceOrder('spc-health')).toEqual(manuallyOrdered)
      expect(
        third
          .snapshot()
          .spaces.find((space) => space.id === 'spc-health')
          ?.surfaces.map((surface) => surface.id)
          .filter((id) => id.startsWith('srf-backfill-')),
      ).toEqual([
        'srf-backfill-pin-new',
        'srf-backfill-pin-old',
        'srf-backfill-unpinned-recent',
        'srf-backfill-regular-old',
        'srf-backfill-regular-new',
        'srf-backfill-fallback-z',
        'srf-backfill-fallback-ä',
      ])
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
    fromPartial<ToolContext>({
      toolCallId: `call-${name}`,
      origin,
      taint: new TurnTaintAccumulator([origin]),
    }),
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

function emptySurface(id: string, spaceId: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: id,
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
  })
}

/** A Surface with one node declaring an `agent`-path action, for `enqueueAgentAction` tests. */
function agentActionSurface(id: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId: 'spc-health',
    title: 'Agent trigger',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'trigger',
          type: 'Button',
          props: { label: 'Go' },
          actions: [{ name: 'go', path: 'agent' }],
        },
      ],
    },
    state: {},
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'seed' },
  })
}

function p95(values: number[]): number {
  if (values.length === 0) throw new Error('cannot compute p95 for no values')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1]!
}
