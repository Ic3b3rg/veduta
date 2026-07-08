import {
  GatewayServerMessageSchema,
  SurfaceSchema,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type Surface,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { GatewayHub, type GatewayAuth, type GatewaySocket } from './gateway.ts'
import { Store } from './store.ts'

describe('GatewayHub Surface sync', () => {
  it('broadcasts one Surface patch to two connected clients within 200ms', () => {
    const store = new Store()
    const gateway = new GatewayHub(store)
    const first = new FakeGatewaySocket()
    const second = new FakeGatewaySocket()
    gateway.connect(first)
    gateway.connect(second)
    first.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })
    second.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    first.receive({
      type: 'surface.action',
      surfaceId: 'srf-groceries',
      invocation: { nodeId: 'item-milk', name: 'toggle', payload: { value: true } },
    })

    const firstPatch = first.lastSurfacePatch()
    const secondPatch = second.lastSurfacePatch()
    expect(firstPatch?.event.cursor).toBe(secondPatch?.event.cursor)
    expect(firstPatch?.event.patch.operations).toMatchObject([
      { target: 'state', op: 'replace', path: '/milk', value: true },
    ])
    expect(Math.abs(first.lastPatchAt() - second.lastPatchAt())).toBeLessThanOrEqual(200)
  })

  it('replays patches after the reconnect cursor without requiring a snapshot reload', () => {
    const store = new Store()
    const gateway = new GatewayHub(store)
    const offline = new FakeGatewaySocket()
    gateway.connect(offline)
    offline.receive({ type: 'hello', surfaceCursor: 0 })
    offline.close()

    const mutation = store.applyFastAction('srf-groceries', 'eggs', false)
    gateway.broadcastSurfacePatch(mutation.event)

    const reconnected = new FakeGatewaySocket()
    gateway.connect(reconnected)
    reconnected.receive({ type: 'hello', clientId: 'pwa-reconnected', surfaceCursor: 0 })

    const hello = reconnected.sent.find((frame) => frame.type === 'hello')
    expect(hello).toMatchObject({ type: 'hello', replayed: 1, surfaceCursor: 1 })
    expect(reconnected.surfacePatches().map((frame) => frame.event.cursor)).toEqual([1])
  })

  it('requires an authenticated token and closes active sockets for a revoked device', () => {
    const store = new Store()
    const auth = new FakeGatewayAuth()
    const gateway = new GatewayHub(store, { auth })
    const rejected = new FakeGatewaySocket()
    gateway.connect(rejected)

    rejected.receive({ type: 'hello', surfaceCursor: 0 })

    expect(rejected.closed).toBe(true)
    expect(rejected.sent.at(-1)).toMatchObject({
      type: 'error',
      error: 'authenticated Gateway session required',
    })

    const accepted = new FakeGatewaySocket()
    gateway.connect(accepted)
    accepted.receive({
      type: 'hello',
      surfaceCursor: store.latestSurfaceCursor(),
      token: 'vdt_tok-1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(accepted.sent.some((frame) => frame.type === 'hello')).toBe(true)

    auth.revokeDevice('dev-1')

    expect(accepted.closed).toBe(true)
    expect(accepted.sent.at(-1)).toMatchObject({ type: 'error', error: 'Gateway session revoked' })
  })

  it('queues an Agent turn for declared agent-path actions without broadcasting a patch', () => {
    const store = new Store()
    store.createSurface(agentActionSurface(), 'agent')
    const gateway = new GatewayHub(store)
    const socket = new FakeGatewaySocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    socket.receive({
      type: 'surface.action',
      surfaceId: 'srf-agent-action',
      invocation: {
        nodeId: 'regenerate',
        name: 'regenerate_plan',
        payload: { reason: 'stale' },
      },
    })

    expect(store.agentTurns().at(-1)).toMatchObject({
      surfaceId: 'srf-agent-action',
      atomId: 'regenerate',
      actionName: 'regenerate_plan',
      payload: { reason: 'stale' },
    })
    expect(
      socket.surfacePatches().filter((frame) => frame.event.patch.surfaceId === 'srf-agent-action'),
    ).toHaveLength(0)
  })

  it('patches the relevant Health Surface when mock chat logs a meal', () => {
    const store = new Store({ now: fixedNow })
    const gateway = new GatewayHub(store, { mockChatEffects: true })
    const socket = new FakeGatewaySocket()
    gateway.connect(socket)
    socket.receive({
      type: 'hello',
      clientId: 'pwa-health',
      surfaceCursor: store.latestSurfaceCursor(),
    })

    socket.receive({ type: 'chat.send', text: 'I ate a pizza', spaceId: 'spc-health' })

    expect(store.getSurface('srf-meals')?.state).toMatchObject({
      lastMeal: 'a pizza',
      mealCount: 1,
    })
    expect(socket.lastSurfacePatch()?.event.patch).toMatchObject({
      surfaceId: 'srf-meals',
      operations: [
        {
          target: 'state',
          op: 'replace',
          path: '/meals',
          value: [expect.objectContaining({ meal: 'a pizza' })],
        },
        { target: 'state', op: 'replace', path: '/lastMeal', value: 'a pizza' },
        { target: 'state', op: 'replace', path: '/mealCount', value: 1 },
      ],
    })
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'chat.message',
      message: { role: 'assistant' },
    })
  })

  it('never mutates Surfaces from chat unless mock effects are enabled', () => {
    const store = new Store({ now: fixedNow })
    const gateway = new GatewayHub(store)
    const socket = new FakeGatewaySocket()
    gateway.connect(socket)
    socket.receive({
      type: 'hello',
      clientId: 'pwa-health',
      surfaceCursor: store.latestSurfaceCursor(),
    })

    socket.receive({ type: 'chat.send', text: 'I ate a pizza', spaceId: 'spc-health' })

    expect(store.getSurface('srf-meals')?.state['mealCount']).toBe(0)
    expect(socket.surfacePatches()).toHaveLength(0)
    expect(socket.sent.at(-1)).toMatchObject({ type: 'chat.message' })
  })
})

