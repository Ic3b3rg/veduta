import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Store, type StoreOptions } from './store.ts'

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

function open(rootDir: string, options: Pick<StoreOptions, 'surfaceCommitTransport'> = {}) {
  const store = new Store({ rootDir, now, ...options })
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
    expect(requested[0]).toMatchObject({
      origin: 'untrusted:template',
      payload: { agentTurnId: result.turn.id, idempotencyKey: 'review-intent' },
    })

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

  it('correlates a legacy invocation without adding an absent retry key to its Event', () => {
    const { store, surface } = setup()
    const result = store.invokeSurfaceAction(surface.id, {
      nodeId: 'review',
      name: 'review_choices',
    })
    if (result.path !== 'agent') throw new Error('expected an Agent Action')
    const requested = store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path')
    expect(requested).toHaveLength(1)
    expect(requested[0]?.payload?.['agentTurnId']).toBe(result.turn.id)
    expect(requested[0]?.payload).not.toHaveProperty('idempotencyKey')
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

  it('keeps an undelivered request queued until its Space Event can be made durable', () => {
    const { rootDir, store, surface } = setup()
    const before = store.snapshot()
    store.close()
    stores.splice(stores.indexOf(store), 1)
    let deliver = false
    const withFault = open(rootDir, {
      surfaceCommitTransport: (spaces) => ({
        prepareSurfaceCommitEvent: (...args) => spaces.prepareSurfaceCommitEvent(...args),
        deliverSurfaceCommitEvent: (prepared) => {
          if (!deliver) throw new Error('injected Event delivery failure')
          spaces.deliverSurfaceCommitEvent(prepared)
        },
        notifySurfaceCommitDelivered: (spaceId) => spaces.notifySurfaceCommitDelivered(spaceId),
      }),
    })
    const invocation = {
      nodeId: 'review',
      name: 'review_choices',
      idempotencyKey: 'pending-review',
    }
    expect(() => withFault.invokeSurfaceAction(surface.id, invocation)).toThrowError(
      expect.objectContaining({ outcome: 'recovery_pending' }),
    )
    const queued = withFault.queuedAgentTurns()[0]
    if (!queued) throw new Error('expected a durable queued request')
    expect(() => withFault.claimAgentTurn(queued.id)).toThrowError(
      expect.objectContaining({ outcome: 'recovery_pending' }),
    )
    expect(withFault.agentTurn(queued.id)?.status).toBe('queued')
    expect(
      withFault.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toEqual([])
    expect(withFault.snapshot()).toEqual(before)

    deliver = true
    expect(withFault.claimAgentTurn(queued.id)?.status).toBe('running')
    const requested = withFault
      .eventLog(surface.spaceId)
      .filter((event) => event.type === 'agent_path')
    expect(requested).toHaveLength(1)
    expect(withFault.invokeSurfaceAction(surface.id, invocation)).toMatchObject({
      path: 'agent',
      turn: { id: queued.id, status: 'running' },
    })
    expect(withFault.agentTurns()).toHaveLength(1)
    expect(
      withFault.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toEqual(requested)
  })

  it('exposes a historical queue row as failed without treating its missing provenance as trusted', () => {
    const { rootDir, store, surface } = setup()
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    // Prepare the pre-lifecycle persisted format; assertions remain through the public Store.
    const legacy = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    legacy.exec(`
      drop table agent_turns;
      create table agent_turns (
        id integer primary key autoincrement, at text not null, space_id text not null,
        surface_id text not null, atom_id text not null, action_name text not null,
        payload_json text not null, surface_json text not null, atom_json text not null
      );
    `)
    legacy
      .prepare(
        `insert into agent_turns
      (at, space_id, surface_id, atom_id, action_name, payload_json, surface_json, atom_json)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now().toISOString(),
        surface.spaceId,
        surface.id,
        'review',
        'review_choices',
        JSON.stringify({ mode: 'summary' }),
        JSON.stringify(surface),
        JSON.stringify(surface.tree),
      )
    legacy.close()

    const restored = open(rootDir)
    expect(restored.agentTurns()).toHaveLength(1)
    expect(restored.agentTurns()[0]).toMatchObject({
      status: 'failed',
      contentOrigin: 'untrusted:legacy-action',
      error:
        'Recorded before durable execution tracking; inspect canonical outcome before retrying',
    })
    expect(restored.queuedAgentTurns()).toEqual([])
    expect(restored.claimAgentTurn('agent-turn-1')).toBeUndefined()
    expect(restored.snapshot()).toEqual(before)
    expect(restored.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })

  it('rejects a stored Atom snapshot that belongs to another request before it can be claimed', () => {
    const { rootDir, store, surface } = setup()
    const requested = store.invokeSurfaceAction(surface.id, {
      nodeId: 'review',
      name: 'review_choices',
    })
    if (requested.path !== 'agent') throw new Error('expected an Agent Action')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const fixture = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    fixture
      .prepare('update agent_turns set atom_json = ?')
      .run(JSON.stringify({ ...surface.tree, id: 'unrelated' }))
    fixture.close()

    const restored = open(rootDir)
    expect(() => restored.claimAgentTurn(requested.turn.id)).toThrowError(
      'Agent Action snapshot does not match its stored request identity',
    )
    expect(
      restored.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(1)
  })

  it('does not allow a stored receipt to override a queued execution status', () => {
    const { rootDir, store, surface } = setup()
    const requested = store.invokeSurfaceAction(surface.id, {
      nodeId: 'review',
      name: 'review_choices',
    })
    if (requested.path !== 'agent') throw new Error('expected an Agent Action')
    const surfaceCursor = store.latestSurfaceCursor()
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const fixture = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    fixture.prepare('update agent_turns set result_json = ?').run(
      JSON.stringify({
        status: 'completed',
        message: { role: 'assistant', text: 'False completion' },
        surfaceCursor,
      }),
    )
    fixture.close()
    const restored = open(rootDir)
    expect(() => restored.agentTurn(requested.turn.id)).toThrowError(
      'Agent Action receipt cannot override its stored execution status or identity',
    )
  })
})
