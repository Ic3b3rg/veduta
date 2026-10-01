import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySurfacePatchEvent,
  CommittedFastActionOutcomeSchema,
  GatewayServerMessageSchema,
  SurfaceSnapshotSchema,
  type ActionScalarSpec,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type JsonObject,
  type JsonValue,
  type Surface,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { GatewaySocket } from './gateway.ts'
import { buildServer } from './server.ts'
import type { SpaceEvent } from './space-events.ts'
import { fastInvocation } from './surface-action-test-fixtures.ts'

const now = () => new Date('2026-10-01T10:00:00.000Z')
const apps: ReturnType<typeof buildServer>['app'][] = []
const roots: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const rootDir of roots.splice(0)) rmSync(rootDir, { recursive: true, force: true })
})

function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-control-acceptance-'))
  roots.push(rootDir)
  const server = buildServer({ dataDir: rootDir, now })
  apps.push(server.app)
  const space = server.store.spacesEngine.createSpace({ name: 'Choices' })
  return { ...server, spaceId: space.id }
}

type ControlFamily = 'Button' | 'Checkbox' | 'Select' | 'RadioGroup' | 'DatePicker'
interface ControlCase {
  type: ControlFamily
  name: string
  binding: string
  props: JsonObject
  spec: ActionScalarSpec
  initial: JsonValue
  next: JsonValue
}
const controls: ControlCase[] = [
  {
    type: 'Button',
    name: 'press',
    binding: 'applied',
    props: { label: 'Apply choice' },
    spec: { type: 'boolean' },
    initial: false,
    next: true,
  },
  {
    type: 'Checkbox',
    name: 'toggle',
    binding: 'enabled',
    props: { label: 'Enable choice' },
    spec: { type: 'boolean' },
    initial: false,
    next: true,
  },
  {
    type: 'Select',
    name: 'change',
    binding: 'status',
    props: {
      label: 'Status',
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Ready', value: 'ready' },
      ],
    },
    spec: { type: 'string', enum: ['draft', 'ready'] },
    initial: 'draft',
    next: 'ready',
  },
  {
    type: 'RadioGroup',
    name: 'change',
    binding: 'mode',
    props: {
      label: 'Mode',
      options: [
        { label: 'Quiet', value: 'quiet' },
        { label: 'Active', value: 'active' },
      ],
    },
    spec: { type: 'string', enum: ['quiet', 'active'] },
    initial: 'quiet',
    next: 'active',
  },
  {
    type: 'DatePicker',
    name: 'change',
    binding: 'day',
    props: { label: 'Review date' },
    spec: { type: 'string' },
    initial: '2026-10-01',
    next: '2026-10-02',
  },
]

function controlSurface(spaceId: string, control: ControlCase): Surface {
  return {
    id: 'srf-control-acceptance',
    spaceId,
    title: 'Choices',
    presentation: 'standard',
    pinned: false,
    pinnable: true,
    freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    state: { [control.binding]: control.initial },
    tree: {
      id: 'control',
      type: control.type,
      ...(control.type === 'Button' ? {} : { binding: control.binding }),
      props: control.props,
      actions: [
        {
          name: control.name,
          path: 'fast',
          plan: {
            inputs: control.type === 'Button' ? {} : { value: control.spec },
            targets: { [control.binding]: control.spec },
            steps: [
              {
                op: 'set',
                target: control.binding,
                value:
                  control.type === 'Button'
                    ? { source: 'literal', value: control.next }
                    : { source: 'input', name: 'value' },
              },
            ],
          },
        },
      ],
    },
  }
}

function agentButtonSurface(spaceId: string): Surface {
  return {
    id: 'srf-control-acceptance',
    spaceId,
    title: 'Review choices',
    presentation: 'standard',
    pinned: false,
    pinnable: true,
    freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    state: {},
    tree: {
      id: 'review',
      type: 'Button',
      props: { label: 'Review choices' },
      actions: [{ name: 'review_choices', path: 'agent', payload: { mode: 'summary', limit: 3 } }],
    },
  }
}

class RecordingSocket implements GatewaySocket {
  readonly sent: GatewayServerMessage[] = []
  private messageHandler: ((raw: Buffer | string) => void) | undefined
  private closeHandler: (() => void) | undefined

  send(data: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(data)))
  }

  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void): void {
    if (event === 'message') this.messageHandler = handler
    else this.closeHandler = () => handler('')
  }

  receive(frame: GatewayClientMessage): void {
    this.messageHandler?.(JSON.stringify(frame))
  }

  close(): void {
    this.closeHandler?.()
  }

  patches(surfaceId: string) {
    return this.sent
      .filter((frame) => frame.type === 'surface.patch')
      .filter((frame) => frame.event.patch.surfaceId === surfaceId)
  }
}

async function snapshot(app: ReturnType<typeof buildServer>['app']) {
  const response = await app.inject({ method: 'GET', url: '/api/spaces' })
  expect(response.statusCode).toBe(200)
  return SurfaceSnapshotSchema.parse(response.json())
}

