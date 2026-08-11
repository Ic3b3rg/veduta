import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'
import { piToolParameters } from './tool-parameters.ts'

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-focused-surface-tools-'))
  createdDirs.push(rootDir)
  const store = new Store({ rootDir, now: () => new Date('2026-08-11T10:00:00.000Z') })
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
      ['id', 'title', 'tree', 'state', 'intent', 'justification'].sort(),
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
      trustedContext,
    )
    expect(refusal.content).toContain(template.id)
    expect(refusal.content).toContain(space.id)
    expect(store.getSurface(candidate.id)).toBeUndefined()

    await createSurface.handler(
      createSurface.schema.parse({
        ...candidate,
        justification: 'This Surface needs an independently evolving composition.',
      }),
      trustedContext,
    )
    expect(store.getSurface(candidate.id)).toMatchObject({ spaceId: space.id })
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
})
