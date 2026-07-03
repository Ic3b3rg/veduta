import {
  GatewayServerMessageSchema,
  type GatewayClientMessage,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { GatewayHub, type GatewaySocket } from './gateway.ts'
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
})

class FakeGatewaySocket implements GatewaySocket {
  sent: GatewayServerMessage[] = []
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
