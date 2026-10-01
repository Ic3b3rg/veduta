import { fastInvocation } from './surface-action-test-fixtures.ts'
import { literalSetPlan } from '@veduta/protocol'
import { commitFastAction } from './surface-action-test-fixtures.ts'
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { createBackup, restoreBackup } from './backup.ts'
import type { SurfaceCommitTransport } from './surface-commit.ts'
import { SurfaceCommitRecoveryPendingError } from './surface-commit.ts'
import { buildServer } from './server.ts'
import { Store } from './store.ts'

const now = () => new Date('2026-09-30T10:00:00.000Z')
type Fault =
  'before_prepare' | 'before_append' | 'after_append' | 'after_file_flush' | 'after_delivery'
const mutationFamilies = [
  'creation',
  'Pin',
  'presentation',
  'Move',
  'archival',
  'state patch',
  'tree patch',
  'fast action',
  'Agent-path enqueue',
  'Tree proposal',
] as const
type MutationFamily = (typeof mutationFamilies)[number]

function prepareMutationFamily(store: Store, family: MutationFamily): void {
  store.createSurface(
    SurfaceSchema.parse({
      ...surface('srf-target'),
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
          {
            id: 'increment',
            type: 'Button',
            props: { label: 'Increment' },
            actions: [{ name: 'increment', path: 'fast', plan: literalSetPlan('count', 1) }],
          },
        ],
      },
    }),
    'user',
  )
  store.createSurface(surface('srf-neighbor'), 'user')
  if (family === 'Tree proposal') {
    store.setPinned('srf-target', true, { origin: 'trusted:user', updatedBy: 'user' })
  }
}

function mutateFamily(store: Store, family: MutationFamily): void {
  switch (family) {
    case 'creation':
      store.createSurface(surface('srf-created'), 'user')
      break
    case 'Pin':
      store.setPinned('srf-target', true, { origin: 'trusted:user', updatedBy: 'user' })
      break
    case 'presentation':
      store.setSurfacePresentation('srf-target', 'full', {
        origin: 'trusted:user',
        updatedBy: 'agent',
        userRequest: { text: 'Make this Surface full-row', origin: 'trusted:user' },
        idempotencyKey: 'family-presentation',
      })
      break
    case 'Move':
      store.moveSurface('spc-health', 'srf-target', 'up')
      break
    case 'archival':
      store.archiveSurface('srf-target', 'user')
      break
    case 'state patch':
      store.patchState(
        'srf-target',
        [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
        {
          updatedBy: 'user',
        },
      )
      break
    case 'tree patch':
    case 'Tree proposal':
      store.patchTree(
        'srf-target',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'caption', type: 'Caption', props: { text: 'Updated' } },
          },
        ],
        { expectedTreeVersion: 1, updatedBy: 'agent' },
      )
      break
    case 'fast action':
      commitFastAction(store, 'srf-target', 'count', 1, 'family-tap')
      break
    case 'Agent-path enqueue':
      store.invokeSurfaceAction('srf-target', { nodeId: 'trigger', name: 'go' })
      break
  }
}

function publicMutationState(store: Store) {
  return {
    snapshot: store.snapshot(),
    agentTurns: store.agentTurns(),
    proposals: store.listTreeProposals(),
  }
}

