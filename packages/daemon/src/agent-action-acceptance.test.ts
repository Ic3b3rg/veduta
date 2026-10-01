import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentActionResultSchema,
  GatewayServerMessageSchema,
  SurfaceSchema,
  type GatewayClientMessage,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewaySocket } from './gateway.ts'
import { buildServer } from './server.ts'

const roots: string[] = []
const apps = new Set<ReturnType<typeof buildServer>['app']>()
afterEach(async () => {
  for (const app of apps) await app.close()
  apps.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function server(dataDir?: string) {
  const root = dataDir ?? mkdtempSync(join(tmpdir(), 'veduta-agent-action-acceptance-'))
  if (!dataDir) roots.push(root)
  const built = buildServer({ dataDir: root })
  apps.add(built.app)
  return { ...built, root }
}

function createActionSurface(built: ReturnType<typeof server>, failed = false) {
  const space = built.store.listSpaces().find((candidate) => candidate.slug === 'health')
  if (!space) throw new Error('Health test Space missing')
  return built.store.createSurface(
    SurfaceSchema.parse({
      id: 'srf-agent-execution',
      spaceId: space.id,
      title: 'Declared action',
      tree: {
        id: 'root',
        type: 'Col',
        children: [
          { id: 'result', type: 'Stat', props: { label: 'Result' }, binding: 'result' },
          { id: 'records', type: 'Table', props: { columns: ['label'] }, binding: 'records' },
          {
            id: 'run',
            type: 'Button',
            props: { label: 'Run declared action' },
            actions: [
              {
                name: failed ? 'fail_demo' : 'complete_demo',
                path: 'agent',
                payload: {
                  request: failed
                    ? 'Try an invalid Agent action demo'
                    : 'Complete the Agent action demo',
                },
              },
            ],
          },
        ],
      },
      state: { result: 'Waiting', records: [] },
      freshness: { updatedAt: '2026-10-01T12:00:00Z', updatedBy: 'agent' },
    }),
    'agent',
  )
}

class RecordingSocket implements GatewaySocket {
  readonly frames: GatewayServerMessage[] = []
  private message: ((raw: Buffer | string) => void) | undefined
  send(raw: string): void {
    this.frames.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }
  on(event: 'message' | 'close', listener: ((raw: Buffer | string) => void) | (() => void)): void {
    if (event === 'message') this.message = listener
  }
  receive(frame: GatewayClientMessage): void {
    this.message?.(JSON.stringify(frame))
  }
}

describe('accepted Agent action execution through the Gateway', () => {
  it('refuses a full Space atomically, preserves retries and recovers capacity independently per Space', async () => {
    const built = server()
    await built.app.ready()
    const surface = createActionSurface(built)
    const capacity = 32
    const queued = Array.from({ length: capacity }, () => {
      const invocation = { nodeId: 'run', name: 'complete_demo', idempotencyKey: randomUUID() }
      const result = built.store.invokeSurfaceAction(surface.id, invocation)
      if (result.path !== 'agent') throw new Error('Agent turn required')
      return { invocation, turn: result.turn }
    })
    const first = queued[0]!
    built.store.claimAgentTurn(first.turn.id)
    const before = built.store.eventLog(surface.spaceId)
    const cursor = built.store.latestSurfaceCursor()
    const state = built.store.getSurface(surface.id)
    expect(built.store.invokeSurfaceAction(surface.id, first.invocation)).toMatchObject({
      turn: { id: first.turn.id, status: 'running' },
    })
    const invocation = { nodeId: 'run', name: 'complete_demo', idempotencyKey: randomUUID() }
    const request = {
      method: 'POST' as const,
      url: `/api/surfaces/${surface.id}/actions`,
      payload: invocation,
    }
    const refused = await Promise.all([built.app.inject(request), built.app.inject(request)])
    for (const response of refused) {
      expect(response.statusCode).toBe(429)
      expect(response.json()).toEqual({
        code: 'agent_queue_full',
        error:
          'This Space already has 32 waiting or running Agent actions. Wait for an action to finish, then try again.',
      })
    }
    const socket = new RecordingSocket()
    built.gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: cursor })
    socket.receive({ type: 'surface.action', surfaceId: surface.id, invocation })
    expect(socket.frames.at(-1)).toMatchObject({ type: 'error', code: 'agent_queue_full' })
    expect(built.store.queuedAgentTurns()).toHaveLength(capacity - 1)
    expect(built.store.eventLog(surface.spaceId)).toEqual(before)
    expect(built.store.latestSurfaceCursor()).toBe(cursor)
    expect(built.store.getSurface(surface.id)).toEqual(state)

    const otherSpace = built.store.spacesEngine.createSpace({ name: 'Independent capacity' })
    const otherSurface = built.store.createSurface(
      { ...surface, id: 'srf-other-queue', spaceId: otherSpace.id },
      'agent',
    )
    const other = await built.app.inject({
      ...request,
      url: `/api/surfaces/${otherSurface.id}/actions`,
      payload: { ...invocation, idempotencyKey: randomUUID() },
    })
    expect(other.statusCode).toBe(200)
    expect(AgentActionResultSchema.parse(other.json()).turn.status).toBe('completed')

    built.store.finishAgentTurn(first.turn.id, { error: 'Disposable interrupted turn' })
    const retried = await Promise.all([built.app.inject(request), built.app.inject(request)])
    expect(retried.map((response) => response.statusCode)).toEqual([200, 200])
    const completed = AgentActionResultSchema.parse(retried[0]!.json())
    expect(AgentActionResultSchema.parse(retried[1]!.json())).toEqual(completed)
    expect(completed.turn.status).toBe('completed')
    expect(built.store.getSurface(surface.id)?.state['records']).toHaveLength(1)
    expect(
      built.store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(capacity + 1)
  })

  it('serializes simultaneous new requests competing for the last Space slot', async () => {
    const built = server()
    await built.app.ready()
    const surface = createActionSurface(built)
    for (let i = 0; i < 31; i++)
      built.store.invokeSurfaceAction(surface.id, {
        nodeId: 'run',
        name: 'complete_demo',
        idempotencyKey: randomUUID(),
      })
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        built.app.inject({
          method: 'POST',
          url: `/api/surfaces/${surface.id}/actions`,
          payload: { nodeId: 'run', name: 'complete_demo', idempotencyKey: randomUUID() },
        }),
      ),
    )
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429])
    expect(built.store.getSurface(surface.id)?.state['records']).toHaveLength(1)
    expect(
      built.store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(32)
  })

  it('executes one canonical effect for concurrent retries, fans it out, and replays it after restart', async () => {
    const first = server()
    const surface = createActionSurface(first)
    const sockets = [new RecordingSocket(), new RecordingSocket()]
    for (const socket of sockets) {
      first.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: first.store.latestSurfaceCursor() })
    }
    const invocation = { nodeId: 'run', name: 'complete_demo', idempotencyKey: randomUUID() }
    const request = {
      method: 'POST' as const,
      url: `/api/surfaces/${surface.id}/actions`,
      payload: invocation,
    }
    const responses = await Promise.all([first.app.inject(request), first.app.inject(request)])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    const [completed, duplicate] = responses.map((response) =>
      AgentActionResultSchema.parse(response.json()),
    )
    expect(duplicate).toEqual(completed)
    expect(completed?.turn).toMatchObject({
      status: 'completed',
      idempotencyKey: invocation.idempotencyKey,
      message: { role: 'assistant', text: expect.stringContaining('Saved Surface') },
    })
    expect(first.store.getSurface(surface.id)?.state).toEqual({
      result: 'Completed',
      records: [{ id: 'agent-demo-1', label: 'Completed' }],
    })
    expect(
      first.store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(1)
    expect(
      first.store
        .eventLog(surface.spaceId)
        .filter(
          (event) =>
            event.type === 'surface.patch_state' && event.payload?.['surfaceId'] === surface.id,
        ),
    ).toHaveLength(1)
    for (const socket of sockets) {
      expect(
        socket.frames.filter(
          (frame) => frame.type === 'surface.patch' && frame.event.patch.surfaceId === surface.id,
        ),
      ).toHaveLength(1)
      const terminal = socket.frames.filter(
        (frame) => frame.type === 'surface.action-turn' && frame.turn.status === 'completed',
      )
      expect(terminal).toHaveLength(1)
      expect(terminal[0]).toEqual({ type: 'surface.action-turn', turn: completed?.turn })
    }
    await first.app.close()
    apps.delete(first.app)
    const restarted = server(first.root)
    const replay = await restarted.app.inject(request)
    expect(AgentActionResultSchema.parse(replay.json())).toEqual(completed)
    expect(restarted.store.getSurface(surface.id)?.state['records']).toHaveLength(1)
    expect(restarted.router.callLog()).toHaveLength(0)
    const conflict = await restarted.app.inject({
      ...request,
      payload: { ...invocation, name: 'different' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' })
  })

  it('returns an atomic failed outcome and never delivers an uncommitted model success', async () => {
    const built = server()
    const surface = createActionSurface(built, true)
    const before = built.store.getSurface(surface.id)
    const version = built.store.getSurfaceVersion(surface.id)
    const cursor = built.store.latestSurfaceCursor()
    const socket = new RecordingSocket()
    built.gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: cursor })
    const response = await built.app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: { nodeId: 'run', name: 'fail_demo', idempotencyKey: randomUUID() },
    })
    expect(response.statusCode).toBe(200)
    const result = AgentActionResultSchema.parse(response.json())
    expect(result.turn).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not saved'),
    })
    expect(built.store.getSurface(surface.id)).toEqual(before)
    expect(built.store.getSurfaceVersion(surface.id)).toEqual(version)
    const relevantPatches = built.store
      .surfaceEventsAfter(cursor)
      .filter((event) => event.kind === 'patch' && event.event.patch.surfaceId === surface.id)
    expect(relevantPatches).toHaveLength(0)
    expect(socket.frames.filter((frame) => frame.type.startsWith('chat.'))).toHaveLength(0)
    expect(
      socket.frames.filter(
        (frame) => frame.type === 'surface.action-turn' && frame.turn.status === 'completed',
      ),
    ).toHaveLength(0)
  })

  it.each(['queued', 'running'] as const)(
    'recovers a %s turn at boot without replaying an uncertain effect',
    async (status) => {
      const first = server()
      await first.app.ready()
      const surface = createActionSurface(first)
      const invocation = { nodeId: 'run', name: 'complete_demo', idempotencyKey: randomUUID() }
      const queued = first.store.invokeSurfaceAction(surface.id, invocation)
      if (queued.path !== 'agent') throw new Error('Agent action required')
      if (status === 'running') first.store.claimAgentTurn(queued.turn.id)
      await first.app.close()
      apps.delete(first.app)
      const restarted = server(first.root)
      await restarted.app.ready()
      await vi.waitFor(() =>
        expect(restarted.store.agentTurn(queued.turn.id)?.status).toBe(
          status === 'queued' ? 'completed' : 'failed',
        ),
      )
      const replay = await restarted.app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: invocation,
      })
      expect(AgentActionResultSchema.parse(replay.json()).turn.status).toBe(
        status === 'queued' ? 'completed' : 'failed',
      )
      expect(restarted.store.getSurface(surface.id)?.state['records']).toHaveLength(
        status === 'queued' ? 1 : 0,
      )
      expect(
        restarted.store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
      ).toHaveLength(1)
    },
  )
})
