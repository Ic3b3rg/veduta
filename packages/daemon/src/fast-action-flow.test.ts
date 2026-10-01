import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  SurfaceSchema,
  type ActionStep,
  type FastActionInvocation,
  type JsonObject,
  type CommittedFastActionOutcome,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store, SurfaceActionError, type StoreOptions } from './store.ts'
import { fastInvocation } from './surface-action-test-fixtures.ts'
import { templateFromSurface, surfaceFromTemplate, sanitizeImportedTemplate } from './templates.ts'
const roots: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup(options: Omit<StoreOptions, 'rootDir'> = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-action-'))
  roots.push(rootDir)
  const store = new Store({ rootDir, now: () => new Date('2026-10-01T10:00:00.000Z'), ...options })
  stores.push(store)
  const space = store.spacesEngine.createSpace({ name: 'Collection' })
  const surface = store.createSurface(
    SurfaceSchema.parse({
      id: 'collection',
      spaceId: space.id,
      title: 'Items',
      freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'agent' },
      state: { draft: '', items: [] },
      tree: {
        id: 'form',
        type: 'Form',
        props: { label: 'Add item', submitLabel: 'Add' },
        children: [{ id: 'draft', type: 'Input', binding: 'draft', props: { label: 'Item' } }],
        actions: [
          {
            name: 'submit',
            path: 'fast',
            plan: {
              inputs: { draft: { type: 'string' } },
              targets: {
                draft: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    identityKey: 'id',
                    fields: { id: { type: 'string' }, label: { type: 'string' } },
                  },
                },
              },
              steps: [
                {
                  op: 'append',
                  target: 'items',
                  value: {
                    source: 'object',
                    fields: {
                      id: { source: 'metadata', name: 'recordId' },
                      label: { source: 'input', name: 'draft' },
                    },
                  },
                },
                { op: 'clear', target: 'draft', value: '' },
              ],
            },
          },
        ],
      },
    }),
    'agent',
  )
  const action = surface.tree.actions?.[0]
  if (action?.path !== 'fast' || !action.revision)
    throw new Error('canonical action revision missing')
  const invocation: FastActionInvocation = {
    nodeId: 'form',
    name: 'submit',
    actionRevision: action.revision,
    intentId: randomUUID(),
    inputs: { draft: 'Bread' },
  }
  return { store, surface, invocation, rootDir }
}
function operationSurface(store: Store, spaceId: string, steps: ActionStep[], state: JsonObject) {
  const targets = Object.fromEntries(
    [...new Set(steps.map((step) => step.target))].map((key) => [
      key,
      key === 'items'
        ? {
            type: 'array',
            items: {
              type: 'object',
              identityKey: 'id',
              fields: { id: { type: 'string' }, label: { type: 'string' } },
            },
          }
        : key === 'tags'
          ? { type: 'array', items: { type: 'string' } }
          : { type: 'boolean' },
    ]),
  )
  return store.createSurface(
    SurfaceSchema.parse({
      id: 'operations',
      spaceId,
      title: 'Collection operations',
      freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'agent' },
      state,
      tree: {
        id: 'execute',
        type: 'Button',
        props: { label: 'Apply' },
        actions: [{ name: 'press', path: 'fast', plan: { inputs: {}, targets, steps } }],
      },
    }),
    'agent',
  )
}
describe('authoritative fast Action execution', () => {
  it.each<ActionStep>([
    {
      op: 'remove',
      target: 'items',
      selector: { source: 'literal', value: 'personal-id' },
      missing: 'reject',
    },
    {
      op: 'append',
      target: 'items',
      value: {
        source: 'object',
        fields: {
          id: { source: 'metadata', name: 'recordId' },
          label: { source: 'literal', value: 'Personal record' },
        },
      },
    },
  ])('rejects nonportable $op declarations during both Template extraction and import', (step) => {
    const { store, surface } = setup()
    const target = operationSurface(store, surface.spaceId, [step], {
      items: [{ id: 'personal-id', label: 'Personal record' }],
    })
    const provenance = {
      savedBy: 'pin' as const,
      savedAt: '2026-10-01T10:00:00.000Z',
      origin: 'trusted:user' as const,
    }
    expect(() => templateFromSurface(target, provenance)).toThrow('instance')
    expect(() =>
      sanitizeImportedTemplate(
        {
          formatVersion: 1,
          id: 'tpl-personal',
          name: 'Collection',
          intent: 'collection',
          tree: target.tree,
          stateKeys: ['items'],
          dataProps: [],
          provenance: { ...provenance, sourceSurfaceId: target.id, sourceSpaceId: target.spaceId },
        },
        'import',
      ),
    ).toThrow('instance')
  })
  it('rejects an intermediate duplicate identity before any earlier batch write persists', () => {
    const { store, surface } = setup()
    const target = operationSurface(
      store,
      surface.spaceId,
      [
        { op: 'set', target: 'flag', value: { source: 'literal', value: true } },
        {
          op: 'append',
          target: 'items',
          value: {
            source: 'object',
            fields: {
              id: { source: 'literal', value: 'a' },
              label: { source: 'literal', value: 'Duplicate' },
            },
          },
        },
      ],
      { flag: false, items: [{ id: 'a', label: 'A' }] },
    )
    const cursor = store.latestSurfaceCursor()
    expect(() =>
      store.invokeSurfaceAction(target.id, fastInvocation(store, target.id, 'execute', 'press')),
    ).toThrow(SurfaceActionError)
    expect(store.getSurface(target.id)).toEqual(target)
    expect(store.latestSurfaceCursor()).toBe(cursor)
  })
  it('retains an unchanged revision, ignores an authored replacement revision, and changes it for a new plan', () => {
    const { store, surface, invocation } = setup()
    const original = surface.tree.actions?.[0]
    if (original?.path !== 'fast') throw new Error('fast Action required')
    store.patchTree(
      surface.id,
      [
        {
          target: 'tree',
          op: 'replace',
          path: '',
          value: { ...surface.tree, actions: [{ ...original, revision: 'acr-authored' }] },
        },
      ],
      { expectedTreeVersion: store.getSurfaceVersion(surface.id)!.treeVersion, updatedBy: 'agent' },
    )
    expect(store.getSurface(surface.id)?.tree.actions?.[0]).toHaveProperty(
      'revision',
      invocation.actionRevision,
    )
    const changed = {
      ...original,
      plan: { ...original.plan, steps: [...original.plan.steps].reverse() },
    }
    store.patchTree(
      surface.id,
      [{ target: 'tree', op: 'replace', path: '', value: { ...surface.tree, actions: [changed] } }],
      { expectedTreeVersion: store.getSurfaceVersion(surface.id)!.treeVersion, updatedBy: 'agent' },
    )
    expect(store.getSurface(surface.id)?.tree.actions?.[0]).not.toHaveProperty(
      'revision',
      invocation.actionRevision,
    )
    expect(() => store.invokeSurfaceAction(surface.id, invocation)).toThrow('Action changed')
  })
  it('rejects a precondition veto and an attempted precondition mutation before persistence', () => {
    const { store, surface, invocation } = setup()
    const cursor = store.latestSurfaceCursor()
    const detach = store.onFastActionPreflight(() => {
      throw new Error('Offer expired')
    })
    expect(() => store.invokeSurfaceAction(surface.id, invocation)).toThrow('Offer expired')
    detach()
    store.onFastActionPreflight((context) => {
      context.nextSurface.state['draft'] = 'Unauthorized'
    })
    expect(() => store.invokeSurfaceAction(surface.id, invocation)).toThrow()
    expect(store.getSurface(surface.id)).toEqual(surface)
    expect(store.latestSurfaceCursor()).toBe(cursor)
    expect(store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path')).toEqual(
      [],
    )
  })
  it('delivers an async named projection in cursor order and receipts only after completion', async () => {
    const { store, surface, invocation } = setup()
    let complete = () => {}
    const gate = new Promise<void>((resolve) => {
      complete = resolve
    })
    const projected: CommittedFastActionOutcome[] = []
    store.onFastActionOutcome('async-projection', (outcome) => {
      projected.push(outcome)
      if (projected.length === 1) return gate
    })
    store.invokeSurfaceAction(surface.id, invocation)
    store.invokeSurfaceAction(surface.id, {
      ...invocation,
      intentId: randomUUID(),
      inputs: { draft: 'Milk' },
    })
    expect(projected).toHaveLength(1)
    complete()
    await vi.waitFor(() => expect(projected).toHaveLength(2))
    expect(projected[0]!.eventCursor).toBeLessThan(projected[1]!.eventCursor)
  })
  it('reduces all five operations in declaration order as one atomic batch', () => {
    const { store, surface } = setup()
    const target = operationSurface(
      store,
      surface.spaceId,
      [
        { op: 'set', target: 'flag', value: { source: 'literal', value: true } },
        {
          op: 'append',
          target: 'items',
          value: {
            source: 'object',
            fields: {
              id: { source: 'metadata', name: 'recordId' },
              label: { source: 'literal', value: 'Added' },
            },
          },
        },
        {
          op: 'update',
          target: 'items',
          selector: { source: 'literal', value: 'a' },
          fields: { label: { source: 'literal', value: 'Updated' } },
          missing: 'reject',
        },
        {
          op: 'remove',
          target: 'items',
          selector: { source: 'literal', value: 'b' },
          missing: 'reject',
        },
        { op: 'clear', target: 'tags', value: [] },
      ],
      {
        flag: false,
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        tags: ['old'],
      },
    )
    const before = store.latestSurfaceCursor()
    const result = store.invokeSurfaceAction(
      target.id,
      fastInvocation(store, target.id, 'execute', 'press'),
    )
    expect(result).toMatchObject({
      path: 'fast',
      outcome: {
        outcome: 'committed',
        surface: {
          state: {
            flag: true,
            items: [
              { id: 'a', label: 'Updated' },
              { id: expect.any(String), label: 'Added' },
            ],
            tags: [],
          },
        },
        patch: {
          operations: [
            { path: '/flag' },
            { path: '/items' },
            { path: '/items' },
            { path: '/items' },
            { path: '/tags' },
          ],
        },
      },
    })
    expect(store.latestSurfaceCursor()).toBe(before + 1)
    expect(
      store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
  })
  it('rolls back an earlier write when a later record selector or intermediate identity is invalid', () => {
    const { store, surface } = setup()
    const target = operationSurface(
      store,
      surface.spaceId,
      [
        { op: 'set', target: 'flag', value: { source: 'literal', value: true } },
        {
          op: 'remove',
          target: 'items',
          selector: { source: 'literal', value: 'missing' },
          missing: 'reject',
        },
      ],
      { flag: false, items: [{ id: 'a', label: 'A' }] },
    )
    const before = store.latestSurfaceCursor(),
      version = store.getSurfaceVersion(target.id)
    expect(() =>
      store.invokeSurfaceAction(target.id, fastInvocation(store, target.id, 'execute', 'press')),
    ).toThrow('no longer exists')
    expect(store.getSurface(target.id)).toEqual(target)
    expect(store.getSurfaceVersion(target.id)).toEqual(version)
    expect(store.latestSurfaceCursor()).toBe(before)
    expect(store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path')).toEqual(
      [],
    )
  })
  it('records a retryable noop without a Patch, Surface version, commit, or Space Event', () => {
    const { store, surface } = setup()
    const target = operationSurface(
      store,
      surface.spaceId,
      [
        { op: 'set', target: 'flag', value: { source: 'literal', value: true } },
        {
          op: 'remove',
          target: 'items',
          selector: { source: 'literal', value: 'missing' },
          missing: 'noop',
        },
      ],
      { flag: true, items: [] },
    )
    const invocation = fastInvocation(store, target.id, 'execute', 'press')
    const before = store.latestSurfaceCursor(),
      version = store.getSurfaceVersion(target.id)
    const result = store.invokeSurfaceAction(target.id, invocation)
    expect(result).toEqual({
      path: 'fast',
      outcome: {
        outcome: 'noop',
        surfaceId: target.id,
        nodeId: 'execute',
        actionName: 'press',
        actionRevision: invocation.actionRevision,
        intentId: invocation.intentId,
        reason: 'missing_target',
        duplicate: false,
      },
    })
    if (result.path !== 'fast') throw new Error('fast Action required')
    expect(store.invokeSurfaceAction(target.id, invocation)).toEqual({
      path: 'fast',
      outcome: { ...result.outcome, duplicate: true },
    })
    expect(store.getSurfaceVersion(target.id)).toEqual(version)
    expect(store.latestSurfaceCursor()).toBe(before)
    expect(store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path')).toEqual(
      [],
    )
  })
  it('recovers Event delivery and an unreceived named projection before returning the original duplicate', () => {
    let blocked = false
    const { store, surface, invocation, rootDir } = setup({
      surfaceCommitTransport: (spaces) => ({
        prepareSurfaceCommitEvent: (...args) => spaces.prepareSurfaceCommitEvent(...args),
        deliverSurfaceCommitEvent: (prepared) => {
          if (blocked) throw new Error('delivery unavailable')
          spaces.deliverSurfaceCommitEvent(prepared)
        },
        notifySurfaceCommitDelivered: (spaceId) => spaces.notifySurfaceCommitDelivered(spaceId),
      }),
    })
    const projected: CommittedFastActionOutcome[] = []
    store.onFastActionOutcome('flow-recovery', (outcome) => {
      projected.push(outcome)
    })
    blocked = true
    expect(store.invokeSurfaceAction(surface.id, invocation)).toMatchObject({
      path: 'fast',
      outcome: { outcome: 'recovery_pending', intentId: invocation.intentId },
    })
    expect(projected).toEqual([])
    expect(store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path')).toEqual(
      [],
    )
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const restored = new Store({ rootDir })
    stores.push(restored)
    restored.onFastActionOutcome('flow-recovery', (outcome) => {
      projected.push(outcome)
    })
    expect(projected).toHaveLength(1)
    expect(restored.invokeSurfaceAction(surface.id, invocation)).toEqual({
      path: 'fast',
      outcome: { ...projected[0], duplicate: true },
    })
    expect(
      restored.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
    expect(restored.reconcilePendingSurfaceCommits()).toEqual([])
    expect(projected).toHaveLength(1)
  })
  it('isolates a failed projection and retries its receipt without changing acknowledged success', () => {
    const { store, surface, invocation } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detach = store.onFastActionOutcome('flow-projection', () => {
      throw new Error('projection unavailable')
    })
    const first = store.invokeSurfaceAction(surface.id, invocation)
    expect(first).toMatchObject({ path: 'fast', outcome: { outcome: 'committed' } })
    detach()
    const projected: CommittedFastActionOutcome[] = []
    store.onFastActionOutcome('flow-projection', (outcome) => {
      projected.push(outcome)
    })
    expect(projected).toHaveLength(1)
    store.invokeSurfaceAction(surface.id, invocation)
    expect(projected).toHaveLength(1)
    log.mockRestore()
  })
  it('reuses a command Form plan with empty collection defaults and fresh instance data', () => {
    const { store, surface, invocation } = setup()
    store.invokeSurfaceAction(surface.id, invocation)
    const template = templateFromSurface(store.getSurface(surface.id)!, {
      savedBy: 'pin',
      savedAt: '2026-10-01T10:00:00.000Z',
      origin: 'trusted:user',
    })
    expect(JSON.stringify(template)).not.toContain('Bread')
    expect(template.tree.actions?.[0]).not.toHaveProperty('revision')
    const instance = surfaceFromTemplate(template, {
      surfaceId: 'reused',
      spaceId: surface.spaceId,
      updatedAt: '2026-10-01T10:00:00.000Z',
      updatedBy: 'agent',
    })
    expect(instance.state).toEqual({ draft: '', items: [] })
    store.createSurface(instance, 'agent')
    store.invokeSurfaceAction(
      instance.id,
      fastInvocation(store, instance.id, 'form', 'submit', { draft: 'Milk' }),
    )
    expect(store.getSurface(instance.id)?.state['items']).toEqual([
      { id: expect.any(String), label: 'Milk' },
    ])
  })
  it('logs 74 kg through a generic numeric command Form and keeps Stat, Table, and Chart on one canonical collection', () => {
    const { store, surface, rootDir } = setup()
    const weight = store.createSurface(
      SurfaceSchema.parse({
        id: 'weight',
        spaceId: surface.spaceId,
        title: 'Weight Tracker',
        freshness: surface.freshness,
        state: { draft: '', currentKg: 0, measurements: [] },
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            {
              id: 'record-weight',
              type: 'Form',
              props: { label: 'Log weight', submitLabel: 'Log' },
              children: [
                {
                  id: 'measurement',
                  type: 'Input',
                  binding: 'draft',
                  props: { label: 'Weight (kg)', valueType: 'number' },
                },
              ],
              actions: [
                {
                  name: 'submit',
                  path: 'fast',
                  plan: {
                    inputs: { draft: { type: 'number' } },
                    targets: {
                      draft: { type: 'string' },
                      currentKg: { type: 'number' },
                      measurements: {
                        type: 'array',
                        items: {
                          type: 'object',
                          identityKey: 'id',
                          fields: {
                            id: { type: 'string' },
                            date: { type: 'string' },
                            kg: { type: 'number' },
                          },
                        },
                      },
                    },
                    steps: [
                      {
                        op: 'append',
                        target: 'measurements',
                        value: {
                          source: 'object',
                          fields: {
                            id: { source: 'metadata', name: 'recordId' },
                            date: { source: 'metadata', name: 'now' },
                            kg: { source: 'input', name: 'draft' },
                          },
                        },
                      },
                      { op: 'set', target: 'currentKg', value: { source: 'input', name: 'draft' } },
                      { op: 'clear', target: 'draft', value: '' },
                    ],
                  },
                },
              ],
            },
            {
              id: 'current',
              type: 'Stat',
              binding: 'currentKg',
              props: { label: 'Current weight', unit: 'kg' },
            },
            {
              id: 'history',
              type: 'Table',
              binding: 'measurements',
              props: { columns: ['date', 'kg'], emptyText: 'No measurements yet' },
            },
            {
              id: 'trend',
              type: 'Chart',
              binding: 'measurements',
              props: {
                type: 'line',
                xKey: 'date',
                yKey: 'kg',
                label: 'Weight trend',
                xLabel: 'Date',
                yLabel: 'Weight (kg)',
                emptyText: 'No measurements yet',
              },
            },
          ],
        },
      }),
      'agent',
    )
    const invocation = fastInvocation(store, weight.id, 'record-weight', 'submit', { draft: 74 })
    expect(() =>
      store.invokeSurfaceAction(weight.id, { ...invocation, inputs: { draft: '74' } }),
    ).toThrow('owning interaction')
    const result = store.invokeSurfaceAction(weight.id, invocation)
    expect(result).toMatchObject({
      path: 'fast',
      outcome: {
        outcome: 'committed',
        surface: {
          state: {
            currentKg: 74,
            draft: '',
            measurements: [{ id: expect.any(String), date: '2026-10-01T10:00:00.000Z', kg: 74 }],
          },
        },
      },
    })
    expect(
      store.eventLog(weight.spaceId).filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
    const template = templateFromSurface(store.getSurface(weight.id)!, {
      savedBy: 'pin',
      savedAt: '2026-10-01T10:00:00.000Z',
      origin: 'trusted:user',
    })
    expect(
      surfaceFromTemplate(template, {
        surfaceId: 'weight-reused',
        spaceId: weight.spaceId,
        updatedAt: '2026-10-01T10:00:00.000Z',
        updatedBy: 'agent',
      }).state,
    ).toEqual({ draft: '', currentKg: 0, measurements: [] })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const restored = new Store({ rootDir })
    stores.push(restored)
    expect(restored.invokeSurfaceAction(weight.id, invocation)).toMatchObject({
      path: 'fast',
      outcome: { outcome: 'committed', duplicate: true },
    })
    expect(restored.getSurface(weight.id)?.state['measurements']).toEqual([
      { id: expect.any(String), date: '2026-10-01T10:00:00.000Z', kg: 74 },
    ])
  })
  it('commits append and clear once with one matching Event and one canonical outcome', () => {
    const { store, surface, invocation } = setup()
    const events: unknown[] = [],
      outcomes: unknown[] = []
    store.onSurfaceEvent((event) => events.push(event))
    store.onFastActionOutcome('flow-test', (outcome) => {
      outcomes.push(outcome)
    })
    const result = store.invokeSurfaceAction(surface.id, invocation)
    expect(result.path).toBe('fast')
    if (result.path !== 'fast') throw new Error('unexpected Agent path')
    expect(result.outcome).toMatchObject({
      outcome: 'committed',
      duplicate: false,
      actionRevision: invocation.actionRevision,
      intentId: invocation.intentId,
      surface: { state: { draft: '', items: [{ label: 'Bread', id: expect.any(String) }] } },
    })
    expect(
      store.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
  })
  it('replays the original intent after restart and rejects a new stale intent when owning input semantics change', () => {
    const { store, surface, invocation, rootDir } = setup()
    const first = store.invokeSurfaceAction(surface.id, invocation)
    const version = store.getSurfaceVersion(surface.id)!
    store.patchTree(
      surface.id,
      [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/0',
          value: { id: 'draft', type: 'Input', binding: 'draft', props: { label: 'New item' } },
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )
    expect(() =>
      store.invokeSurfaceAction(surface.id, { ...invocation, intentId: randomUUID() }),
    ).toThrow('Action changed')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const restored = new Store({ rootDir })
    stores.push(restored)
    const duplicate = restored.invokeSurfaceAction(surface.id, invocation)
    expect(duplicate).toEqual({
      ...first,
      ...(first.path === 'fast' ? { outcome: { ...first.outcome, duplicate: true } } : {}),
    })
    expect(restored.getSurface(surface.id)?.state['items']).toHaveLength(1)
    expect(
      restored.eventLog(surface.spaceId).filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
  })
})