function expectMutationFamilyOutcome(store: Store, family: MutationFamily): void {
  switch (family) {
    case 'creation':
      expect(store.getSurface('srf-created')?.title).toBe('srf-created')
      break
    case 'Pin':
      expect(store.getSurface('srf-target')?.pinned).toBe(true)
      break
    case 'presentation':
      expect(store.getSurface('srf-target')?.presentation).toBe('full')
      break
    case 'Move':
      expect(store.surfaceOrder('spc-health').regularSurfaceIds[0]).toBe('srf-target')
      break
    case 'archival':
      expect(store.getSurface('srf-target')).toBeUndefined()
      break
    case 'state patch':
    case 'fast action':
      expect(store.getSurface('srf-target')?.state['count']).toBe(1)
      break
    case 'tree patch':
      expect(store.getSurface('srf-target')?.tree.children?.[1]).toMatchObject({
        id: 'caption',
        type: 'Caption',
        props: { text: 'Updated' },
      })
      break
    case 'Agent-path enqueue':
      expect(store.agentTurns().filter((turn) => turn.surfaceId === 'srf-target')).toHaveLength(1)
      break
    case 'Tree proposal':
      expect(store.listTreeProposals({ surfaceId: 'srf-target', status: 'pending' })).toHaveLength(
        1,
      )
      expect(store.getSurface('srf-target')?.tree.children).toHaveLength(2)
      break
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'veduta-surface-commit-'))
}

function storeWithFault(rootDir: string, fault: Fault, onFault?: () => void): Store {
  let armed = true
  return new Store({
    rootDir,
    now,
    surfaceCommitTransport: (spaces) => {
      const transport: SurfaceCommitTransport = {
        prepareSurfaceCommitEvent(spaceId, input, commitId) {
          if (armed && fault === 'before_prepare') {
            armed = false
            onFault?.()
            throw new Error('injected preparation failure')
          }
          return spaces.prepareSurfaceCommitEvent(spaceId, input, commitId)
        },
        deliverSurfaceCommitEvent(prepared) {
          if (!armed || fault === 'before_prepare') {
            spaces.deliverSurfaceCommitEvent(prepared)
            return
          }
          armed = false
          const path = join(rootDir, prepared.destination)
          if (fault === 'before_append') {
            onFault?.()
            throw new Error('injected append failure')
          }
          if (fault === 'after_append') {
            appendFileSync(path, JSON.stringify(prepared.event).slice(0, 25))
            onFault?.()
            throw new Error('injected torn JSONL tail')
          }
          if (fault === 'after_file_flush') {
            const fd = openSync(path, 'a')
            try {
              appendFileSync(fd, `${JSON.stringify(prepared.event)}\n`)
              fsyncSync(fd)
            } finally {
              closeSync(fd)
            }
            onFault?.()
            throw new Error('injected directory flush failure')
          }
          spaces.deliverSurfaceCommitEvent(prepared)
          onFault?.()
          throw new Error('injected delivered-marker failure')
        },
        notifySurfaceCommitDelivered: (spaceId) => spaces.notifySurfaceCommitDelivered(spaceId),
      }
      return transport
    },
  })
}

function records(rootDir: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
  try {
    return db.prepare('select * from surface_commits order by sequence').all()
  } finally {
    db.close()
  }
}

function surface(id: string, spaceId = 'spc-health'): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: id,
    tree: {
      id: 'root',
      type: 'Box',
      children: [{ id: 'fixture-content', type: 'Text', props: { text: 'Fixture content' } }],
    },
    state: { count: 0 },
    freshness: { updatedAt: now().toISOString(), updatedBy: 'user' },
  })
}

