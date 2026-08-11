import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { Store } from './store.ts'
import {
  gateCreateSurfaceTool,
  templateTools,
  TemplateEngine,
  STABILITY_DAYS,
} from './template-engine.ts'
import { TurnTaintAccumulator, type Origin } from './taint.ts'

/**
 * `taint` always carries a real `TurnTaintAccumulator` seeded from `origin`
 * plus any `extraTaint`, mirroring `memory-tools.test.ts`'s `toolContext`:
 * this is what lets a fixture simulate a turn that started at `origin` but
 * grew tainted mid-turn without the runner itself in the loop.
 */
function toolContext(toolCallId: string, origin: Origin, extraTaint: Origin[] = []): ToolContext {
  const taint = new TurnTaintAccumulator([origin, ...extraTaint])
  return fromPartial<ToolContext>({ toolCallId, origin, origins: [origin], taint })
}

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

function daysLater(days: number): () => Date {
  return () => new Date(fixedNow().getTime() + days * 24 * 60 * 60 * 1000)
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-templates-'))
}

/** A small tracker composition: a title, a progress bar, and a checkbox bound to state. */
function trackerSurface(id: string, spaceId: string, options: { title?: string } = {}): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: options.title ?? 'Reading tracker',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: options.title ?? 'Reading tracker' } },
        { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
        {
          id: 'done',
          type: 'Checkbox',
          binding: 'finished',
          props: { label: 'Finished' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'finished' }],
        },
      ],
    },
    state: { progress: 0, finished: false },
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
  })
}

/**
 * The same tracker composition `trackerSurface` builds, but with the tree's
 * `Title` text held fixed regardless of the Surface's own `title`. This
 * decouples the tree shape from the
 * Surface title so two Surfaces can share an identical reduced tree —
 * `treeHash` equal — while still differing in `intent` (which defaults to
 * `title`, per `templateFromSurface`).
 */
function labeledTrackerSurface(id: string, spaceId: string, surfaceTitle: string): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: surfaceTitle,
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Tracker' } },
        { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
        {
          id: 'done',
          type: 'Checkbox',
          binding: 'finished',
          props: { label: 'Finished' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'finished' }],
        },
      ],
    },
    state: { progress: 0, finished: false },
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'agent' },
  })
}

function findTool(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool
}

