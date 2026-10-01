import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'

const roots: string[] = []
const stores: Store[] = []
const now = () => new Date('2026-10-01T13:00:00.000Z')

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const rootDir of roots.splice(0)) rmSync(rootDir, { recursive: true, force: true })
})

function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-agent-lifecycle-'))
  roots.push(rootDir)
  const store = open(rootDir)
  const space = store.spacesEngine.createSpace({ name: 'Review' })
  const surface = store.createSurface(
    SurfaceSchema.parse({
      id: 'srf-review',
      spaceId: space.id,
      title: 'Review preferences',
      tree: {
        id: 'review',
        type: 'Button',
        props: { label: 'Review choices' },
        actions: [{ name: 'review_choices', path: 'agent', payload: { mode: 'summary' } }],
      },
      state: {},
      freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    }),
    'agent',
    { contentOrigin: 'untrusted:template' },
  )
  return { rootDir, store, surface }
}

function open(rootDir: string) {
  const store = new Store({ rootDir, now })
  stores.push(store)
  return store
}

function restart(store: Store, rootDir: string) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
  return open(rootDir)
}

describe('durable Agent Action execution lifecycle (issue #146)', () => {
  it('persists a queued request and its original snapshots and content origin across restart', () => {
    const { rootDir, store, surface } = setup()
    const before = store.snapshot()
    const result = store.invokeSurfaceAction(surface.id, {
      nodeId: 'review',
      name: 'review_choices',
      idempotencyKey: 'review-intent',
    })
    if (result.path !== 'agent') throw new Error('expected an Agent Action')

    expect(result.turn).toMatchObject({
      status: 'queued',
      idempotencyKey: 'review-intent',
      contentOrigin: 'untrusted:template',
      surface,
      atom: surface.tree,
      payload: { mode: 'summary' },
    })
    expect(store.snapshot()).toEqual(before)
    const requested = store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path')
    expect(requested).toHaveLength(1)
    expect(requested[0]?.origin).toBe('untrusted:template')

    const restored = restart(store, rootDir)
    expect(restored.agentTurns()).toEqual([result.turn])
    expect(
      restored.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toEqual(requested)
  })

  it('claims a queued request once and durably retains its completed assistant outcome', () => {
    const { rootDir, store, surface } = setup()
    const result = store.invokeSurfaceAction(surface.id, {
      nodeId: 'review',
      name: 'review_choices',
      idempotencyKey: 'review-intent',
    })
    if (result.path !== 'agent') throw new Error('expected an Agent Action')
    const eventsBefore = store.eventLog(surface.spaceId)

    expect(store.queuedAgentTurns().map((turn) => turn.id)).toEqual([result.turn.id])
    expect(store.claimAgentTurn(result.turn.id)).toMatchObject({ status: 'running' })
    expect(store.claimAgentTurn(result.turn.id)).toBeUndefined()
    expect(store.queuedAgentTurns()).toEqual([])
    const message = { role: 'assistant' as const, text: 'The review is ready.' }
    const surfaceCursor = store.latestSurfaceCursor()
    const completed = store.finishAgentTurn(result.turn.id, { message, surfaceCursor })
    expect(completed).toMatchObject({ status: 'completed', message, surfaceCursor })
    expect(store.finishAgentTurn(result.turn.id, { error: 'late failure' })).toEqual(completed)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)

    const restored = restart(store, rootDir)
    expect(restored.agentTurn(result.turn.id)).toEqual(completed)
    expect(restored.claimAgentTurn(result.turn.id)).toBeUndefined()
    expect(restored.queuedAgentTurns()).toEqual([])
    expect(restored.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })

  it('replays one global request identity before revalidating a changed or removed declaration', () => {
    const { rootDir, store, surface } = setup()
    const invocation = {
      nodeId: 'review',
      name: 'review_choices',
      idempotencyKey: 'review-intent',
    }
    const first = store.invokeSurfaceAction(surface.id, invocation)
    if (first.path !== 'agent') throw new Error('expected an Agent Action')
    expect(store.invokeSurfaceAction(surface.id, invocation)).toEqual(first)
    const version = store.getSurfaceVersion(surface.id)
    if (!version) throw new Error('expected a Surface version')
    store.patchTree(
      surface.id,
      [
        {
          target: 'tree',
          op: 'replace',
          path: '',
          value: { id: 'review', type: 'Caption', props: { text: 'Review complete' } },
        },
      ],
      { updatedBy: 'agent', expectedTreeVersion: version.treeVersion },
    )
    store.claimAgentTurn(first.turn.id)
    const completed = store.finishAgentTurn(first.turn.id, {
      message: { role: 'assistant', text: 'The review is ready.' },
      surfaceCursor: store.latestSurfaceCursor(),
    })
    expect(store.invokeSurfaceAction(surface.id, invocation)).toEqual({
      path: 'agent',
      turn: completed,
    })
    expect(store.agentTurns()).toHaveLength(1)
    expect(
      store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(1)

    const restored = restart(store, rootDir)
    expect(restored.invokeSurfaceAction(surface.id, invocation)).toEqual({
      path: 'agent',
      turn: completed,
    })
    expect(restored.agentTurns()).toHaveLength(1)
    expect(
      restored.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(1)
  })

  it('fails an interrupted running request on boot without rerunning it or duplicating its Event', () => {
    const { rootDir, store, surface } = setup()
    const invocation = {
      nodeId: 'review',
      name: 'review_choices',
      idempotencyKey: 'interrupted-review',
    }
    const result = store.invokeSurfaceAction(surface.id, invocation)
    if (result.path !== 'agent') throw new Error('expected an Agent Action')
    store.claimAgentTurn(result.turn.id)
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)

    const restored = restart(store, rootDir)
    const failed = restored.agentTurn(result.turn.id)
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Agent action execution was interrupted; inspect canonical outcome before retrying',
    })
    expect(restored.queuedAgentTurns()).toEqual([])
    expect(restored.claimAgentTurn(result.turn.id)).toBeUndefined()
    expect(restored.invokeSurfaceAction(surface.id, invocation)).toEqual({
      path: 'agent',
      turn: failed,
    })
    expect(restored.snapshot()).toEqual(before)
    expect(restored.eventLog(surface.spaceId)).toEqual(eventsBefore)
    expect(restored.interruptAgentTurns()).toEqual([])
  })

  it.each([
    { label: 'Surface', surfaceId: 'srf-unrelated' },
    { label: 'Atom', nodeId: 'unrelated' },
    { label: 'Action', name: 'unrelated' },
    { label: 'payload', payload: { mode: 'summary' } },
  ])(
    'rejects a reused global identity with another $label before any new queue or Event',
    ({ label: _label, surfaceId, ...changed }) => {
      const { store, surface } = setup()
      const invocation = {
        nodeId: 'review',
        name: 'review_choices',
        idempotencyKey: 'review-intent',
      }
      store.invokeSurfaceAction(surface.id, invocation)
      const turnsBefore = store.agentTurns()
      const snapshotBefore = store.snapshot()
      const eventsBefore = store.eventLog(surface.spaceId)

      expect(() =>
        store.invokeSurfaceAction(surfaceId ?? surface.id, { ...invocation, ...changed }),
      ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
      expect(store.agentTurns()).toEqual(turnsBefore)
      expect(store.snapshot()).toEqual(snapshotBefore)
      expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
    },
  )
})
