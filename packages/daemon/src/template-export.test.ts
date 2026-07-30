import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, SurfaceTemplateSchema, type SurfaceTemplate } from '@veduta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { SpacesEngine } from './spaces-engine.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import {
  TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES,
  TemplateImportRefusal,
  applyTemplateImport,
  exportTemplates,
  planTemplateImport,
  type TemplateImportPlan,
} from './template-export.ts'
import { TEMPLATE_IMPORT_MAX_DEPTH } from './templates.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-template-export-'))
}

function fixedNow(): Date {
  return new Date('2026-07-15T00:00:00.000Z')
}

function sampleTemplate(id: string): SurfaceTemplate {
  return SurfaceTemplateSchema.parse({
    formatVersion: 1,
    id,
    name: 'Tracker',
    intent: 'daily tracker',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Tracker' } },
        {
          id: 'done',
          type: 'Checkbox',
          binding: 'done',
          props: { label: 'Done today' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'done' }],
        },
      ],
    },
    stateKeys: ['done'],
    dataProps: [],
    provenance: {
      sourceSurfaceId: 'srf-tracker',
      sourceSpaceId: 'spc-health',
      savedAt: '2026-07-01T00:00:00.000Z',
      savedBy: 'stability',
      origin: 'trusted:user',
    },
  })
}

function bundleOf(templates: unknown[]): unknown {
  return { formatVersion: 1, exportedAt: '2026-07-01T00:00:00.000Z', templates }
}

function validRawTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'tpl-imported',
    name: 'Imported',
    intent: 'imported composition',
    tree: { id: 'root', type: 'Box' },
    stateKeys: [],
    dataProps: [],
    provenance: {
      sourceSurfaceId: 'srf-remote',
      sourceSpaceId: 'spc-remote',
      savedAt: '2026-07-01T00:00:00.000Z',
      savedBy: 'stability',
      origin: 'trusted:user',
    },
    ...overrides,
  }
}

/** A single-child chain `depth` levels deep, built iteratively. */
function chainTree(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { id: `n${depth}`, type: 'Box' }
  for (let level = depth - 1; level >= 0; level -= 1) {
    node = { id: `n${level}`, type: 'Box', children: [node] }
  }
  return node
}

describe('exportTemplates', () => {
  it('exports every Template of a single Space, sorted by id', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })
    engine.saveTemplate(space.id, sampleTemplate('tpl-b'))
    engine.saveTemplate(space.id, sampleTemplate('tpl-a'))

    const bundle = exportTemplates(engine, space.id)

    expect(bundle.formatVersion).toBe(1)
    expect(bundle.templates.map((template) => template.id)).toEqual(['tpl-a', 'tpl-b'])
  })

  it('refuses to export an unknown Space (there is no "every Space" mode: Templates are Space-owned)', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })

    // A Template id is unique only within its owning Space, so flattening
    // every active Space into one bundle could produce two entries sharing
    // an id — a bundle `planTemplateImport` refuses outright
    // (`assertNoDuplicateIds`). `exportTemplates` therefore always requires
    // a Space, exactly like `import` already requires `--space`.
    expect(() => exportTemplates(engine, 'spc-unknown')).toThrow(/unknown Space/)
  })

  it('is deterministic: two exports of the same state are byte-identical apart from exportedAt', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })
    engine.saveTemplate(space.id, sampleTemplate('tpl-b'))
    engine.saveTemplate(space.id, sampleTemplate('tpl-a'))

    const first = exportTemplates(engine, space.id)
    const second = exportTemplates(engine, space.id)

    expect(JSON.stringify(first.templates)).toBe(JSON.stringify(second.templates))
  })
})

