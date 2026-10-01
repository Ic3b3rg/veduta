import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySurfacePatchEvent,
  CommittedFastActionOutcomeSchema,
  GatewayServerMessageSchema,
  SurfaceSnapshotSchema,
  SurfaceSchema,
  type ActionScalarSpec,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type JsonObject,
  type JsonValue,
  type Surface,
} from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatLoop, type ChatLoop } from './chat-loop.ts'
import { createFakeProvider, fakeText, fakeTextAndToolCall } from './fake-provider.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { GatewayHub, type GatewaySocket } from './gateway.ts'
import { ModelRouter } from './model-routing.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import { buildServer } from './server.ts'
import type { SpaceEvent } from './space-events.ts'
import { fastInvocation } from './surface-action-test-fixtures.ts'
import { TemplateEngine } from './template-engine.ts'

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
  return { ...server, spaceId: space.id, rootDir }
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

function controlCase(type: ControlFamily): ControlCase {
  const control = controls.find((candidate) => candidate.type === type)
  if (!control) throw new Error(`missing control fixture: ${type}`)
  return control
}

function controlSurface(spaceId: string, control: ControlCase): Surface {
  return SurfaceSchema.parse({
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
  })
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
  return fromPartial<Surface>({
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
  })
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

  it.each<{ type: ControlFamily; inputs: JsonObject }>([
    { type: 'Button', inputs: { value: true } },
    { type: 'Checkbox', inputs: { value: 'true' } },
    { type: 'Select', inputs: { value: 'unoffered' } },
    { type: 'RadioGroup', inputs: { value: 'unoffered' } },
    { type: 'DatePicker', inputs: { value: '2026-02-29' } },
  ])(
    '$type rejects an invalid next value without writing and accepts a corrected interaction',
    async ({ type, inputs }) => {
      const { app, store, gateway, spaceId } = setup()
      const control = controlCase(type)
      const surface = store.createSurface(controlSurface(spaceId, control), 'agent')
      const before = await snapshot(app)
      const eventsBefore = await events(app, spaceId)
      const socket = new RecordingSocket()
      gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })

      const rejected = await app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: fastInvocation(store, surface.id, 'control', control.name, inputs),
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json()).toMatchObject({ code: 'invalid_payload' })
      expect(await snapshot(app)).toEqual(before)
      expect(await events(app, spaceId)).toEqual(eventsBefore)
      expect(socket.patches(surface.id)).toEqual([])

      const corrected = await app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: fastInvocation(
          store,
          surface.id,
          'control',
          control.name,
          type === 'Button' ? {} : { value: control.next },
        ),
      })
      expect(corrected.statusCode).toBe(200)
      expect(CommittedFastActionOutcomeSchema.parse(corrected.json()).surface.state).toEqual({
        [control.binding]: control.next,
      })
      expect(
        (await events(app, spaceId)).filter((event) => event.type === 'fast_path'),
      ).toHaveLength(1)
      expect(socket.patches(surface.id)).toHaveLength(1)
    },
  )

  it.each(controls)(
    '$type refuses disabled fast interactions before writing or broadcasting',
    async (control) => {
      const { app, store, gateway, spaceId } = setup()
      const candidate = controlSurface(spaceId, control)
      candidate.tree.props = { ...candidate.tree.props, disabled: true }
      const surface = store.createSurface(candidate, 'agent')
      const before = await snapshot(app)
      const eventsBefore = await events(app, spaceId)
      const socket = new RecordingSocket()
      gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })

      const response = await app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: fastInvocation(
          store,
          surface.id,
          'control',
          control.name,
          control.type === 'Button' ? {} : { value: control.next },
        ),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'invalid_payload' })
      expect(await snapshot(app)).toEqual(before)
      expect(await events(app, spaceId)).toEqual(eventsBefore)
      expect(socket.patches(surface.id)).toEqual([])
      expect(store.agentTurns()).toEqual([])
    },
  )

  it('rejects a Select plan that overwrites its submitted value before persistence', async () => {
    const { app, store, spaceId } = setup()
    const candidate = controlSurface(spaceId, controlCase('Select'))
    const action = candidate.tree.actions?.[0]
    if (action?.path !== 'fast') throw new Error('fast fixture required')
    action.plan.steps.push({
      op: 'set',
      target: 'status',
      value: { source: 'literal', value: 'draft' },
    })
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)

    expect(() => store.createSurface(candidate, 'agent')).toThrow()
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)
  })

  it('commits the offered selection and additional batch targets together', async () => {
    const { app, store, gateway, spaceId } = setup()
    const candidate = controlSurface(spaceId, controlCase('Select'))
    candidate.state['reviewed'] = false
    const action = candidate.tree.actions?.[0]
    if (action?.path !== 'fast') throw new Error('fast fixture required')
    action.plan.targets['reviewed'] = { type: 'boolean' }
    action.plan.steps.push({
      op: 'set',
      target: 'reviewed',
      value: { source: 'literal', value: true },
    })
    const surface = store.createSurface(candidate, 'agent')
    const before = await snapshot(app)
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })

    const response = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: fastInvocation(store, surface.id, 'control', 'change', { value: 'ready' }),
    })

    expect(response.statusCode).toBe(200)
    const outcome = CommittedFastActionOutcomeSchema.parse(response.json())
    expect(outcome.surface.state).toEqual({ status: 'ready', reviewed: true })
    const mutations = (await events(app, spaceId)).filter((event) => event.type === 'fast_path')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ payload: { targets: ['status', 'reviewed'] } })
    expect(socket.patches(surface.id)).toHaveLength(1)
    expect(applySurfacePatchEvent(surface, socket.patches(surface.id)[0]!.event)).toEqual(
      outcome.surface,
    )
  })

  it.each<{ label: string; type: ControlFamily; change: (surface: Surface) => void }>([
    {
      label: 'duplicate Select option values',
      type: 'Select',
      change: (surface) => {
        surface.tree.props = {
          label: 'Status',
          options: [
            { label: 'Draft', value: 'draft' },
            { label: 'Another draft', value: 'draft' },
          ],
        }
      },
    },
    {
      label: 'RadioGroup options without labels',
      type: 'RadioGroup',
      change: (surface) => {
        surface.tree.props = { label: 'Mode', options: [{ value: 'quiet' }, { value: 'active' }] }
      },
    },
    {
      label: 'an inert Button',
      type: 'Button',
      change: (surface) => {
        delete surface.tree.actions
      },
    },
    {
      label: 'an unresolved Checkbox Action',
      type: 'Checkbox',
      change: (surface) => {
        const action = surface.tree.actions?.[0]
        if (!action) throw new Error('Action fixture required')
        action.name = 'choose'
      },
    },
    {
      label: 'a missing selection binding',
      type: 'Select',
      change: (surface) => {
        delete surface.tree.binding
      },
    },
    {
      label: 'an unoffered canonical selection',
      type: 'Select',
      change: (surface) => {
        surface.state['status'] = 'unoffered'
      },
    },
    {
      label: 'an impossible canonical calendar date',
      type: 'DatePicker',
      change: (surface) => {
        surface.state['day'] = '2026-02-29'
      },
    },
    {
      label: 'an empty date without allowEmpty',
      type: 'DatePicker',
      change: (surface) => {
        surface.state['day'] = ''
      },
    },
  ])('rejects $label before persisting or appending an Event', async ({ type, change }) => {
    const { app, store, spaceId } = setup()
    const candidate = controlSurface(spaceId, controlCase(type))
    change(candidate)
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)

    expect(() => store.createSurface(candidate, 'agent')).toThrow()
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)
  })

  it.each(['', '2026-10-2', '2026-13-01', '0000-01-01'])(
    'rejects invalid DatePicker input %j before persisting',
    async (value) => {
      const { app, store, spaceId } = setup()
      const surface = store.createSurface(
        controlSurface(spaceId, controlCase('DatePicker')),
        'agent',
      )
      const before = await snapshot(app)
      const eventsBefore = await events(app, spaceId)

      const response = await app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: fastInvocation(store, surface.id, 'control', 'change', { value }),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'invalid_payload' })
      expect(await snapshot(app)).toEqual(before)
      expect(await events(app, spaceId)).toEqual(eventsBefore)
    },
  )

  it('accepts a real leap day and an explicitly permitted empty date as canonical strings', async () => {
    const { app, store, spaceId } = setup()
    const candidate = controlSurface(spaceId, controlCase('DatePicker'))
    candidate.tree.props = { ...candidate.tree.props, allowEmpty: true }
    const surface = store.createSurface(candidate, 'agent')

    for (const value of ['2028-02-29', '']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/surfaces/${surface.id}/actions`,
        payload: fastInvocation(store, surface.id, 'control', 'change', { value }),
      })
      expect(response.statusCode).toBe(200)
      expect(CommittedFastActionOutcomeSchema.parse(response.json()).surface.state).toEqual({
        day: value,
      })
      const canonical = (await snapshot(app)).spaces
        .flatMap((space) => space.surfaces)
        .find((entry) => entry.id === surface.id)
      expect(canonical?.state).toEqual({ day: value })
    }
    expect((await events(app, spaceId)).filter((event) => event.type === 'fast_path')).toHaveLength(
      2,
    )
  })

  it('rejects an undeclared Button Action before persistence and permits its declared Action', async () => {
    const { app, store, spaceId } = setup()
    const surface = store.createSurface(controlSurface(spaceId, controlCase('Button')), 'agent')
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)
    const invocation = fastInvocation(store, surface.id, 'control', 'press')

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: { ...invocation, name: 'undeclared' },
    })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json()).toMatchObject({ code: 'undeclared_action' })
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)

    const corrected = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: invocation,
    })
    expect(corrected.statusCode).toBe(200)
    expect(CommittedFastActionOutcomeSchema.parse(corrected.json()).surface.state).toEqual({
      applied: true,
    })
    expect((await events(app, spaceId)).filter((event) => event.type === 'fast_path')).toHaveLength(
      1,
    )
  })

  it.each([
    { label: 'extra fields', payload: { mode: 'summary', limit: 3, unrelated: true } },
    { label: 'missing fields', payload: { mode: 'summary' } },
    { label: 'changed values', payload: { mode: 'full', limit: 3 } },
    { label: 'changed types', payload: { mode: 'summary', limit: '3' } },
    { label: 'an empty object', payload: {} },
  ])(
    'rejects an Agent Button payload with $label before queueing or appending an Event',
    async ({ payload }) => {
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
          payload,
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'invalid_payload' })
      expect(store.agentTurns()).toEqual([])
      expect(await snapshot(app)).toEqual(before)
      expect(await events(app, spaceId)).toEqual(eventsBefore)
    },
  )

  it.each([
    { label: 'omitted payload', payload: undefined },
    {
      label: 'an exactly matching payload in another key order',
      payload: { limit: 3, mode: 'summary' },
    },
  ])('executes only the declared Agent Button payload with $label', async ({ payload }) => {
    const { app, store, gateway, spaceId } = setup()
    const surface = store.createSurface(agentButtonSurface(spaceId), 'agent')
    const before = await snapshot(app)
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })

    const response = await app.inject({
      method: 'POST',
      url: `/api/surfaces/${surface.id}/actions`,
      payload: {
        nodeId: 'review',
        name: 'review_choices',
        ...(payload === undefined ? {} : { payload }),
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      turn: {
        status: 'completed',
        surfaceCursor: store.latestSurfaceCursor(),
        message: { role: 'assistant', text: expect.any(String) },
      },
    })
    expect(response.json().turn).not.toHaveProperty('payload')
    expect(store.agentTurns()).toHaveLength(1)
    expect(store.agentTurns()[0]).toMatchObject({
      surfaceId: surface.id,
      atomId: 'review',
      actionName: 'review_choices',
      payload: { mode: 'summary', limit: 3 },
    })
    const requested = (await events(app, spaceId)).filter((event) => event.type === 'agent_path')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      origin: 'trusted:user',
      payload: {
        surfaceId: surface.id,
        atomId: 'review',
        actionName: 'review_choices',
        payload: { mode: 'summary', limit: 3 },
      },
    })
    expect(await snapshot(app)).toEqual(before)
    expect(socket.patches(surface.id)).toEqual([])
  })

  it('rejects an undeclared Agent Button payload over the Gateway and permits a corrected retry', async () => {
    const { app, store, gateway, spaceId } = setup()
    const surface = store.createSurface(agentButtonSurface(spaceId), 'agent')
    const before = await snapshot(app)
    const eventsBefore = await events(app, spaceId)
    const socket = new RecordingSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: before.surfaceCursor })
    socket.receive({
      type: 'surface.action',
      surfaceId: surface.id,
      invocation: { nodeId: 'review', name: 'review_choices', payload: { limit: 9 } },
    })

    expect(socket.sent.filter((frame) => frame.type === 'error')).toEqual([
      {
        type: 'error',
        code: 'invalid_payload',
        error: 'Button payload must exactly match its declared Action payload',
      },
    ])
    expect(store.agentTurns()).toEqual([])
    expect(await snapshot(app)).toEqual(before)
    expect(await events(app, spaceId)).toEqual(eventsBefore)

    socket.receive({
      type: 'surface.action',
      surfaceId: surface.id,
      invocation: { nodeId: 'review', name: 'review_choices' },
    })
    expect(store.agentTurns()).toHaveLength(1)
    expect(store.agentTurns()[0]?.payload).toEqual({ mode: 'summary', limit: 3 })
    expect(
      (await events(app, spaceId)).filter((event) => event.type === 'agent_path'),
    ).toHaveLength(1)
    expect(socket.patches(surface.id)).toEqual([])
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

  it.each(['missing options', 'an impossible date'])(
    'reports authoring failure for %s without a false Chat success claim',
    async (invalid) => {
      const { app, store, spaceId, rootDir } = setup()
      const before = await snapshot(app)
      const eventsBefore = await events(app, spaceId)
      const candidate =
        invalid === 'missing options'
          ? selectionSurface(spaceId)
          : controlSurface(spaceId, controlCase('DatePicker'))
      if (invalid === 'an impossible date') candidate.state['day'] = '2026-02-29'
      const fake = createFakeProvider()
      const router = new ModelRouter({
        config: {
          tiers: {
            reasoning: [{ provider: 'fake', modelId: 'fake-model' }],
            triage: [{ provider: 'fake', modelId: 'fake-model' }],
          },
          providerKeys: {},
          connectionKeys: {},
          dailyCapUsd: { triage: 5, reasoning: 20 },
        },
        rootDir,
        sleep: async () => {},
      })
      const templateEngine = new TemplateEngine({ store, now })
      const gateway = new GatewayHub(store, {
        onChatTurn: (event) => {
          void loop.handleChatMessage(event)
        },
      })
      const loop: ChatLoop = createChatLoop({
        store,
        router,
        sessionStore: new PiJsonlSessionStore({
          cwd: rootDir,
          sessionsRoot: join(rootDir, 'sessions'),
        }),
        bridge: fake,
        now,
        isTrustWrapped: () => false,
        toolsFor: () => createFocusedSurfaceTools({ store, templateEngine, spaceId }),
        send: (clientId, frame) => gateway.sendToClient(clientId, frame),
      })
      const falseClaim = 'Saved a working control with every choice.'
      fake.setResponses([
        {
          message: fakeTextAndToolCall(falseClaim, 'create_surface', {
            id: candidate.id,
            title: candidate.title,
            tree: candidate.tree,
            state: candidate.state,
          }),
        },
        {
          factory: (context) => {
            expect(
              context.messages.filter((message) => message.role === 'toolResult').at(-1),
            ).toMatchObject({
              toolName: 'create_surface',
              isError: true,
            })
            return fakeText(falseClaim)
          },
        },
      ])
      const socket = new RecordingSocket()
      gateway.connect(socket)
      socket.receive({
        type: 'hello',
        clientId: 'pwa-controls',
        surfaceCursor: before.surfaceCursor,
      })

      try {
        socket.receive({ type: 'chat.send', spaceId, text: 'Create the requested control.' })
        await vi.waitFor(() => {
          expect(socket.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true)
        })
        expect(socket.sent.filter((frame) => frame.type === 'chat.turn-end')).toEqual([
          expect.objectContaining({
            type: 'chat.turn-end',
            spaceId,
            message: expect.objectContaining({
              text: expect.stringContaining('A Surface change was not saved:'),
            }),
          }),
        ])
        expect(socket.sent.filter((frame) => frame.type === 'chat.turn-delta')).toEqual([])
        expect(JSON.stringify(socket.sent)).not.toContain(falseClaim)
        expect(socket.patches(candidate.id)).toEqual([])
        expect(socket.sent.filter((frame) => frame.type === 'surface.created')).toEqual([])
        expect(await snapshot(app)).toEqual(before)
        expect((await events(app, spaceId)).filter((event) => event.type !== 'turn')).toEqual(
          eventsBefore,
        )
      } finally {
        await loop.stop()
        gateway.dispose()
        socket.close()
      }
    },
  )
})
