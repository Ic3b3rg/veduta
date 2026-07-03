import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { Store } from './store.ts'

describe('SpacesEngine layout and lifecycle', () => {
  it('creates the file-backed Space layout with global USER and SOUL files', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    expect(existsSync(join(rootDir, 'USER.md'))).toBe(true)
    expect(readFileSync(join(rootDir, 'SOUL.md'), 'utf8')).toContain("say you don't know")
    expect(existsSync(join(rootDir, 'spaces', space.slug, 'FACTS.md'))).toBe(true)
    expect(existsSync(join(rootDir, 'spaces', space.slug, 'INSTRUCTIONS.md'))).toBe(true)
    expect(existsSync(join(rootDir, 'spaces', space.slug, 'log'))).toBe(true)
    expect(existsSync(join(rootDir, 'spaces', space.slug, 'surfaces'))).toBe(true)
  })

  it('archives without deleting memory and restores it to the Home snapshot', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow, seed: seedSpaces() })

    engine.writeFact('spc-health', 'I like oats')
    engine.archiveSpace('spc-health')

    expect(engine.listSpaces().map((space) => space.slug)).toEqual([])
    expect(engine.readFacts('spc-health').active.map((fact) => fact.text)).toEqual(['I like oats'])

    engine.restoreSpace('spc-health')

    expect(engine.listSpaces().map((space) => space.slug)).toEqual(['health'])
    expect(engine.searchFacts('spc-health', 'oats').map((fact) => fact.text)).toEqual([
      'I like oats',
    ])
  })

  it('creates a Space only after a proposal is confirmed', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })

    const proposal = engine.proposeSpace({
      name: 'Home',
      reason: 'User asked to track household routines.',
    })

    expect(engine.listSpaces()).toEqual([])

    const space = engine.confirmSpaceProposal(proposal.id)

    expect(space).toMatchObject({ slug: 'home', name: 'Home', archived: false })
    expect(engine.listSpaces().map((created) => created.slug)).toEqual(['home'])
    expect(engine.searchLog(space.id, 'Confirmed Space proposal')).toHaveLength(1)
  })

  it('merges two Spaces and archives the source Space without deleting it', async () => {
    const rootDir = await tempRoot()
    let now = new Date('2026-07-01T12:00:00.000Z')
    const engine = new SpacesEngine({ rootDir, now: () => now })
    const health = engine.createSpace({ name: 'Health' })
    const food = engine.createSpace({ name: 'Food' })

    engine.writeFact(food.id, 'I like barley')
    engine.saveSurface(sharedSurface(health.id, 'Target shared'))
    engine.saveSurface(sharedSurface(food.id, 'Source shared'))
    now = new Date('2026-07-03T12:00:00.000Z')

    engine.mergeSpaces(health.id, food.id)

    expect(engine.searchFacts(health.id, 'barley')).toEqual([
      { text: 'I like barley', noted: '2026-07-01' },
    ])
    expect(
      engine
        .listPersistedSurfaces(health.id)
        .map((surface) => surface.id)
        .sort(),
    ).toEqual(['srf-shared', 'srf-shared-from-food'])
    expect(engine.getSpace(food.id)?.archived).toBe(true)
    expect(existsSync(join(rootDir, 'spaces', food.slug, 'FACTS.md'))).toBe(true)
  })
})

describe('Store memory contract', () => {
  it('puts fast-path events into the next active Space context', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })

    store.applyFastAction('srf-groceries', 'milk', true)

    const context = store.assembleSpaceContext('spc-health')
    expect(context).toContain('SOUL')
    expect(context.match(/^# SOUL$/gm)).toHaveLength(1)
    expect(context).toContain('Groceries: milk -> true')
  })

  it('assembles an abstention context for absent facts', async () => {
    const store = new Store({ rootDir: await tempRoot(), now: fixedNow })

    const context = store.assembleSpaceContext('spc-health')

    expect(context).toContain("say you don't know")
    expect(context.toLowerCase()).not.toContain('celery')
  })
})

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-spaces-'))
}

function sharedSurface(spaceId: string, title: string): Surface {
  return SurfaceSchema.parse({
    id: 'srf-shared',
    spaceId,
    title,
    tree: {
      id: 'root',
      type: 'Box',
      children: [{ id: 'title', type: 'Title', props: { text: title } }],
    },
    state: {},
    freshness: { updatedAt: '2026-07-01T12:00:00.000Z', updatedBy: 'seed' },
  })
}