async function events(app: ReturnType<typeof buildServer>['app'], spaceId: string) {
  const response = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/events` })
  expect(response.statusCode).toBe(200)
  return response.json<{ events: SpaceEvent[] }>().events
}

function selectionSurface(spaceId: string): Surface {
  return {
    id: 'srf-control-acceptance',
    spaceId,
    title: 'Review state',
    presentation: 'standard',
    pinned: false,
    pinnable: true,
    freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    state: { status: 'draft' },
    tree: {
      id: 'status',
      type: 'Select',
      binding: 'status',
      props: { label: 'Status' },
      actions: [
        {
          name: 'change',
          path: 'fast',
          plan: {
            inputs: { value: { type: 'string' } },
            targets: { status: { type: 'string' } },
            steps: [{ op: 'set', target: 'status', value: { source: 'input', name: 'value' } }],
          },
        },
      ],
    },
  }
}

describe('strict control acceptance through the Gateway (issue #146)', () => {
  it('rejects a Select without options before any Surface or Space Event is persisted', async () => {
    const { app, store, spaceId } = setup()
    const snapshotBefore = SurfaceSnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/spaces' })).json(),
    )
    const eventsBefore = (
      await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/events` })
    ).json()

    expect(() => store.createSurface(selectionSurface(spaceId), 'agent')).toThrow()

    expect(
      SurfaceSnapshotSchema.parse((await app.inject({ method: 'GET', url: '/api/spaces' })).json()),
    ).toEqual(snapshotBefore)
    expect(
      (await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/events` })).json(),
    ).toEqual(eventsBefore)
  })

  it.each(controls)(
    '$type commits its typed value once and sends the same canonical result to every client',
    async (control) => {
      const { app, store, gateway, spaceId } = setup()
      const surface = store.createSurface(controlSurface(spaceId, control), 'agent')
      const before = await snapshot(app)
      const first = new RecordingSocket()
      const second = new RecordingSocket()
      for (const socket of [first, second]) {
        gateway.connect(socket)
        socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })
      }
      const invocation = fastInvocation(
        store,
        surface.id,
        'control',
        control.name,
        control.type === 'Button' ? {} : { value: control.next },
      )
      const request = {
        method: 'POST' as const,
        url: `/api/surfaces/${surface.id}/actions`,
        payload: invocation,
      }

      const response = await app.inject(request)
      expect(response.statusCode).toBe(200)
      const outcome = CommittedFastActionOutcomeSchema.parse(response.json())
      expect(outcome.surface.state).toEqual({ [control.binding]: control.next })
      expect(outcome.duplicate).toBe(false)
      const mutations = (await events(app, spaceId)).filter((event) => event.type === 'fast_path')
      expect(mutations).toHaveLength(1)
      expect(mutations[0]).toMatchObject({
        origin: 'trusted:user',
        payload: {
          surfaceId: surface.id,
          nodeId: 'control',
          actionName: control.name,
          intentId: invocation.intentId,
          surfaceCommitId: outcome.surfaceCommitId,
          targets: [control.binding],
        },
      })

      const after = await snapshot(app)
      expect(after.surfaceCursor).toBe(outcome.surfaceCursor)
      const canonical = after.spaces
        .flatMap((space) => space.surfaces)
        .find((candidate) => candidate.id === surface.id)
      expect(canonical).toEqual(outcome.surface)
      for (const socket of [first, second]) {
        const patches = socket.patches(surface.id)
        expect(patches).toHaveLength(1)
        const patch = patches[0]!
        expect(patch.event.actionOutcome).toMatchObject({
          intentId: invocation.intentId,
          actionName: control.name,
          actionRevision: invocation.actionRevision,
          surfaceCommitId: outcome.surfaceCommitId,
        })
        expect(applySurfacePatchEvent(surface, patch.event)).toEqual(canonical)
      }
      expect(first.patches(surface.id)).toEqual(second.patches(surface.id))

      const retry = await app.inject(request)
      expect(retry.statusCode).toBe(200)
      expect(CommittedFastActionOutcomeSchema.parse(retry.json())).toEqual({
        ...outcome,
        duplicate: true,
      })
      expect(await snapshot(app)).toEqual(after)
      expect((await events(app, spaceId)).filter((event) => event.type === 'fast_path')).toEqual(
        mutations,
      )
      expect(first.patches(surface.id)).toHaveLength(1)
      expect(second.patches(surface.id)).toHaveLength(1)
      expect(store.llmCallCount()).toBe(0)
    },
  )

  it('rejects an Agent Button payload that adds undeclared fields before queueing or appending an Event', async () => {
    const { app, store, spaceId } = setup()
    const surface = store.createSurface(agentButtonSurface(spaceId), 'agent')
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)
    const response = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: {
        nodeId: 'review',
        name: 'review_choices',
        payload: { mode: 'summary', limit: 3, unrelated: true },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'invalid_payload' })
    expect(store.agentTurns()).toEqual([])
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)
  })

  it('refuses a disabled Agent Button before queueing or appending an Event', async () => {
    const { app, store, spaceId } = setup()
    const candidate = agentButtonSurface(spaceId)
    candidate.tree.props = { ...candidate.tree.props, disabled: true }
    const surface = store.createSurface(candidate, 'agent')
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)
    const response = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: { nodeId: 'review', name: 'review_choices' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ code: 'disabled_control' })
    expect(store.agentTurns()).toEqual([])
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)
  })
})
