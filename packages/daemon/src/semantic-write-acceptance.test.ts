import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  SurfaceSchema,
  SurfaceValidationError,
  type Surface,
  type PatchOperation,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'

const stores: { store: Store; root: string }[] = []
afterEach(() => {
  for (const { store, root } of stores.splice(0)) {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-semantic-write-'))
  const store = new Store({ rootDir: root })
  stores.push({ store, root })
  const space = store.spacesEngine.createSpace({ name: 'Semantic writes' })
  const surface = store.createSurface(
    SurfaceSchema.parse({
      id: 'srf-semantic',
      spaceId: space.id,
      title: 'Canonical text',
      tree: { id: 'root', type: 'Col', children: [{ id: 'text', type: 'Text', binding: 'text' }] },
      state: { text: 'Original' },
      freshness: { updatedAt: '2026-10-01T10:00:00Z', updatedBy: 'agent' },
    }),
    'agent',
  )
  return { store, surface, space }
}

function canonical(store: Store, spaceId: string) {
  return {
    snapshot: store.snapshot(),
    version: store.getSurfaceVersion('srf-semantic'),
    events: store.eventLog(spaceId),
    realtime: store.surfaceEventsAfter(0),
    proposals: store.listTreeProposals({ surfaceId: 'srf-semantic' }),
  }
}

function rejected(write: () => unknown, expectedPath: (string | number)[]) {
  let error: unknown
  try {
    write()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(SurfaceValidationError)
  if (!(error instanceof SurfaceValidationError)) return
  expect(error.code).toBe('invalid_surface')
  expect(error.validationIssues).toContainEqual(expect.objectContaining({ path: expectedPath }))
}

describe('complete semantic write acceptance', () => {
  it('refuses a layout-only card and removal of the last visible content atomically', () => {
    const { store, surface, space } = fixture()
    const before = canonical(store, space.id)
    rejected(
      () =>
        store.createSurface(
          { ...surface, id: 'srf-empty', tree: { id: 'root', type: 'Box', children: [] } },
          'agent',
        ),
      ['tree'],
    )
    expect(canonical(store, space.id)).toEqual(before)
    rejected(
      () =>
        store.patchTree(surface.id, [{ target: 'tree', op: 'remove', path: '/children/0' }], {
          updatedBy: 'agent',
          expectedTreeVersion: 1,
        }),
      ['tree'],
    )
    expect(canonical(store, space.id)).toEqual(before)
  })

  it('refuses malformed creation with precise diagnostics before any durable or realtime effect', () => {
    const { store, surface, space } = fixture()
    const before = canonical(store, space.id)
    const invalidProps = { label: 'Metric', unsupported: true }
    rejected(
      () =>
        store.createSurface(
          fromPartial<Surface>({
            ...surface,
            id: 'srf-invalid',
            tree: { id: 'broken', type: 'Stat', props: invalidProps },
          }),
          'agent',
        ),
      ['tree', 'props', 'unsupported'],
    )
    expect(canonical(store, space.id)).toEqual(before)
  })

  it.each(['agent', 'job'] as const)(
    'refuses an invalid subtree atomically for %s tree replacement',
    (updatedBy) => {
      const { store, surface, space } = fixture()
      const before = canonical(store, space.id)
      const invalidProps = { text: 'Bad', unsupported: true }
      rejected(
        () =>
          store.patchTree(
            surface.id,
            [
              fromPartial<PatchOperation>({
                target: 'tree',
                op: 'replace',
                path: '',
                value: {
                  id: 'root',
                  type: 'Col',
                  children: [
                    { id: 'valid', type: 'Text', props: { text: 'Should never appear' } },
                    { id: 'broken', type: 'Text', props: invalidProps },
                  ],
                },
              }),
            ],
            { updatedBy, expectedTreeVersion: 1 },
          ),
        ['operations', 0, 'value', 'children', 1, 'props', 'unsupported'],
      )
      expect(canonical(store, space.id)).toEqual(before)
    },
  )

  it('refuses invalid complete state and pinned proposals without changing versions, cursors or Events', () => {
    const { store, surface, space } = fixture()
    const before = canonical(store, space.id)
    rejected(
      () =>
        store.patchState(
          surface.id,
          [{ target: 'state', op: 'replace', path: '/text', value: {} }],
          { updatedBy: 'job' },
        ),
      ['state', 'text'],
    )
    expect(canonical(store, space.id)).toEqual(before)
    store.setPinned(surface.id, true, { updatedBy: 'user', origin: 'trusted:user' })
    const pinned = canonical(store, space.id)
    rejected(
      () =>
        store.patchTree(
          surface.id,
          [
            {
              target: 'tree',
              op: 'replace',
              path: '',
              value: { id: 'unbound', type: 'Text', binding: 'missing' },
            },
          ],
          { updatedBy: 'agent', expectedTreeVersion: 1 },
        ),
      ['tree', 'binding'],
    )
    expect(canonical(store, space.id)).toEqual(pinned)
  })
})