describe('TemplateEngine', () => {
  describe('AC1 (issues/022-emergent-templates.md): reusing a tracker across Spaces', () => {
    it('pins a tracker in Space A, refuses a similar create_surface in Space B, then reuses the Template', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Space A' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Space B' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      store.createSurface(trackerSurface('srf-tracker-a', spaceA.id), 'agent')
      const { template } = engine.pin('srf-tracker-a', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!template) throw new Error('expected a Template to be saved on pin')
      expect(template.provenance.savedBy).toBe('pin')

      const gated = gateCreateSurfaceTool(findTool(store.surfaceTools(), 'create_surface'), engine)
      const candidate = trackerSurface('srf-tracker-b', spaceB.id)
      const refusal = await gated.handler(
        gated.schema.parse({
          id: candidate.id,
          spaceId: candidate.spaceId,
          title: candidate.title,
          tree: candidate.tree,
          state: candidate.state,
        }),
        toolContext('gate-refuse', 'trusted:user'),
      )

      expect(refusal.content).toContain(template.id)
      expect(refusal.content).toContain(spaceA.id)
      expect(refusal.content).toContain('create_surface_from_template')
      expect(refusal.content).toContain('justification')
      expect(store.getSurface('srf-tracker-b')).toBeUndefined()

      const tools = templateTools(engine, { activeSpaceId: spaceB.id })
      const createFromTemplate = findTool(tools, 'create_surface_from_template')
      const reused = await createFromTemplate.handler(
        createFromTemplate.schema.parse({
          templateId: template.id,
          templateSpaceId: spaceA.id,
          spaceId: spaceB.id,
          surfaceId: 'srf-tracker-b',
          state: { progress: 40, finished: false },
        }),
        toolContext('reuse', 'trusted:user'),
      )

      const created = store.getSurface('srf-tracker-b')
      if (!created) throw new Error('expected the reused Surface to exist')
      expect(created.tree).toEqual(template.tree)
      expect(created.state).toEqual({ progress: 40, finished: false })

      const provenance = store.surfaceProvenance('srf-tracker-b')
      expect(provenance?.templateId).toBe(template.id)
      // Ambiguous with `templateId` alone: a
      // Template id is only unique within its own Space, so provenance must
      // also record which Space this reused Template lives in.
      expect(provenance?.templateSpaceId).toBe(spaceA.id)

      const events = store.spacesEngine.readRecent(spaceB.id, 20)
      const reusedEvent = events.find((event) => event.type === 'template.reused')
      expect(reusedEvent?.payload).toMatchObject({
        templateId: template.id,
        sourceSpaceId: spaceA.id,
      })
      // `instantiate`'s `contentOrigin` fallback is `'trusted:user'`, not
      // `'trusted:system'`: an ordinary trusted reuse of a trusted Template
      // is an honest user-facing composition (docs/adr/0012-emergent-templates.md).
      expect(reused.origins).toEqual(['trusted:user'])
    })

    it('lets create_surface proceed with a justification and appends template.regenerated', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Space A' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Space B' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      store.createSurface(trackerSurface('srf-tracker-a2', spaceA.id), 'agent')
      const { template } = engine.pin('srf-tracker-a2', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!template) throw new Error('expected a Template to be saved on pin')

      const gated = gateCreateSurfaceTool(findTool(store.surfaceTools(), 'create_surface'), engine)
      const candidate = trackerSurface('srf-tracker-b2', spaceB.id)
      const result = await gated.handler(
        gated.schema.parse({
          id: candidate.id,
          spaceId: candidate.spaceId,
          title: candidate.title,
          tree: candidate.tree,
          state: candidate.state,
          justification: 'Space B needs its own tracker with a different layout later.',
        }),
        toolContext('gate-justified', 'trusted:user'),
      )

      expect(result.content).toContain(candidate.id)
      expect(store.getSurface('srf-tracker-b2')).toBeDefined()

      const events = store.spacesEngine.readRecent(spaceB.id, 20)
      const regenerated = events.find((event) => event.type === 'template.regenerated')
      expect(regenerated?.payload).toMatchObject({
        templateId: template.id,
        surfaceId: 'srf-tracker-b2',
        justification: 'Space B needs its own tracker with a different layout later.',
      })
    })

    it('delegates unchanged when nothing matches', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Lone Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })
      const gated = gateCreateSurfaceTool(findTool(store.surfaceTools(), 'create_surface'), engine)

      const candidate = trackerSurface('srf-lone', space.id, {
        title: 'Completely unrelated Surface',
      })
      const result = await gated.handler(
        gated.schema.parse({
          id: candidate.id,
          spaceId: candidate.spaceId,
          title: candidate.title,
          tree: candidate.tree,
          state: candidate.state,
        }),
        toolContext('gate-nomatch', 'trusted:user'),
      )

      expect(result.content).toContain(candidate.id)
      expect(store.getSurface('srf-lone')).toBeDefined()
    })
  })

  describe('harvest (issues/022-emergent-templates.md: stability harvest)', () => {
    it('templates a Surface stable for STABILITY_DAYS once, is a no-op on a second harvest, and skips daemon-owned and FACTS Surfaces', async () => {
      const rootDir = await tempRoot()
      const store = new Store({ rootDir, now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Harvest Space' })
      store.createSurface(trackerSurface('srf-harvest-1', space.id), 'agent')
      store.createSurface(
        trackerSurface('srf-harvest-daemon', space.id, { title: 'Daemon card' }),
        'job',
        {
          daemonOwned: true,
        },
      )

      const laterNow = daysLater(STABILITY_DAYS + 1)
      const laterStore = new Store({ rootDir, now: laterNow })
      const engine = new TemplateEngine({ store: laterStore, now: laterNow })

      const firstHarvest = engine.harvest()
      expect(firstHarvest).toHaveLength(1)
      expect(firstHarvest[0]?.provenance.sourceSurfaceId).toBe('srf-harvest-1')
      expect(firstHarvest[0]?.provenance.savedBy).toBe('stability')

      const secondHarvest = engine.harvest()
      expect(secondHarvest).toHaveLength(0)

      const templates = laterStore.spacesEngine.listTemplates(space.id)
      expect(templates).toHaveLength(1)
      expect(
        templates.some((template) => template.provenance.sourceSurfaceId === 'srf-harvest-daemon'),
      ).toBe(false)
      // The FACTS Surface is projected on every read (`Store.getSurface`),
      // never a persisted row `Store.stableSurfaces` can return, so it can
      // never appear as a Template's source regardless of how long it has
      // "existed".
      const factsSurface = store.getSurface(`srf-${space.slug}-facts`)
      expect(factsSurface?.pinnable).toBe(false)
      expect(
        templates.some((template) => template.provenance.sourceSurfaceId === factsSurface?.id),
      ).toBe(false)

      const events = laterStore.spacesEngine.readRecent(space.id, 20)
      expect(events.filter((event) => event.type === 'template.saved')).toHaveLength(1)
      expect(events.find((event) => event.type === 'template.saved')?.origin).toBe('trusted:system')
    })

    it('deduplicates by tree hash and intent together: identical trees with different intents both get Templates, but re-harvesting the same Surface stays a no-op', async () => {
      const rootDir = await tempRoot()
      const store = new Store({ rootDir, now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Dedup Space' })
      // Two Surfaces sharing the exact same reduced tree (a medication
      // tracker and an expense tracker built from the same layout) must not
      // collapse into a single Template just because their trees hash the
      // same — their intents genuinely differ.
      store.createSurface(
        labeledTrackerSurface('srf-dedup-meds', space.id, 'Medication tracker'),
        'agent',
      )
      store.createSurface(
        labeledTrackerSurface('srf-dedup-expenses', space.id, 'Expense tracker'),
        'agent',
      )

      const laterNow = daysLater(STABILITY_DAYS + 1)
      const laterStore = new Store({ rootDir, now: laterNow })
      const engine = new TemplateEngine({ store: laterStore, now: laterNow })

      const firstHarvest = engine.harvest()
      expect(firstHarvest).toHaveLength(2)
      expect(firstHarvest.map((template) => template.intent).sort()).toEqual([
        'Expense tracker',
        'Medication tracker',
      ])

      // The same Surface harvested twice (nothing changed in between) still
      // yields exactly one Template each, not a fresh duplicate per call.
      const secondHarvest = engine.harvest()
      expect(secondHarvest).toHaveLength(0)
      expect(laterStore.spacesEngine.listTemplates(space.id)).toHaveLength(2)
    })
  })

  describe('untrusted provenance (docs/SECURITY.md §3.2)', () => {
    it('instantiating an untrusted Template yields an untrusted contentOrigin, and re-deriving from that Surface stays untrusted', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Untrusted Source Space' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Untrusted Reuse Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      store.createSurface(trackerSurface('srf-untrusted-source', spaceA.id), 'agent', {
        contentOrigin: 'untrusted:hermes',
      })
      const { template } = engine.pin('srf-untrusted-source', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!template) throw new Error('expected a Template to be saved on pin')
      expect(template.provenance.origin).toBe('untrusted:hermes')

      const surface = engine.instantiate({
        templateId: template.id,
        templateSpaceId: spaceA.id,
        spaceId: spaceB.id,
        surfaceId: 'srf-untrusted-reused',
        origin: 'trusted:user',
      })

      expect(store.surfaceProvenance(surface.id)?.contentOrigin).toBe('untrusted:hermes')

      // A Template re-derived from this reused (but untrusted-content) Surface
      // cannot come back out trusted just because a trusted turn pinned it.
      const laterNow = daysLater(STABILITY_DAYS + 1)
      const laterStore = new Store({ rootDir: store.spacesEngine.rootDir, now: laterNow })
      const laterEngine = new TemplateEngine({ store: laterStore, now: laterNow })
      const rePin = laterEngine.pin('srf-untrusted-reused', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      expect(rePin.template?.provenance.origin).toBe('untrusted:hermes')
    })
  })

  describe('cross-Space match ordering', () => {
    it('ranks the given Space own Templates before those of other active Spaces', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Match Space A' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Match Space B' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      store.createSurface(trackerSurface('srf-match-a', spaceA.id), 'agent')
      store.createSurface(trackerSurface('srf-match-b', spaceB.id), 'agent')
      const { template: templateA } = engine.pin('srf-match-a', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      const { template: templateB } = engine.pin('srf-match-b', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!templateA || !templateB) throw new Error('expected both pins to save a Template')

      const matches = engine.match({ intent: 'Reading tracker' }, spaceB.id)
      expect(matches[0]?.spaceId).toBe(spaceB.id)
      expect(matches.map((match) => match.spaceId)).toContain(spaceA.id)
    })
  })

  describe('tools report origins and derive writes from live taint', () => {
    it('list_templates reports the origin of every Template it surfaces', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Origins Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })
      store.createSurface(trackerSurface('srf-origins-1', space.id), 'agent', {
        contentOrigin: 'untrusted:hermes',
      })
      engine.pin('srf-origins-1', true, { origin: 'trusted:user', updatedBy: 'user' })

      const tools = templateTools(engine, { activeSpaceId: space.id })
      const listTemplates = findTool(tools, 'list_templates')
      const result = await listTemplates.handler(
        listTemplates.schema.parse({}),
        toolContext('list', 'trusted:user'),
      )

      expect(result.origins).toEqual(['untrusted:hermes'])
    })

    it("create_surface_from_template's write derives its Space Event origin from the live taint accumulator, not context.origin alone", async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Taint Source Space' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Taint Reuse Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })
      store.createSurface(trackerSurface('srf-taint-a', spaceA.id), 'agent')
      const { template } = engine.pin('srf-taint-a', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!template) throw new Error('expected a Template to be saved on pin')

      const tools = templateTools(engine, { activeSpaceId: spaceB.id })
      const createFromTemplate = findTool(tools, 'create_surface_from_template')
      // The turn started trusted but picked up untrusted taint mid-turn (e.g.
      // via a prior search_memory hit) before calling this tool.
      await createFromTemplate.handler(
        createFromTemplate.schema.parse({
          templateId: template.id,
          templateSpaceId: spaceA.id,
          spaceId: spaceB.id,
          surfaceId: 'srf-taint-b',
        }),
        toolContext('taint-reuse', 'trusted:user', ['untrusted:gmail']),
      )

      const events = store.spacesEngine.readRecent(spaceB.id, 20)
      const reusedEvent = events.find((event) => event.type === 'template.reused')
      expect(reusedEvent?.origin).toBe('untrusted:gmail')
    })

    it('pin_surface reports the origin of the newly saved Template', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Pin Tool Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })
      store.createSurface(trackerSurface('srf-pin-tool', space.id), 'agent', {
        contentOrigin: 'untrusted:hermes',
      })

      const tools = templateTools(engine, { activeSpaceId: space.id })
      const pinSurface = findTool(tools, 'pin_surface')
      const result = await pinSurface.handler(
        pinSurface.schema.parse({ surfaceId: 'srf-pin-tool', pinned: true }),
        toolContext('pin-tool', 'trusted:user'),
      )

      expect(result.origins).toEqual(['untrusted:hermes'])
    })
  })

  describe('pin_surface only ever pins (docs/adr/0012-emergent-templates.md: unpinning is a human act)', () => {
    it('rejects a tool call with pinned: false at the schema, before the handler ever runs', async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Pin Schema Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })
      const tools = templateTools(engine, { activeSpaceId: space.id })
      const pinSurface = findTool(tools, 'pin_surface')

      expect(() => pinSurface.schema.parse({ surfaceId: 'srf-any', pinned: false })).toThrow()
    })
  })

  describe("Template bookkeeping events carry the Template's own origin, neutralized and truncated (docs/SECURITY.md §3.2)", () => {
    it("template.saved and template.reused both carry an untrusted Template's origin, with the interpolated name/title neutralized and bounded", async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const spaceA = store.spacesEngine.createSpace({ name: 'Injection Source Space' })
      const spaceB = store.spacesEngine.createSpace({ name: 'Injection Reuse Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      const injectedTitle = `<<<INJECT>>> ${'x'.repeat(400)}`
      store.createSurface(
        trackerSurface('srf-injected', spaceA.id, { title: injectedTitle }),
        'agent',
        {
          contentOrigin: 'untrusted:hermes',
        },
      )
      const { template } = engine.pin('srf-injected', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      if (!template) throw new Error('expected a Template to be saved on pin')

      const savedEvent = store.spacesEngine
        .readRecent(spaceA.id, 20)
        .find((event) => event.type === 'template.saved')
      expect(savedEvent?.origin).toBe('untrusted:hermes')
      expect(savedEvent?.text).not.toContain('<<<INJECT>>>')
      expect(savedEvent?.text).not.toContain('x'.repeat(300))
      expect(savedEvent?.text).toContain('…')

      engine.instantiate({
        templateId: template.id,
        templateSpaceId: spaceA.id,
        spaceId: spaceB.id,
        surfaceId: 'srf-injected-reused',
        origin: 'trusted:user',
      })

      const reusedEvent = store.spacesEngine
        .readRecent(spaceB.id, 20)
        .find((event) => event.type === 'template.reused')
      expect(reusedEvent?.origin).toBe('untrusted:hermes')
      expect(reusedEvent?.text).not.toContain('<<<INJECT>>>')
      expect(reusedEvent?.text).not.toContain('x'.repeat(300))
      expect(reusedEvent?.text).toContain('…')
    })
  })

  describe('list_templates renders an untrusted Template inside the untrusted envelope (docs/SECURITY.md §3.2)', () => {
    it("wraps an imported Template's fields in untrustedDataBlock, leaving a local Template's fields unwrapped", async () => {
      const store = new Store({ rootDir: await tempRoot(), now: fixedNow })
      const space = store.spacesEngine.createSpace({ name: 'Mixed Templates Space' })
      const engine = new TemplateEngine({ store, now: fixedNow })

      store.createSurface(
        trackerSurface('srf-local', space.id, { title: 'Local tracker' }),
        'agent',
      )
      engine.pin('srf-local', true, { origin: 'trusted:user', updatedBy: 'user' })

      store.createSurface(
        trackerSurface('srf-imported', space.id, { title: 'Imported tracker' }),
        'agent',
        { contentOrigin: 'untrusted:hermes' },
      )
      engine.pin('srf-imported', true, { origin: 'trusted:user', updatedBy: 'user' })

      const tools = templateTools(engine, { activeSpaceId: space.id })
      const listTemplates = findTool(tools, 'list_templates')
      const result = await listTemplates.handler(
        listTemplates.schema.parse({}),
        toolContext('list-mixed', 'trusted:user'),
      )

      const untrustedStart = result.content.indexOf('<<<UNTRUSTED data from hermes>>>')
      const untrustedEnd = result.content.indexOf('<<<END data>>>')
      expect(untrustedStart).toBeGreaterThanOrEqual(0)
      expect(result.content.slice(untrustedStart, untrustedEnd)).toContain('Imported tracker')

      const localNameIndex = result.content.indexOf('Local tracker')
      expect(localNameIndex).toBeGreaterThanOrEqual(0)
      expect(localNameIndex < untrustedStart || localNameIndex > untrustedEnd).toBe(true)
    })
  })
})
