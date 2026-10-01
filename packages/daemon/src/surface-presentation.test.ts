import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SurfaceSchema } from '@veduta/protocol'
import { Store } from './store.ts'

const now = () => new Date('2026-10-01T10:00:00.000Z')

describe('Surface presentation', () => {
  it('keeps the selected presentation through ordinary Agent state and tree updates', () => {
    const store = new Store({ now })
    try {
      store.setSurfacePresentation('srf-groceries', 'full', {
        updatedBy: 'agent',
        origin: 'trusted:user',
        userRequest: { text: 'Make Groceries full-row', origin: 'trusted:user' },
      })
      store.patchState(
        'srf-groceries',
        [{ target: 'state', op: 'replace', path: '/milk', value: true }],
        { updatedBy: 'agent' },
      )
      store.patchTree(
        'srf-groceries',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/-',
            value: { id: 'caption', type: 'Caption', props: { text: 'Updated groceries' } },
          },
        ],
        { updatedBy: 'agent', expectedTreeVersion: 1 },
      )
      expect(store.getSurface('srf-groceries')).toMatchObject({
        presentation: 'full',
        state: { milk: true },
      })
      expect(store.getSurface('srf-groceries')?.tree.children?.at(-1)?.id).toBe('caption')
      expect(
        store.eventLog('spc-health').filter((event) => event.type === 'surface.presentation'),
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('makes a no-op request retry safe without reverting a later explicit request', () => {
    const store = new Store({ now })
    try {
      const initial = store.getSurface('srf-groceries')!
      const options = {
        updatedBy: 'agent' as const,
        origin: 'trusted:user' as const,
        userRequest: { text: 'Make Groceries standard', origin: 'trusted:user' as const },
        idempotencyKey: 'first-request',
      }
      const cursor = store.latestSurfaceCursor()
      expect(store.setSurfacePresentation(initial.id, 'standard', options)).toMatchObject({
        changed: false,
        duplicate: false,
      })
      expect(store.getSurface(initial.id)).toEqual(initial)
      expect(store.latestSurfaceCursor()).toBe(cursor)
      store.setSurfacePresentation(initial.id, 'full', {
        ...options,
        userRequest: { text: 'Make Groceries full-row', origin: 'trusted:user' },
        idempotencyKey: 'later-request',
      })
      expect(store.setSurfacePresentation(initial.id, 'standard', options)).toMatchObject({
        changed: false,
        duplicate: true,
        surface: { presentation: 'full' },
      })
      expect(() => store.setSurfacePresentation(initial.id, 'full', options)).toThrow(
        'does not match the original request',
      )
      expect(store.latestSurfaceCursor()).toBe(cursor + 1)
      expect(
        store.eventLog(initial.spaceId).filter((event) => event.type === 'surface.presentation'),
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('commits an explicit presentation change once, preserves Pin and content, and replays it after restart', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-presentation-'))
    let store = new Store({ rootDir, now })
    try {
      store.setPinned('srf-groceries', true, { updatedBy: 'user', origin: 'trusted:user' })
      const before = store.getSurface('srf-groceries')!
      const order = store.surfaceOrder(before.spaceId)
      const cursor = store.latestSurfaceCursor()
      const options = {
        updatedBy: 'agent' as const,
        origin: 'trusted:user' as const,
        userRequest: { text: 'Make Groceries full-row', origin: 'trusted:user' as const },
        idempotencyKey: 'presentation-request',
      }
      const result = store.setSurfacePresentation(before.id, 'full', options)
      expect(result).toMatchObject({
        changed: true,
        duplicate: false,
        surface: { presentation: 'full', pinned: true, tree: before.tree, state: before.state },
      })
      expect(store.surfaceOrder(before.spaceId)).toEqual(order)
      expect(store.getSurfaceVersion(before.id)).toMatchObject({ version: 3, treeVersion: 1 })
      expect(
        store.eventLog(before.spaceId).filter((event) => event.type === 'surface.presentation'),
      ).toMatchObject([
        {
          payload: {
            surfaceId: before.id,
            presentation: 'full',
            surfaceCommitId: expect.stringMatching(/^scm-/),
          },
        },
      ])
      const events = store.surfaceEventsAfter(cursor)
      expect(events).toMatchObject([
        { kind: 'presentation', event: { surfaceId: before.id, presentation: 'full' } },
      ])
      expect(store.setSurfacePresentation(before.id, 'full', options)).toMatchObject({
        changed: false,
        duplicate: true,
      })
      expect(store.surfaceEventsAfter(cursor)).toEqual(events)
      store.close()
      store = new Store({ rootDir, now })
      expect(store.getSurface(before.id)?.presentation).toBe('full')
      expect(store.surfaceEventsAfter(cursor)).toEqual(events)
      expect(store.setSurfacePresentation(before.id, 'full', options)).toMatchObject({
        changed: false,
        duplicate: true,
      })
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('defaults creation to standard and persists content-selected full presentation across restart', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-presentation-'))
    let store = new Store({ rootDir, now })
    try {
      const input = SurfaceSchema.parse({
        id: 'srf-presentation',
        spaceId: 'spc-health',
        title: 'Presentation',
        tree: {
          id: 'root',
          type: 'Box' as const,
          children: [{ id: 'title', type: 'Title' as const, props: { text: 'Presentation' } }],
        },
        state: {},
        freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
      })
      expect(store.createSurface(input, 'agent').presentation).toBe('standard')
      expect(
        store.createSurface({ ...input, id: 'srf-full', presentation: 'full' }, 'agent')
          .presentation,
      ).toBe('full')
      expect(store.getSurface('srf-full')?.presentation).toBe('full')
      store.close()
      store = new Store({ rootDir, now })
      expect(store.getSurface('srf-presentation')?.presentation).toBe('standard')
      expect(store.getSurface('srf-full')?.presentation).toBe('full')
      expect(store.surfaceEventsAfter(0)).toContainEqual(
        expect.objectContaining({
          kind: 'created',
          event: expect.objectContaining({
            surface: expect.objectContaining({ id: 'srf-full', presentation: 'full' }),
          }),
        }),
      )
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
