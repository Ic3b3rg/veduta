import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watch } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SurfaceSnapshotSchema } from '@veduta/protocol'
import { buildServer } from './server.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'
import { MEMORY_HEALTH_SURFACE_ID, MemoryHealthSurfaceManager } from './memory-health-surface.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-document-observation-'))
  const store = new Store({ rootDir: root, seed: { spaces: [], surfaces: [] } })
  ensureSystemSpace(store.spacesEngine)
  store.spacesEngine.createSpace({ name: 'Health' })
  const manager = new MemoryHealthSurfaceManager({ store })
  manager.start()
  return {
    root,
    store,
    manager,
    close() {
      manager.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const cases = [
  { file: 'USER.md', document: 'USER', scope: 'Global' },
  { file: 'SOUL.md', document: 'SOUL', scope: 'Global' },
  { file: 'spaces/health/INSTRUCTIONS.md', document: 'INSTRUCTIONS', scope: 'Health' },
  { file: 'spaces/system/INSTRUCTIONS.md', document: 'INSTRUCTIONS', scope: 'System' },
]

describe('Memory health document observation without Heartbeat', () => {
  it.each(cases)(
    'keeps public Store.snapshot pure after an isolated $file edit before lifecycle callbacks',
    ({ file }) => {
      const { root, store, close } = fixture()
      const before = store.getSurface(MEMORY_HEALTH_SURFACE_ID)
      const cursor = store.latestSurfaceCursor()
      const events = store.eventLog('spc-system')
      const delivered = vi.fn()
      const dispose = store.onSurfaceEvent(delivered)
      try {
        writeFileSync(join(root, file), 'x'.repeat(2001))
        const surface = store
          .snapshot()
          .spaces.flatMap((space) => space.surfaces)
          .find((item) => item.id === MEMORY_HEALTH_SURFACE_ID)
        expect(surface).toEqual(before)
        expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)).toEqual(before)
        expect(store.latestSurfaceCursor()).toBe(cursor)
        expect(store.eventLog('spc-system')).toEqual(events)
        expect(delivered).not.toHaveBeenCalled()
        expect(readFileSync(join(root, file), 'utf8')).toBe('x'.repeat(2001))
      } finally {
        dispose()
        close()
      }
    },
  )

  it.each(cases)(
    'publishes isolated $file edits and repeated atomic replacements while idle',
    async ({ file, document, scope }) => {
      const { root, store, close } = fixture()
      try {
        for (const units of [2001, 2000, 2002]) {
          const path = join(root, file)
          writeFileSync(`${path}.replacement`, 'x'.repeat(units))
          renameSync(`${path}.replacement`, path)
          await vi.waitFor(
            () => {
              expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    document,
                    scope,
                    units,
                    status: units > 2000 ? 'Warning' : 'Within limit',
                  }),
                ]),
              )
            },
            { timeout: 2000 },
          )
        }
      } finally {
        close()
      }
    },
  )
  it('contains watcher failures, retries observation through the lifecycle fallback, and releases it on disposal/restart', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { root, store, manager, close } = fixture()
    try {
      const firstWatch = [...vi.mocked(watch).mock.results]
        .reverse()
        .find((result) => result.type === 'return')?.value
      expect(firstWatch).toBeDefined()
      if (!firstWatch) throw new Error('expected active document watcher')
      firstWatch.emit('error', new Error('watch unavailable'))
      writeFileSync(join(root, 'spaces/health/INSTRUCTIONS.md'), 'x'.repeat(2001))
      await vi.waitFor(
        () =>
          expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
            expect.arrayContaining([expect.objectContaining({ scope: 'Health', units: 2001 })]),
          ),
        { timeout: 2500 },
      )
      expect(logged).toHaveBeenCalled()
      manager.dispose()
      const cursor = store.latestSurfaceCursor()
      writeFileSync(join(root, 'USER.md'), 'x'.repeat(2001))
      await new Promise((resolve) => setTimeout(resolve, 1150))
      store.snapshot()
      expect(store.latestSurfaceCursor()).toBe(cursor)
      manager.start()
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
        expect.arrayContaining([expect.objectContaining({ document: 'USER', units: 2001 })]),
      )
      writeFileSync(join(root, 'USER.md'), 'x'.repeat(2000))
      await vi.waitFor(() =>
        expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
          expect.arrayContaining([expect.objectContaining({ document: 'USER', units: 2000 })]),
        ),
      )
    } finally {
      close()
      logged.mockRestore()
    }
  })

  it('recovers unsupported observation through the lifecycle fallback and observes newly restored Spaces', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(watch).mockImplementationOnce(() => {
      throw new Error('watch resource limit')
    })
    const { root, store, close } = fixture()
    try {
      writeFileSync(join(root, 'USER.md'), 'x'.repeat(2001))
      await vi.waitFor(
        () =>
          expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
            expect.arrayContaining([expect.objectContaining({ document: 'USER', units: 2001 })]),
          ),
        { timeout: 2500 },
      )
      expect(logged).toHaveBeenCalled()
      const space = store.spacesEngine.createSpace({ name: 'New space' })
      const path = join(root, 'spaces', space.slug, 'INSTRUCTIONS.md')
      store.spacesEngine.archiveSpace(space.id)
      writeFileSync(path, 'x'.repeat(2001))
      expect(
        store
          .snapshot()
          .spaces.flatMap((item) => item.surfaces)
          .find((surface) => surface.id === MEMORY_HEALTH_SURFACE_ID)?.state.documents,
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'New space' })]))
      store.spacesEngine.restoreSpace(space.id)
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
        expect.arrayContaining([expect.objectContaining({ scope: 'New space', units: 2001 })]),
      )
      writeFileSync(path, 'x'.repeat(2000))
      await vi.waitFor(() =>
        expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
          expect.arrayContaining([expect.objectContaining({ scope: 'New space', units: 2000 })]),
        ),
      )
    } finally {
      close()
      logged.mockRestore()
    }
  })

  it('retries failed projection writes through the lifecycle without snapshot side effects', async () => {
    const { root, store, close } = fixture()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const patch = vi.spyOn(store, 'patchState').mockImplementation(() => {
      throw new Error('projection unavailable')
    })
    try {
      writeFileSync(join(root, 'USER.md'), 'x'.repeat(2001))
      await vi.waitFor(() => expect(logged).toHaveBeenCalled())
      const cursor = store.latestSurfaceCursor()
      store.snapshot()
      expect(store.latestSurfaceCursor()).toBe(cursor)
      patch.mockRestore()
      await vi.waitFor(
        () =>
          expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
            expect.arrayContaining([expect.objectContaining({ document: 'USER', units: 2001 })]),
          ),
        { timeout: 2500 },
      )
    } finally {
      patch.mockRestore()
      logged.mockRestore()
      close()
    }
  })

  it('publishes document edits with every directory watcher unavailable and no reads or Heartbeat', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(watch).mockImplementation(() => {
      throw new Error('watch unavailable')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { root, store, close } = fixture()
    try {
      for (const units of [2001, 2000]) {
        writeFileSync(join(root, 'USER.md.replacement'), 'x'.repeat(units))
        renameSync(join(root, 'USER.md.replacement'), join(root, 'USER.md'))
        await vi.waitFor(
          () =>
            expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
              expect.arrayContaining([expect.objectContaining({ document: 'USER', units })]),
            ),
          { timeout: 2500 },
        )
      }
      expect(logged).toHaveBeenCalled()
    } finally {
      close()
      vi.mocked(watch).mockImplementation(actual.watch)
      logged.mockRestore()
    }
  })

  it('detects missed directory events through stat fallback and releases that fallback on disposal', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(watch).mockImplementation((path) =>
      actual.watch(path, { persistent: false }, () => {}),
    )
    const { root, store, manager, close } = fixture()
    try {
      writeFileSync(join(root, 'SOUL.md'), 'x'.repeat(2001))
      await vi.waitFor(
        () =>
          expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
            expect.arrayContaining([expect.objectContaining({ document: 'SOUL', units: 2001 })]),
          ),
        { timeout: 2500 },
      )
      manager.dispose()
      const cursor = store.latestSurfaceCursor()
      writeFileSync(join(root, 'SOUL.md'), 'x'.repeat(2000))
      await new Promise((resolve) => setTimeout(resolve, 1150))
      expect(store.latestSurfaceCursor()).toBe(cursor)
      expect(store.getSurface(MEMORY_HEALTH_SURFACE_ID)?.state.documents).toEqual(
        expect.arrayContaining([expect.objectContaining({ document: 'SOUL', units: 2001 })]),
      )
    } finally {
      close()
      vi.mocked(watch).mockImplementation(actual.watch)
    }
  })

  it('serves isolated document changes through the real HTTP snapshot with Heartbeat disabled across restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-document-snapshot-'))
    writeFileSync(join(root, 'heartbeat.json'), JSON.stringify({ enabled: false }))
    writeFileSync(join(root, 'USER.md'), 'x'.repeat(2000))
    let server = buildServer({ dataDir: root })
    const documents = async () => {
      const response = await server.app.inject('/api/spaces')
      expect(response.statusCode).toBe(200)
      return SurfaceSnapshotSchema.parse(response.json())
        .spaces.flatMap((space) => space.surfaces)
        .find((surface) => surface.id === MEMORY_HEALTH_SURFACE_ID)?.state.documents
    }
    try {
      expect(await documents()).toEqual(
        expect.arrayContaining([expect.objectContaining({ document: 'USER', units: 2000 })]),
      )
      writeFileSync(join(root, 'USER.md.replacement'), 'x'.repeat(2001))
      renameSync(join(root, 'USER.md.replacement'), join(root, 'USER.md'))
      await vi.waitFor(
        async () =>
          expect(await documents()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ document: 'USER', units: 2001, status: 'Warning' }),
            ]),
          ),
        { timeout: 2500 },
      )
      await server.app.close()
      server = buildServer({ dataDir: root })
      expect(await documents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ document: 'USER', units: 2001, status: 'Warning' }),
        ]),
      )
    } finally {
      await server.app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