describe('planTemplateImport / applyTemplateImport', () => {
  it("exports from root A, imports into root B, and instantiating through TemplateEngine there carries B's own data — not A's — while a dropped dataProp is never silently restored", async () => {
    // The live path end to end (issues/022-emergent-templates.md's third
    // acceptance criterion): a pure-helper round trip would still pass even
    // if the reuse path itself were deleted, so this goes through
    // `SpacesEngine`/`Store`/`TemplateEngine` exactly as the daemon does,
    // across two independent installations (`rootA`/`rootB`), and exercises
    // a Template carrying `dataProps` — a `Table.rows`-shaped prop dropped
    // at derivation — which the reuse path must not silently reintroduce.
    const rootA = await tempRoot()
    const storeA = new Store({ rootDir: rootA, now: fixedNow })
    const spaceA = storeA.spacesEngine.createSpace({ name: 'Health' })
    const engineA = new TemplateEngine({ store: storeA, now: fixedNow })

    const surfaceA = SurfaceSchema.parse({
      id: 'srf-a-tracker',
      spaceId: spaceA.id,
      title: 'Workout tracker',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'title', type: 'Title', props: { text: 'Workout tracker' } },
          { id: 'log', type: 'Table', props: { rows: [{ day: 'Mon', reps: 10 }] } },
          {
            id: 'done',
            type: 'Checkbox',
            binding: 'finished',
            props: { label: 'Finished' },
            actions: [{ name: 'toggle', path: 'fast', stateKey: 'finished' }],
          },
        ],
      },
      state: { finished: false },
      freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
    })
    storeA.createSurface(surfaceA, 'agent')

    const { template } = engineA.pin('srf-a-tracker', true, {
      origin: 'trusted:user',
      updatedBy: 'user',
    })
    if (!template) throw new Error('expected a Template to be saved on pin')
    // The Table's rows never travel with the Template's tree: derivation
    // drops any array/object-valued prop and records where, instead.
    expect(template.tree.children?.find((node) => node.id === 'log')?.props?.rows).toBeUndefined()
    expect(template.dataProps).toEqual(['log.rows'])

    const bundle = exportTemplates(storeA.spacesEngine, spaceA.id)
    // Round-trips through JSON exactly as a file on disk would.
    const raw = JSON.parse(JSON.stringify(bundle))

    const rootB = await tempRoot()
    const storeB = new Store({ rootDir: rootB, now: fixedNow })
    const spaceB = storeB.spacesEngine.createSpace({ name: 'Fitness' })
    const engineB = new TemplateEngine({ store: storeB, now: fixedNow })

    const plan = planTemplateImport(storeB.spacesEngine, spaceB.id, raw, 'installation-a')
    expect(plan.collisions).toEqual([])
    const result = applyTemplateImport(storeB.spacesEngine, plan)
    expect(result.imported).toEqual([template.id])

    const importedTemplate = storeB.spacesEngine.getTemplate(spaceB.id, template.id)
    if (!importedTemplate) throw new Error('expected the imported Template to be readable')
    expect(importedTemplate.tree).toEqual(template.tree)
    expect(importedTemplate.dataProps).toEqual(template.dataProps)

    const instantiated = engineB.instantiate({
      templateId: template.id,
      templateSpaceId: spaceB.id,
      spaceId: spaceB.id,
      surfaceId: 'srf-b-tracker',
      state: { finished: true },
      origin: 'trusted:user',
    })

    // The tree lands verbatim, from the imported Template, not from Space A.
    expect(instantiated.tree).toEqual(importedTemplate.tree)
    // The state holds B's own supplied values, never A's.
    expect(instantiated.state).toEqual({ finished: true })
    // The reuse is recorded against the imported Template.
    expect(storeB.surfaceProvenance(instantiated.id)?.templateId).toBe(template.id)
    // What the reuse path does *not* carry: a `dataProps` entry only ever
    // records that a prop existed and was dropped — instantiating a
    // Template never reintroduces it. Restoring `log.rows` would require a
    // separate, explicit data-patching step, not something `instantiate`
    // (or `create_surface_from_template`) does on its own.
    const log = instantiated.tree.children?.find((node) => node.id === 'log')
    expect(log?.props?.rows).toBeUndefined()
  })

  it('refuses on a colliding id, writes nothing, and names the exact rm command', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })
    engine.saveTemplate(space.id, sampleTemplate('tpl-tracker'))

    const raw = JSON.parse(JSON.stringify(exportTemplates(engine, space.id)))
    const plan = planTemplateImport(engine, space.id, raw, 'installation-a')
    expect(plan.collisions).toEqual(['tpl-tracker'])

    let caught: unknown
    try {
      applyTemplateImport(engine, plan)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(TemplateImportRefusal)
    const refusal = caught as TemplateImportRefusal
    expect(refusal.collisions).toEqual(['tpl-tracker'])
    expect(refusal.message).toContain('tpl-tracker.json')
    expect(refusal.message).toMatch(/rm '.*tpl-tracker\.json'/)

    // No lock was ever created — the plan-level check refuses before the lock is acquired.
    expect(existsSync(join(rootDir, 'spaces', space.slug, 'templates.import.lock'))).toBe(false)
  })

  it('rolls back the first Template written when a later one in the same bundle fails to write', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const plan: TemplateImportPlan = {
      spaceId: space.id,
      source: 'installation-a',
      templates: [sampleTemplate('tpl-a'), sampleTemplate('tpl-b')],
      collisions: [],
      strippedAgentActions: 0,
      previewLines: [],
    }

    const original = engine.saveTemplate.bind(engine)
    let calls = 0
    vi.spyOn(engine, 'saveTemplate').mockImplementation((spaceId, template) => {
      calls += 1
      if (calls === 2) throw new Error('simulated write failure')
      return original(spaceId, template)
    })

    expect(() => applyTemplateImport(engine, plan)).toThrow(/simulated write failure/)
    expect(engine.getTemplate(space.id, 'tpl-a')).toBeUndefined()
    expect(engine.getTemplate(space.id, 'tpl-b')).toBeUndefined()
  })

  it('refuses instead of overwriting when a Template file appears after the live collision re-check but before the write', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const plan: TemplateImportPlan = {
      spaceId: space.id,
      source: 'installation-a',
      templates: [{ ...sampleTemplate('tpl-race'), name: 'Imported content' }],
      collisions: [],
      strippedAgentActions: 0,
      previewLines: [],
    }

    // Writes for real, before the race is staged — this is the file that
    // "appears" in the window `applyTemplateImport`'s own live re-check
    // (`checkCollisions`, via `getTemplate`) cannot see because that check
    // already ran (and lied "clean") by the time this landed.
    const raceWinner = { ...sampleTemplate('tpl-race'), name: 'Concurrent write' }
    engine.saveTemplate(space.id, raceWinner)

    // Simulates the exact race the exclusive write guards against: the
    // live re-check reports no collision (as if it had run *before* the
    // write above), while the file already sits on disk — the same gap a
    // real concurrent pin or harvest (never another import; the lock only
    // ever excludes a second import) would land in.
    const original = engine.getTemplate.bind(engine)
    vi.spyOn(engine, 'getTemplate')
      .mockReturnValueOnce(undefined)
      .mockImplementation((spaceId, templateId) => original(spaceId, templateId))

    expect(() => applyTemplateImport(engine, plan)).toThrow(/EEXIST|already exists/i)

    // The concurrent writer's own content survives untouched: no overwrite,
    // and nothing of this import's own landed to roll back.
    expect(engine.getTemplate(space.id, 'tpl-race')?.name).toBe('Concurrent write')
  })

  it('when a later Template in the bundle collides with a file that appeared mid-import, rollback removes only what this import wrote and leaves the colliding file untouched', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const plan: TemplateImportPlan = {
      spaceId: space.id,
      source: 'installation-a',
      templates: [
        { ...sampleTemplate('tpl-a'), name: 'Imported a' },
        { ...sampleTemplate('tpl-b'), name: 'Imported b' },
      ],
      collisions: [],
      strippedAgentActions: 0,
      previewLines: [],
    }

    // tpl-b "appears" — written for real — after the live re-check would
    // have looked at it.
    const concurrentWinner = { ...sampleTemplate('tpl-b'), name: 'Concurrent write' }
    engine.saveTemplate(space.id, concurrentWinner)

    // The live re-check's first call (tpl-a) reports the truth (genuinely
    // absent); its second call (tpl-b) lies "clean", simulating a check that
    // ran just before `concurrentWinner` landed. Every call after that
    // reverts to the truth, so later assertions in this test see reality.
    const original = engine.getTemplate.bind(engine)
    vi.spyOn(engine, 'getTemplate')
      .mockImplementationOnce((spaceId, templateId) => original(spaceId, templateId))
      .mockReturnValueOnce(undefined)
      .mockImplementation((spaceId, templateId) => original(spaceId, templateId))

    expect(() => applyTemplateImport(engine, plan)).toThrow(/EEXIST|already exists/i)

    // tpl-a is this import's own write: rolled back.
    expect(engine.getTemplate(space.id, 'tpl-a')).toBeUndefined()
    // tpl-b was never this import's write to begin with — because the
    // write is exclusive, it never entered `imported` in the first place,
    // so rollback never touches it. The concurrent writer's content
    // survives both the (refused) overwrite and the rollback delete.
    expect(engine.getTemplate(space.id, 'tpl-b')?.name).toBe('Concurrent write')
  })

  it('refuses a bundle whose Template tree contains an unknown Atom type', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate({ tree: { id: 'root', type: 'NotARealAtom' } })])

    expect(() => planTemplateImport(engine, space.id, raw, 'installation-a')).toThrow()
  })

  it('refuses a bundle whose Template tree exceeds the import size caps', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate({ tree: chainTree(TEMPLATE_IMPORT_MAX_DEPTH + 10) })])

    expect(() => planTemplateImport(engine, space.id, raw, 'installation-a')).toThrow(
      new RegExp(String(TEMPLATE_IMPORT_MAX_DEPTH)),
    )
  })

  it('refuses a bundle whose Template id is shaped like a path traversal', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate({ id: '../../etc/passwd' })])

    expect(() => planTemplateImport(engine, space.id, raw, 'installation-a')).toThrow()
  })

  it('strips an agent-path action from a Template tree instead of refusing the whole bundle', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([
      validRawTemplate({
        tree: {
          id: 'root',
          type: 'Checkbox',
          binding: 'done',
          actions: [
            { name: 'speak-to-agent', path: 'agent' },
            { name: 'toggle', path: 'fast', stateKey: 'done' },
          ],
        },
        stateKeys: ['done'],
      }),
    ])

    const plan = planTemplateImport(engine, space.id, raw, 'installation-a')

    expect(plan.strippedAgentActions).toBe(1)
    expect(plan.templates[0]?.tree.actions).toEqual([
      { name: 'toggle', path: 'fast', stateKey: 'done', payload: {} },
    ])
  })

  it('appends a template.imported event carrying the untrusted origin of the import source', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate()])
    const plan = planTemplateImport(engine, space.id, raw, 'gmail')
    applyTemplateImport(engine, plan)

    const events = engine.readRecent(space.id, 50)
    const importedEvent = events.find((event) => event.type === 'template.imported')

    expect(importedEvent?.origin).toBe('untrusted:gmail')
    expect(importedEvent?.payload).toEqual({ templateId: 'tpl-imported' })
  })

  it("lists every surviving prop value in the preview, alongside the Template's dataProps", async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([
      validRawTemplate({
        name: 'Groceries',
        dataProps: ['log.rows'],
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            { id: 'title', type: 'Title', props: { text: 'Groceries' } },
            { id: 'count', type: 'Stat', props: { value: 3 } },
          ],
        },
      }),
    ])

    const plan = planTemplateImport(engine, space.id, raw, 'installation-a')

    expect(plan.previewLines.some((line) => line.includes('title.text = Groceries'))).toBe(true)
    expect(plan.previewLines.some((line) => line.includes('count.value = 3'))).toBe(true)
    expect(plan.previewLines.some((line) => line.includes('dataProps: log.rows'))).toBe(true)
  })

  it('imports a bundle with <<< in a binding end to end, instead of refusing with an opaque schema error', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([
      validRawTemplate({
        tree: { id: 'root', type: 'Checkbox', binding: 'done<<<injected' },
        stateKeys: ['done<<<injected'],
      }),
    ])

    const plan = planTemplateImport(engine, space.id, raw, 'installation-a')
    expect(plan.templates[0]?.tree.binding).not.toContain('<<<')

    const result = applyTemplateImport(engine, plan)
    expect(result.imported).toEqual(['tpl-imported'])
    const stored = engine.getTemplate(space.id, 'tpl-imported')
    expect(stored?.tree.binding).not.toContain('<<<')
    expect(stored?.stateKeys).toEqual([stored?.tree.binding])
  })

  it('refuses a bundle containing two Templates with the same id, naming the id', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate({ id: 'tpl-dup' }), validRawTemplate({ id: 'tpl-dup' })])

    expect(() => planTemplateImport(engine, space.id, raw, 'installation-a')).toThrow(/tpl-dup/)
  })

  it('refuses a bundle whose "templates" array exceeds the entry cap', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const templates = Array.from({ length: TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES + 1 }, () => ({
      placeholder: true,
    }))
    const raw = bundleOf(templates)

    expect(() => planTemplateImport(engine, space.id, raw, 'installation-a')).toThrow(
      new RegExp(String(TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES)),
    )
  })

  it('rolls back every written Template when appendEvent throws after every file already landed', async () => {
    const rootDir = await tempRoot()
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const space = engine.createSpace({ name: 'Health' })

    const raw = bundleOf([validRawTemplate({ id: 'tpl-a' }), validRawTemplate({ id: 'tpl-b' })])
    const plan = planTemplateImport(engine, space.id, raw, 'installation-a')

    // Installed only now, after the plan (and the Space-creation lifecycle
    // event) already ran their own appendEvent calls.
    vi.spyOn(engine, 'appendEvent').mockImplementation(() => {
      throw new Error('simulated event-append failure')
    })

    expect(() => applyTemplateImport(engine, plan)).toThrow(/simulated event-append failure/)
    expect(engine.getTemplate(space.id, 'tpl-a')).toBeUndefined()
    expect(engine.getTemplate(space.id, 'tpl-b')).toBeUndefined()
  })
})