describe('GatewayHub system notices', () => {
  it('broadcasts a daemon-originated notice to every connected client', () => {
    const store = new Store()
    const gateway = new GatewayHub(store)
    const socket = new FakeGatewaySocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })

    gateway.broadcastSystemNotice('Daily triage spending cap reached; proactivity is paused.')

    const notice = socket.sent.find((frame) => frame.type === 'chat.message')
    expect(notice).toMatchObject({
      type: 'chat.message',
      message: { role: 'assistant', text: expect.stringContaining('spending cap') },
    })
  })
})

class FakeGatewaySocket implements GatewaySocket {
  sent: GatewayServerMessage[] = []
  closed = false
  private sentAt: number[] = []
  private messageHandlers: ((raw: Buffer | string) => void)[] = []
  private closeHandlers: (() => void)[] = []

  send(data: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(data)))
    this.sentAt.push(Date.now())
  }

  on(event: 'message', handler: (raw: Buffer | string) => void): void
  on(event: 'close', handler: () => void): void
  on(event: 'message' | 'close', handler: ((raw: Buffer | string) => void) | (() => void)): void {
    if (event === 'message') {
      this.messageHandlers.push(handler as (raw: Buffer | string) => void)
      return
    }
    this.closeHandlers.push(handler as () => void)
  }

  receive(frame: GatewayClientMessage): void {
    const raw = JSON.stringify(frame)
    for (const handler of this.messageHandlers) handler(raw)
  }

  close(): void {
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }

  surfacePatches(): Extract<GatewayServerMessage, { type: 'surface.patch' }>[] {
    return this.sent.filter((frame) => frame.type === 'surface.patch')
  }

  lastSurfacePatch(): Extract<GatewayServerMessage, { type: 'surface.patch' }> | undefined {
    return this.surfacePatches().at(-1)
  }

  lastPatchAt(): number {
    let index = -1
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i]?.type === 'surface.patch') {
        index = i
        break
      }
    }
    return this.sentAt[index] ?? 0
  }
}

class FakeGatewayAuth implements GatewayAuth {
  private listeners = new Set<(event: { deviceId: string }) => void>()

  verifySession(token: string | undefined): { device: { id: string; name: string } } | undefined {
    return token ? { device: { id: 'dev-1', name: 'Silvio iPhone' } } : undefined
  }

  onSessionRevoked(listener: (event: { deviceId: string }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  revokeDevice(deviceId: string): void {
    for (const listener of this.listeners) listener({ deviceId })
  }
}

function agentActionSurface(): Surface {
  return SurfaceSchema.parse({
    id: 'srf-agent-action',
    spaceId: 'spc-health',
    title: 'Agent action',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'regenerate',
          type: 'Button',
          props: { label: 'Regenerate' },
          actions: [{ name: 'regenerate_plan', path: 'agent' }],
        },
      ],
    },
    state: {},
    freshness: { updatedAt: '2026-07-03T12:00:00.000Z', updatedBy: 'seed' },
  })
}

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}
