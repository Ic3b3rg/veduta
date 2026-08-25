import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { Store } from './store.ts'
import type { SurfaceEngineEvent } from './surface-engine.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'
import { piToolParameters } from './tool-parameters.ts'

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness(options: { now?: () => Date; timeZone?: string } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-focused-surface-tools-'))
  createdDirs.push(rootDir)
  const store = new Store({
    rootDir,
    now: options.now ?? (() => new Date('2026-08-11T10:00:00.000Z')),
    timeZone: options.timeZone ?? 'Europe/Rome',
  })
  const space = store.spacesEngine.createSpace({ name: 'Tool Reads' })
  const templateEngine = new TemplateEngine({ store })
  return {
    store,
    space,
    templateEngine,
    tools: createFocusedSurfaceTools({ store, templateEngine, spaceId: space.id }),
  }
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool
}

const unusedContext = fromPartial<ToolContext>({})
const trustedContext = fromPartial<ToolContext>({
  toolCallId: 'focused-surface-tool-call',
  origin: 'trusted:user',
  origins: ['trusted:user'],
  taint: new TurnTaintAccumulator(['trusted:user']),
  contextHash: 'focused-surface-tools-test',
})

describe('createFocusedSurfaceTools', () => {
  it('lists only compact authorable Surface summaries in stable order with deduplicated origins', async () => {
    const { store, space, tools } = harness()
    for (const [id, title] of [
      ['srf-tool-zulu', 'Zulu'],
      ['srf-tool-alpha-b', 'Alpha'],
      ['srf-tool-alpha-a', 'Alpha'],
    ]) {
      store.createSurface(
        SurfaceSchema.parse({
          id,
          spaceId: space.id,
          title,
          tree: { id: 'root', type: 'Box', children: [] },
          state: { hiddenFromInventory: true },
          freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'agent' },
        }),
        'agent',
        { contentOrigin: 'trusted:user' },
      )
    }

    const listSurfaces = toolNamed(tools, 'list_surfaces')
    const parameters = piToolParameters([listSurfaces])['list_surfaces'] as Record<string, unknown>
    expect(parameters['properties']).toEqual({})
    const result = await listSurfaces.handler(listSurfaces.schema.parse({}), unusedContext)
    const summaries = JSON.parse(result.content) as Array<Record<string, unknown>>

    expect(summaries.map((surface) => surface['id'])).toEqual([
      'srf-tool-alpha-a',
      'srf-tool-alpha-b',
      'srf-tool-zulu',
    ])
    expect(
      summaries.every(
        (surface) => Object.keys(surface).sort().join(',') === 'freshness,id,pinned,title',
      ),
    ).toBe(true)
    expect(result.origins).toEqual(['trusted:user'])
  })

  it('reads the complete validated Surface and current versions without accepting a Space id', async () => {
    const { store, space, tools } = harness()
    store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-complete-read',
        spaceId: space.id,
        title: 'Complete read',
        tree: {
          id: 'root',
          type: 'Box',
          children: [{ id: 'count', type: 'Stat', binding: 'count', props: { label: 'Count' } }],
        },
        state: { count: 1 },
        freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'agent' },
      }),
      'agent',
      { contentOrigin: 'trusted:system' },
    )
    store.patchState(
      'srf-complete-read',
      [{ target: 'state', op: 'replace', path: '/count', value: 2 }],
      { updatedBy: 'agent' },
    )

    const readSurface = toolNamed(tools, 'read_surface')
    const parameters = piToolParameters([readSurface])['read_surface'] as Record<string, unknown>
    expect(Object.keys(parameters['properties'] as Record<string, unknown>)).toEqual(['surfaceId'])
    const result = await readSurface.handler(
      readSurface.schema.parse({ surfaceId: 'srf-complete-read' }),
      unusedContext,
    )
    const read = JSON.parse(result.content)

    expect(SurfaceSchema.parse(read.surface)).toEqual(read.surface)
    expect(read.surface.tree.children[0]).toMatchObject({ id: 'count', binding: 'count' })
    expect(read.surface.state).toEqual({ count: 2 })
    expect(read).toMatchObject({ version: 2, treeVersion: 1 })
    expect(result.origins).toEqual(['trusted:system'])
  })

  it('binds create_surface to the focused Space and strips any caller-supplied Space id', async () => {
    const { store, space, tools } = harness()
    const otherSpace = store.spacesEngine.createSpace({ name: 'Redirect Target' })
    const createSurface = toolNamed(tools, 'create_surface')
    const parameters = piToolParameters([createSurface])['create_surface'] as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(
      ['id', 'title', 'tree', 'state', 'relativeTime', 'intent', 'justification'].sort(),
    )

    const input = createSurface.schema.parse({
      id: 'srf-bound-create',
      spaceId: otherSpace.id,
      title: 'Bound create',
      tree: { id: 'root', type: 'Box', children: [] },
      state: { ready: true },
    })
    expect(input).not.toHaveProperty('spaceId')
    await createSurface.handler(input, trustedContext)

    expect(store.getSurface('srf-bound-create')).toMatchObject({ spaceId: space.id })
    expect(store.listAuthorableSurfaces(otherSpace.id).surfaces).toEqual([])
  })

  it('refuses a Surface mutation whose id belongs to another Space', async () => {
    const { store, tools } = harness()
    const otherSpace = store.spacesEngine.createSpace({ name: 'Other Scope' })
    store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-other-scope',
        spaceId: otherSpace.id,
        title: 'Other scope',
        tree: { id: 'root', type: 'Stat', binding: 'count', props: { label: 'Count' } },
        state: { count: 0 },
        freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'agent' },
      }),
      'agent',
    )
    const patchState = toolNamed(tools, 'patch_state')

    expect(() =>
      patchState.handler(
        patchState.schema.parse({
          surfaceId: 'srf-other-scope',
          operations: [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
        }),
        trustedContext,
      ),
    ).toThrow(/not authorable in this Space/)
    expect(store.getSurface('srf-other-scope')?.state['count']).toBe(0)
  })

  it('keeps Template refusal and justified regeneration on the bound create_surface path', async () => {
    const { store, space, templateEngine, tools } = harness()
    const otherSpace = store.spacesEngine.createSpace({ name: 'Unbound Template Space' })
    store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-template-source',
        spaceId: space.id,
        title: 'Habit tracker',
        tree: {
          id: 'root',
          type: 'Box',
          children: [{ id: 'done', type: 'Checkbox', binding: 'done', props: { label: 'Done' } }],
        },
        state: { done: false },
        freshness: { updatedAt: '2026-08-11T10:00:00.000Z', updatedBy: 'agent' },
      }),
      'agent',
    )
    const { template } = templateEngine.pin('srf-template-source', true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    if (!template) throw new Error('expected the pinned Surface to save a Template')
    const observed: SurfaceEngineEvent[] = []
    store.onSurfaceEvent((event) => observed.push(event))
    const initiatingContext = fromPartial<ToolContext>({
      toolCallId: 'correlated-direct-create',
      origin: 'trusted:user',
      origins: ['trusted:user'],
      taint: new TurnTaintAccumulator(['trusted:user']),
      contextHash: 'focused-surface-tools-test',
      initiatingTurn: { clientId: 'pwa-direct', turnId: 'trn-direct' },
    })

    const createSurface = toolNamed(tools, 'create_surface')
    const candidate = {
      id: 'srf-template-candidate',
      spaceId: otherSpace.id,
      title: 'Habit tracker',
      intent: 'Habit tracker',
      tree: {
        id: 'root',
        type: 'Box',
        children: [{ id: 'done', type: 'Checkbox', binding: 'done', props: { label: 'Done' } }],
      },
      state: { done: false },
    }
    const refusal = await createSurface.handler(
      createSurface.schema.parse(candidate),
      initiatingContext,
    )
    expect(refusal.content).toContain(template.id)
    expect(refusal.content).toContain(space.id)
    expect(store.getSurface(candidate.id)).toBeUndefined()
    expect(observed).toEqual([])

    await createSurface.handler(
      createSurface.schema.parse({
        ...candidate,
        justification: 'This Surface needs an independently evolving composition.',
      }),
      initiatingContext,
    )
    expect(store.getSurface(candidate.id)).toMatchObject({ spaceId: space.id })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      kind: 'created',
      initiatingTurn: { clientId: 'pwa-direct', turnId: 'trn-direct' },
      event: { surface: { id: candidate.id } },
    })
    expect(
      store
        .eventLog(space.id)
        .find(
          (event) =>
            event.type === 'template.regenerated' && event.payload?.['surfaceId'] === candidate.id,
        ),
    ).toBeDefined()
    expect(
      store.eventLog(otherSpace.id).some((event) => event.type === 'template.regenerated'),
    ).toBe(false)
  })

  it('creates a non-food relative-time Surface with Gateway-owned local-calendar validity', async () => {
    const { store, space, tools } = harness()
    const createSurface = toolNamed(tools, 'create_surface')
    const input = createSurface.schema.parse({
      id: 'srf-daily-spending',
      title: 'Daily spending',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'count', type: 'Stat', binding: 'todayCount', props: { label: 'Today' } },
          { id: 'total', type: 'Stat', binding: 'todayTotal', props: { label: 'Total' } },
          { id: 'latest', type: 'Stat', binding: 'latestMerchant', props: { label: 'Latest' } },
          {
            id: 'rows',
            type: 'Table',
            binding: 'todayRows',
            props: { columns: ['merchant', 'amount'] },
          },
        ],
      },
      state: {
        spendingRecords: [
          {
            id: 'expense-1',
            occurredAt: '2026-08-11T11:30:00+02:00',
            merchant: 'Bookshop',
            amount: 18,
          },
          {
            id: 'expense-old',
            occurredAt: '2026-08-10T11:30:00+02:00',
            merchant: 'Old shop',
            amount: 99,
          },
        ],
        todayRows: [{ merchant: 'Bookshop', amount: 18 }],
        todayCount: 1,
        todayTotal: 18,
        latestMerchant: 'Bookshop',
      },
      relativeTime: {
        window: 'day',
        source: { stateKey: 'spendingRecords' },
        projectionStateKeys: ['todayRows', 'todayCount', 'todayTotal', 'latestMerchant'],
      },
    })

    await createSurface.handler(input, trustedContext)

    const created = SurfaceSchema.parse(store.getSurface('srf-daily-spending'))
    expect(created.spaceId).toBe(space.id)
    expect(created.validity).toEqual({
      kind: 'relative-time',
      timeZone: 'Europe/Rome',
      window: 'day',
      startsAt: '2026-08-10T22:00:00.000Z',
      expiresAt: '2026-08-11T22:00:00.000Z',
      source: { stateKey: 'spendingRecords', occurredAtKey: 'occurredAt' },
      projectionStateKeys: ['todayRows', 'todayCount', 'todayTotal', 'latestMerchant'],
    })
    expect(created.state['spendingRecords']).toEqual([
      {
        id: 'expense-1',
        occurredAt: '2026-08-11T09:30:00.000Z',
        merchant: 'Bookshop',
        amount: 18,
      },
      {
        id: 'expense-old',
        occurredAt: '2026-08-10T09:30:00.000Z',
        merchant: 'Old shop',
        amount: 99,
      },
    ])
    expect(created.state).toMatchObject({
      todayRows: [{ merchant: 'Bookshop', amount: 18 }],
      todayCount: 1,
      todayTotal: 18,
      latestMerchant: 'Bookshop',
    })
  })

  it('refreshes every declared projection across a local boundary while preserving source records', async () => {
    let now = new Date('2026-08-11T10:00:00.000Z')
    const { store, tools } = harness({ now: () => now })
    const createSurface = toolNamed(tools, 'create_surface')
    await createSurface.handler(
      createSurface.schema.parse({
        id: 'srf-relative-boundary',
        title: 'Daily activity',
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            { id: 'count', type: 'Stat', binding: 'todayCount', props: { label: 'Today' } },
            { id: 'latest', type: 'Stat', binding: 'latestItem', props: { label: 'Latest' } },
            { id: 'rows', type: 'Table', binding: 'todayRows', props: { columns: ['item'] } },
          ],
        },
        state: {
          records: [
            { id: 'first', occurredAt: '2026-08-11T09:00:00.000Z', item: 'Walk' },
            { id: 'legacy', item: 'Unknown date' },
          ],
          todayRows: [{ item: 'Walk' }],
          todayCount: 1,
          latestItem: 'Walk',
        },
        relativeTime: {
          window: 'day',
          source: { stateKey: 'records' },
          projectionStateKeys: ['todayRows', 'todayCount', 'latestItem'],
        },
      }),
      trustedContext,
    )

    now = new Date('2026-08-12T08:00:00.000Z')
    const listSurfaces = toolNamed(tools, 'list_surfaces')
    const expiredInventory = JSON.parse(
      (await listSurfaces.handler(listSurfaces.schema.parse({}), unusedContext)).content,
    ) as Array<Record<string, unknown>>
    expect(
      expiredInventory.find((surface) => surface['id'] === 'srf-relative-boundary'),
    ).toMatchObject({
      relativeTime: {
        status: 'expired',
        undatedRecords: 1,
        caveat:
          '1 source record has no occurrence date and is excluded from this relative-time view.',
      },
    })
    const readSurface = toolNamed(tools, 'read_surface')
    const expiredRead = JSON.parse(
      (
        await readSurface.handler(
          readSurface.schema.parse({ surfaceId: 'srf-relative-boundary' }),
          unusedContext,
        )
      ).content,
    ) as Record<string, unknown>
    expect(expiredRead['relativeTime']).toMatchObject({ status: 'expired', undatedRecords: 1 })

    const patchState = toolNamed(tools, 'patch_state')
    const result = await patchState.handler(
      patchState.schema.parse({
        surfaceId: 'srf-relative-boundary',
        operations: [
          {
            target: 'state',
            op: 'replace',
            path: '/records',
            value: [
              { id: 'second', occurredAt: '2026-08-12T09:30:00+02:00', item: 'Read' },
              { id: 'first', occurredAt: '2026-08-11T09:00:00.000Z', item: 'Walk' },
              { id: 'legacy', item: 'Unknown date' },
            ],
          },
          {
            target: 'state',
            op: 'replace',
            path: '/todayRows',
            value: [{ item: 'Read' }],
          },
          { target: 'state', op: 'replace', path: '/todayCount', value: 1 },
          { target: 'state', op: 'replace', path: '/latestItem', value: 'Read' },
        ],
      }),
      trustedContext,
    )

    const surface = SurfaceSchema.parse(store.getSurface('srf-relative-boundary'))
    expect(surface.state).toMatchObject({
      todayRows: [{ item: 'Read' }],
      todayCount: 1,
      latestItem: 'Read',
    })
    expect(surface.state['records']).toEqual([
      { id: 'second', occurredAt: '2026-08-12T07:30:00.000Z', item: 'Read' },
      { id: 'first', occurredAt: '2026-08-11T09:00:00.000Z', item: 'Walk' },
      { id: 'legacy', item: 'Unknown date' },
    ])
    expect(surface.validity).toMatchObject({
      startsAt: '2026-08-11T22:00:00.000Z',
      expiresAt: '2026-08-12T22:00:00.000Z',
    })
    expect(result.details).toMatchObject({ event: { validity: surface.validity } })
    expect(store.eventLog(surface.spaceId).at(-1)).toMatchObject({
      type: 'surface.patch_state',
      at: '2026-08-12T08:00:00.000Z',
    })

    const eventsBeforePartialPatch = store.eventLog(surface.spaceId)
    expect(() =>
      patchState.handler(
        patchState.schema.parse({
          surfaceId: surface.id,
          operations: [{ target: 'state', op: 'replace', path: '/todayCount', value: 2 }],
        }),
        trustedContext,
      ),
    ).toThrow('missing: todayRows, latestItem')
    expect(store.getSurface(surface.id)).toEqual(surface)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBeforePartialPatch)
  })
})
