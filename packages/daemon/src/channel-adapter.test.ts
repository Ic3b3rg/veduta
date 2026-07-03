import type { GatewayClientMessage, GatewayServerMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  PwaChannelAdapter,
  bridgeShortReply,
  type ChannelAdapter,
  type ChannelConnection,
  type ChannelMessageHandler,
  type NormalizedChannelEvent,
} from './channel-adapter.ts'

interface AdapterHarness {
  adapter: ChannelAdapter
  sent: GatewayServerMessage[]
  connect(clientId: string): void
  receiveChat(clientId: string, text: string): void
}

function runChannelAdapterContract(name: string, createHarness: () => AdapterHarness): void {
  describe(`${name} ChannelAdapter contract`, () => {
    it('normalizes inbound messages and preserves adapter/client identity', () => {
      const harness = createHarness()
      const events: NormalizedChannelEvent[] = []
      harness.adapter.onMessage((event) => events.push(event))
      harness.connect('client-1')

      harness.receiveChat('client-1', 'update groceries')

      expect(events).toMatchObject([
        {
          adapterId: harness.adapter.id,
          clientId: 'client-1',
          text: 'update groceries',
        },
      ])
      expect(Date.parse(events[0]!.receivedAt)).not.toBeNaN()
    })

    it('disconnects clients so later short sends are ignored', () => {
      const harness = createHarness()
      harness.connect('client-1')

      harness.adapter.disconnect('client-1')
      harness.adapter.sendShort('client-1', 'done')

      expect(harness.sent).toEqual([])
    })
  })
}

runChannelAdapterContract('PWA', () => {
  const adapter = new PwaChannelAdapter()
  const sent: GatewayServerMessage[] = []
  return {
    adapter,
    sent,
    connect(clientId) {
      adapter.connect({ clientId, send: (frame) => sent.push(frame) })
    },
    receiveChat(clientId, text) {
      adapter.receive(clientId, { type: 'chat.send', text })
    },
  }
})

runChannelAdapterContract('Fake', () => {
  const adapter = new FakeChannelAdapter()
  const sent: GatewayServerMessage[] = []
  return {
    adapter,
    sent,
    connect(clientId) {
      adapter.connect({ clientId, send: (frame) => sent.push(frame) })
    },
    receiveChat(clientId, text) {
      adapter.receive(clientId, { type: 'chat.send', text })
    },
  }
})

describe('bridgeShortReply', () => {
  it('keeps non-PWA replies short and links back to the Home', () => {
    const reply = bridgeShortReply('x '.repeat(300), 'https://home.example/s/spc-health')
    expect(reply.length).toBeLessThanOrEqual(240)
    expect(reply).toContain('Open Home: https://home.example/s/spc-health')
  })
})

class FakeChannelAdapter implements ChannelAdapter {
  readonly id = 'fake'
  readonly kind = 'bridge'

  private connections = new Map<string, ChannelConnection>()
  private messageHandler: ChannelMessageHandler = () => undefined

  connect(connection: ChannelConnection): void {
    this.connections.set(connection.clientId, connection)
  }

  disconnect(clientId: string): void {
    this.connections.delete(clientId)
  }

  sendShort(clientId: string, text: string): void {
    this.connections.get(clientId)?.send({
      type: 'chat.message',
      message: { role: 'assistant', text },
    })
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler
  }

  receive(clientId: string, frame: GatewayClientMessage): void {
    if (frame.type !== 'chat.send') return
    this.messageHandler({
      adapterId: this.id,
      clientId,
      text: frame.text,
      receivedAt: new Date().toISOString(),
    })
  }
}