describe('recoverable Surface commits (#156)', () => {
  describe.each(mutationFamilies)('%s recovery', (family) => {
    it.each([
      'before_prepare',
      'before_append',
      'after_append',
      'after_file_flush',
      'after_delivery',
    ] as const)('preserves one public mutation outcome across %s', (fault) => {
      const rootDir = root()
      let store = new Store({ rootDir, now })
      try {
        prepareMutationFamily(store, family)
        const before = publicMutationState(store)
        const eventCount = store.eventLog('spc-health').length
        store.close()
        store = storeWithFault(rootDir, fault)
        let observerCalls = 0
        store.onSurfaceEvent(() => {
          observerCalls += 1
        })

        expect(() => mutateFamily(store, family)).toThrow()
        expect(observerCalls).toBe(0)
        if (fault === 'before_prepare') {
          expect(publicMutationState(store)).toEqual(before)
          expect(store.eventLog('spc-health')).toHaveLength(eventCount)
          expect(store.recoveryPendingSurfaceCommits()).toEqual([])
          return
        }

        const pending = store.recoveryPendingSurfaceCommits('spc-health')
        expect(pending).toHaveLength(1)
        const commitId = pending[0]!.id
        const committedState = publicMutationState(store)
        expect(committedState).not.toEqual(before)
        expectMutationFamilyOutcome(store, family)
        store.close()
        store = new Store({ rootDir, now: () => new Date('2026-10-01T10:00:00.000Z') })

        expect(publicMutationState(store)).toEqual(committedState)
        expectMutationFamilyOutcome(store, family)
        expect(store.recoveryPendingSurfaceCommits()).toEqual([])
        expect(store.eventLog('spc-health')).toHaveLength(eventCount + 1)
        expect(
          store
            .eventLog('spc-health')
            .filter((event) => event.payload?.['surfaceCommitId'] === commitId),
        ).toHaveLength(1)
        expect(store.reconcilePendingSurfaceCommits()).toEqual([])
        expect(store.reconcilePendingSurfaceCommits()).toEqual([])
        expect(publicMutationState(store)).toEqual(committedState)
        expect(store.eventLog('spc-health')).toHaveLength(eventCount + 1)
      } finally {
        store.close()
        rmSync(rootDir, { recursive: true, force: true })
      }
    })
  })

  it('rolls back the mutation and prepared Event if preparation fails inside SQLite', () => {
    const rootDir = root()
    const store = storeWithFault(rootDir, 'before_prepare')
    try {
      const before = store.getSurface('srf-groceries')
      const eventCount = store.eventLog('spc-health').length
      expect(() => commitFastAction(store, 'srf-groceries', 'milk', true)).toThrow(
        'injected preparation failure',
      )
      expect(store.getSurface('srf-groceries')).toEqual(before)
      expect(store.eventLog('spc-health')).toHaveLength(eventCount)
      expect(records(rootDir)).toEqual([])
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it.each(['before_append', 'after_append', 'after_file_flush', 'after_delivery'] as const)(
    'returns a stable recovery_pending identity after %s and drains exactly once after restart',
    (fault) => {
      const rootDir = root()
      let store = storeWithFault(rootDir, fault)
      try {
        const before = store.eventLog('spc-health').length
        let pending: SurfaceCommitRecoveryPendingError | undefined
        try {
          commitFastAction(store, 'srf-groceries', 'milk', true, 'same-tap')
        } catch (error) {
          if (error instanceof SurfaceCommitRecoveryPendingError) pending = error
          else throw error
        }
        expect(pending?.outcome).toBe('recovery_pending')
        expect(pending?.commitId).toMatch(/^scm-/)
        expect(store.getSurface('srf-groceries')?.state['milk']).toBe(true)
        expect(store.recoveryPendingSurfaceCommits('spc-health')).toHaveLength(1)
        expect(records(rootDir)).toMatchObject([
          { id: pending?.commitId, state: 'recovery_pending' },
        ])
        store.close()

        store = new Store({ rootDir, now: () => new Date('2026-10-01T10:00:00.000Z') })
        expect(store.recoveryPendingSurfaceCommits()).toEqual([])
        const events = store
          .eventLog('spc-health')
          .filter((event) => event.payload?.['surfaceCommitId'] === pending?.commitId)
        expect(events).toHaveLength(1)
        expect(store.eventLog('spc-health')).toHaveLength(before + 1)
        expect(commitFastAction(store, 'srf-groceries', 'milk', true, 'same-tap').duplicate).toBe(
          true,
        )
        expect(store.eventLog('spc-health')).toHaveLength(before + 1)
        expect(records(rootDir)).toMatchObject([{ id: pending?.commitId, state: 'delivered' }])
      } finally {
        store.close()
        rmSync(rootDir, { recursive: true, force: true })
      }
    },
  )

  it('isolates the affected Space, permits reads, and resumes its writes after live recovery', () => {
    const rootDir = root()
    const store = storeWithFault(rootDir, 'before_append')
    try {
      const other = store.spacesEngine.createSpace({ name: 'Other' })
      expect(() => commitFastAction(store, 'srf-groceries', 'milk', true)).toThrow(
        SurfaceCommitRecoveryPendingError,
      )
      expect(store.getSurface('srf-groceries')?.state['milk']).toBe(true)
      store.createSurface(surface('srf-other', other.id), 'user')
      expect(
        store.eventLog(other.id).filter((event) => event.type === 'surface.create'),
      ).toHaveLength(1)
      expect(store.reconcilePendingSurfaceCommits()).toEqual([])
      expect(store.recoveryPendingSurfaceCommits()).toEqual([])
      expect(() => store.assertSpaceReadyForAgent('spc-health')).not.toThrow()
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('blocks Agent-authorable reads in a pending Space while preserving UI reads and other Spaces', () => {
    const rootDir = root()
    let deliveryAllowed = false
    const store = new Store({
      rootDir,
      now,
      surfaceCommitTransport: (spaces): SurfaceCommitTransport => ({
        prepareSurfaceCommitEvent: (spaceId, input, commitId) =>
          spaces.prepareSurfaceCommitEvent(spaceId, input, commitId),
        deliverSurfaceCommitEvent: (prepared) => {
          if (!deliveryAllowed) throw new Error('injected persistent delivery failure')
          spaces.deliverSurfaceCommitEvent(prepared)
        },
        notifySurfaceCommitDelivered: (spaceId) => spaces.notifySurfaceCommitDelivered(spaceId),
      }),
    })
    try {
      const other = store.spacesEngine.createSpace({ name: 'Other' })
      expect(() => commitFastAction(store, 'srf-groceries', 'milk', true)).toThrow(
        SurfaceCommitRecoveryPendingError,
      )
      expect(store.getSurface('srf-groceries')?.state['milk']).toBe(true)
      expect(() => store.listAuthorableSurfaces('spc-health')).toThrow(
        SurfaceCommitRecoveryPendingError,
      )
      expect(() => store.readAuthorableSurface('spc-health', 'srf-groceries')).toThrow(
        SurfaceCommitRecoveryPendingError,
      )
      expect(store.listAuthorableSurfaces(other.id).surfaces).toEqual([])

      deliveryAllowed = true
      expect(store.reconcilePendingSurfaceCommits()).toEqual([])
      expect(store.readAuthorableSurface('spc-health', 'srf-groceries').surface.state['milk']).toBe(
        true,
      )
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('records one delivered identity for every Event-requiring mutation family', () => {
    const rootDir = root()
    const store = new Store({ rootDir, now })
    try {
      store.createSurface(surface('srf-one'), 'user')
      store.createSurface(surface('srf-two'), 'user')
      store.patchState('srf-one', [{ target: 'state', op: 'replace', path: '/count', value: 1 }], {
        updatedBy: 'user',
      })
      store.patchTree(
        'srf-one',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/0',
            value: { id: 'caption', type: 'Caption', props: { text: 'One' } },
          },
        ],
        { expectedTreeVersion: 1, updatedBy: 'agent' },
      )
      store.moveSurface('spc-health', 'srf-two', 'down')
      store.setPinned('srf-one', true, { origin: 'trusted:user', updatedBy: 'user' })
      store.patchTree(
        'srf-one',
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/1',
            value: { id: 'proposed', type: 'Caption', props: { text: 'Two' } },
          },
        ],
        { expectedTreeVersion: 2, updatedBy: 'agent' },
      )
      store.archiveSurface('srf-two', 'user')
      commitFastAction(store, 'srf-groceries', 'milk', true, 'family-fast')
      store.createSurface(
        SurfaceSchema.parse({
          ...surface('srf-agent-action'),
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
        }),
        'user',
      )
      store.invokeSurfaceAction('srf-agent-action', { nodeId: 'trigger', name: 'go' })

      const expected = [
        'surface.create',
        'surface.patch_state',
        'surface.patch_tree',
        'surface.move',
        'surface.pin',
        'surface.tree_proposal',
        'surface.archive',
        'fast_path',
        'agent_path',
      ]
      const events = store.eventLog('spc-health').filter((event) => expected.includes(event.type))
      expect(new Set(events.map((event) => event.type))).toEqual(new Set(expected))
      const commits = records(rootDir)
      expect(commits).toHaveLength(events.length)
      expect(commits.every((record) => record['state'] === 'delivered')).toBe(true)
      expect(new Set(events.map((event) => event.payload?.['surfaceCommitId'])).size).toBe(
        events.length,
      )
      for (const record of commits) {
        const event = JSON.parse(String(record['event_json'])) as {
          payload: { surfaceCommitId: string }
        }
        expect(record['id']).toBe(event.payload.surfaceCommitId)
        expect(
          events.some((candidate) => candidate.payload?.['surfaceCommitId'] === record['id']),
        ).toBe(true)
      }
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('reports recovery_pending through the Gateway API and retries without resubmitting the action', async () => {
    const rootDir = root()
    const { app, store } = buildServer({ dataDir: rootDir, now })
    const deliver = store.spacesEngine.deliverSurfaceCommitEvent.bind(store.spacesEngine)
    store.spacesEngine.deliverSurfaceCommitEvent = () => {
      throw new Error('injected disk failure')
    }
    try {
      const action = await app.inject({
        method: 'POST',
        url: '/api/surfaces/srf-groceries/actions',
        payload: fastInvocation(
          store,
          'srf-groceries',
          'item-milk',
          'toggle',
          { value: true },
          'api-tap',
        ),
      })
      expect(action.statusCode).toBe(202)
      expect(action.json()).toMatchObject({
        outcome: 'recovery_pending',
        surfaceCommitId: expect.stringMatching(/^scm-/),
        spaceId: 'spc-health',
      })
      expect(store.getSurface('srf-groceries')?.state['milk']).toBe(true)
      const pending = await app.inject({ method: 'GET', url: '/api/surface-commits/recovery' })
      expect(pending.json().pending).toHaveLength(1)
      store.spacesEngine.deliverSurfaceCommitEvent = deliver
      const recovered = await app.inject({ method: 'POST', url: '/api/surface-commits/recovery' })
      expect(recovered.statusCode).toBe(200)
      expect(recovered.json()).toEqual({ pending: [] })
      expect(
        store.eventLog('spc-health').filter((event) => event.type === 'fast_path'),
      ).toHaveLength(1)
      const retry = await app.inject({
        method: 'POST',
        url: '/api/surfaces/srf-groceries/actions',
        payload: fastInvocation(
          store,
          'srf-groceries',
          'item-milk',
          'toggle',
          { value: true },
          'api-tap',
        ),
      })
      expect(retry.statusCode).toBe(200)
      expect(
        store.eventLog('spc-health').filter((event) => event.type === 'fast_path'),
      ).toHaveLength(1)
    } finally {
      store.spacesEngine.deliverSurfaceCommitEvent = deliver
      await app.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('drains several restored pending identities in their original Space order', () => {
    const rootDir = root()
    const first = storeWithFault(rootDir, 'before_append')
    let firstId: string
    try {
      expect(() => commitFastAction(first, 'srf-groceries', 'milk', true)).toThrow(
        SurfaceCommitRecoveryPendingError,
      )
      firstId = String(records(rootDir)[0]?.['id'])
    } finally {
      first.close()
    }
    const secondId = 'scm-restored-second-commit'
    const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    try {
      const previous = db.prepare('select * from surface_commits where id = ?').get(firstId)!
      const secondEvent = JSON.parse(String(previous['event_json'])) as {
        payload: { surfaceCommitId: string }
      }
      secondEvent.payload.surfaceCommitId = secondId
      db.prepare(
        `insert into surface_commits
          (id, space_id, surface_event_cursor, event_json, destination, correlation_id, state)
         values (?, ?, null, ?, ?, null, 'recovery_pending')`,
      ).run(secondId, 'spc-health', JSON.stringify(secondEvent), String(previous['destination']))
    } finally {
      db.close()
    }

    const recovered = new Store({ rootDir, now: () => new Date('2026-10-01T10:00:00.000Z') })
    try {
      expect(recovered.recoveryPendingSurfaceCommits()).toEqual([])
      const identities = recovered
        .eventLog('spc-health')
        .map((event) => event.payload?.['surfaceCommitId'])
        .filter((id) => id === firstId || id === secondId)
      expect(identities).toEqual([firstId, secondId])
    } finally {
      recovered.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('isolates throwing post-delivery observers from the acknowledged mutation', () => {
    const rootDir = root()
    const store = new Store({ rootDir, now })
    try {
      let laterObserver = 0
      store.onSurfaceEvent(() => {
        throw new Error('observer failed')
      })
      store.onSurfaceEvent(() => {
        laterObserver += 1
      })
      expect(() => commitFastAction(store, 'srf-groceries', 'milk', true)).not.toThrow()
      expect(laterObserver).toBe(1)
      expect(records(rootDir)).toMatchObject([{ state: 'delivered' }])
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it.each(['before_prepare', 'before_append', 'after_delivery', 'delivered'] as const)(
    'restores encrypted live backup from %s to one mutation and one Event',
    async (boundary) => {
      const rootDir = root()
      const backupDir = root()
      const restoredRoot = root()
      const keyMaterial = Buffer.alloc(32, 7)
      const original =
        boundary === 'delivered' ? new Store({ rootDir, now }) : storeWithFault(rootDir, boundary)
      try {
        if (boundary === 'delivered') {
          commitFastAction(original, 'srf-groceries', 'milk', true)
        } else {
          expect(() => commitFastAction(original, 'srf-groceries', 'milk', true)).toThrow()
        }
        const file = await createBackup({ rootDir, outDir: backupDir, keyMaterial, now })
        await restoreBackup({ file, targetRootDir: restoredRoot, keyMaterial })
        const restored = new Store({ rootDir: restoredRoot, now })
        try {
          const expected = boundary === 'before_prepare' ? 0 : 1
          expect(restored.getSurface('srf-groceries')?.state['milk']).toBe(expected === 1)
          expect(
            restored.eventLog('spc-health').filter((event) => event.type === 'fast_path'),
          ).toHaveLength(expected)
          expect(restored.recoveryPendingSurfaceCommits()).toEqual([])
        } finally {
          restored.close()
        }
      } finally {
        original.close()
        rmSync(rootDir, { recursive: true, force: true })
        rmSync(backupDir, { recursive: true, force: true })
        rmSync(restoredRoot, { recursive: true, force: true })
      }
    },
  )

  it('records an upgrade baseline without pairing or rewriting legacy Events', () => {
    const rootDir = root()
    const store = new Store({ rootDir, now })
    try {
      const db = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
      try {
        expect(
          db.prepare('select legacy_surface_cursor from surface_commit_baseline').get(),
        ).toEqual({
          legacy_surface_cursor: 0,
        })
      } finally {
        db.close()
      }
      store.spacesEngine.appendEvent('spc-health', { text: 'Legacy Event remains unchanged' })
      const slug = store.getSpace('spc-health')!.slug
      const path = join(rootDir, 'spaces', slug, 'log', '2026-09-30.jsonl')
      const before = readFileSync(path, 'utf8')
      store.reconcilePendingSurfaceCommits()
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally {
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
