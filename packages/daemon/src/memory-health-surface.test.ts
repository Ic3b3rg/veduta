import { SurfaceSchema } from '@veduta/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Store } from './store.ts'
import { formatFactsMarkdown } from './facts.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import { MEMORY_HEALTH_SURFACE_ID, MemoryHealthSurfaceManager } from './memory-health-surface.ts'

const timestamp = '2026-10-13T10:00:00.000Z'

describe('Memory health System Surface', () => {
  it('persists one validated canonical Surface with existing budget and assessments across restart', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-health-surface-'))
    const now = () => new Date(timestamp)
    const store = new Store({
      rootDir,
      now,
      seed: { spaces: [], surfaces: [] },
      memoryBudget: { low: 100, high: 200, hard: 300 },
    })
    ensureSystemSpace(store.spacesEngine)
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    store.spacesEngine.writeFact(space.id, 'Walking is part of my daily routine.')
    const manager = new MemoryHealthSurfaceManager({ store, now })
    try {
      manager.start()
      const surface = SurfaceSchema.parse(store.getSurface(MEMORY_HEALTH_SURFACE_ID))
      expect(surface).toMatchObject({
        spaceId: SYSTEM_SPACE_ID,
        title: 'Memory health',
        state: {
          low: 100,
          high: 200,
          hard: 300,
          lastSuccessfulAt: timestamp,
          spaces: [
            expect.objectContaining({
              space: 'Health',
              lifecycle: 'Active',
              activeUnits: store.spacesEngine.memoryHealth().spaces[space.id]!.activeSize,
              assessedAt: timestamp,
            }),
          ],
        },
      })
      expect(store.isSurfaceDaemonOwned(surface.id)).toBe(true)
      expect(store.eventLog(SYSTEM_SPACE_ID)).toContainEqual(
        expect.objectContaining({ type: 'surface.create' }),
      )
      manager.dispose()
      store.close()
      const reopened = new Store({ rootDir, now, seed: { spaces: [], surfaces: [] } })
      const restarted = new MemoryHealthSurfaceManager({ store: reopened, now })
      try {
        restarted.start()
        expect(
          reopened.listSurfaces(SYSTEM_SPACE_ID).filter((s) => s.id === MEMORY_HEALTH_SURFACE_ID),
        ).toHaveLength(1)
      } finally {
        restarted.dispose()
        reopened.close()
      }
    } finally {
      manager.dispose()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('updates document warnings at 2001 UTF-16 units independently and retains pinned live state', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-health-documents-'))
    const now = () => new Date(timestamp)
    const store = new Store({ rootDir, now, seed: { spaces: [], surfaces: [] } })
    ensureSystemSpace(store.spacesEngine)
    store.spacesEngine.createSpace({ name: 'Health', instructions: 'x'.repeat(2001) })
    writeFileSync(join(rootDir, 'USER.md'), ` \n${'😀'.repeat(1000)}\n `)
    const manager = new MemoryHealthSurfaceManager({ store, now })
    try {
      manager.start()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ document: 'USER', units: 2000, status: 'Within limit' }),
          expect.objectContaining({
            document: 'INSTRUCTIONS',
            scope: 'Health',
            units: 2001,
            status: 'Warning',
          }),
        ]),
      )
      writeFileSync(join(rootDir, 'spaces', 'system', 'INSTRUCTIONS.md'), 's'.repeat(2001))
      manager.refresh()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            document: 'INSTRUCTIONS',
            scope: 'System',
            units: 2001,
            status: 'Warning',
          }),
        ]),
      )
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.spaces).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ space: 'System' })]),
      )
      store.setPinned(MEMORY_HEALTH_SURFACE_ID, true, { origin: 'trusted:user', updatedBy: 'user' })
      writeFileSync(join(rootDir, 'USER.md'), '😀'.repeat(1000) + 'x')
      manager.refresh()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)).toMatchObject({
        pinned: true,
        state: {
          documents: expect.arrayContaining([
            expect.objectContaining({ document: 'USER', units: 2001, status: 'Warning' }),
          ]),
        },
      })
      expect(store.eventLog(SYSTEM_SPACE_ID)).toContainEqual(
        expect.objectContaining({ type: 'surface.patch_state' }),
      )
    } finally {
      manager.dispose()
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
  it('observes committed FACTS and Space lifecycle without turning health persistence failure into a failed write', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-health-observers-'))
    const store = new Store({
      rootDir,
      seed: { spaces: [], surfaces: [] },
      memoryBudget: { low: 30, high: 40, hard: 150 },
    })
    ensureSystemSpace(store.spacesEngine)
    const manager = new MemoryHealthSurfaceManager({ store })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      manager.start()
      const space = store.spacesEngine.createSpace({ name: 'Health' })
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.spaces).toEqual([
        expect.objectContaining({ space: 'Health', lifecycle: 'Active' }),
      ])
      rmSync(join(rootDir, 'memory-health.json'))
      mkdirSync(join(rootDir, 'memory-health.json'))
      expect(() =>
        store.spacesEngine.writeFact(
          space.id,
          'I walk every morning and evening to maintain my daily exercise routine.',
        ),
      ).not.toThrow()
      expect(store.spacesEngine.readFacts(space.id).active).toContainEqual(
        expect.objectContaining({
          text: 'I walk every morning and evening to maintain my daily exercise routine.',
        }),
      )
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.spaces).toEqual([
        expect.objectContaining({
          watermark: 'over-high',
          reflection: 'Pending',
          recovery: 'Not required',
        }),
      ])
      writeFileSync(
        join(rootDir, 'spaces', space.slug, 'FACTS.md'),
        formatFactsMarkdown(
          { active: [{ text: 'x'.repeat(200) }], dormant: [], superseded: [] },
          '2026-10-13',
        ),
      )
      store.spacesEngine.auditMemoryHealth(space.id)
      store.spacesEngine.archiveSpace(space.id)
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.spaces).toEqual([
        expect.objectContaining({ lifecycle: 'Archived' }),
      ])
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ document: 'INSTRUCTIONS', scope: 'Health' }),
        ]),
      )
      store.spacesEngine.restoreSpace(space.id)
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.spaces).toEqual([
        expect.objectContaining({ lifecycle: 'Active', recovery: 'Over hard — recovery required' }),
      ])
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
      manager.dispose()
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('retains the last valid assessment on source failure and recovers on an existing refresh', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-memory-health-source-'))
    const store = new Store({ rootDir, seed: { spaces: [], surfaces: [] } })
    ensureSystemSpace(store.spacesEngine)
    const manager = new MemoryHealthSurfaceManager({ store })
    try {
      manager.start()
      const before = store.getSurface(MEMORY_HEALTH_SURFACE_ID)!.state
      const unavailable = vi.spyOn(store.spacesEngine, 'readGlobalDocs').mockImplementation(() => {
        throw new Error('source unavailable')
      })
      manager.refresh()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state).toEqual({
        ...before,
        status: 'Stale — memory source unavailable; showing last valid assessment',
      })
      unavailable.mockRestore()
      manager.refresh()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.status).toBe('Current')
    } finally {
      vi.restoreAllMocks()
      manager.dispose()
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
