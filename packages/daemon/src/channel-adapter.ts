import type { GatewayClientMessage, GatewayServerMessage } from '@veduta/protocol'

export type ChannelKind = 'pwa' | 'bridge'

export interface NormalizedChannelEvent {
  adapterId: string
  clientId: string
  text: string
  spaceId?: string
  receivedAt: string
}

export type ChannelMessageHandler = (event: NormalizedChannelEvent) => void

export interface ChannelConnection {
  clientId: string
  send(frame: GatewayServerMessage): void
}

export interface ChannelAdapter {
  readonly id: string
  readonly kind: ChannelKind
  connect(connection: ChannelConnection): void
  disconnect(clientId: string): void
  sendShort(clientId: string, text: string): void
  onMessage(handler: ChannelMessageHandler): void
}

export class PwaChannelAdapter implements ChannelAdapter {
  readonly id = 'pwa'
  readonly kind = 'pwa'

  private connections = new Map<string, ChannelConnection>()
  private messageHandler: ChannelMessageHandler = () => undefined

  connect(connection: ChannelConnection): void {
    this.connections.set(connection.clientId, connection)
  }

  disconnect(clientId: string): void {
    this.connections.delete(clientId)
  }

  sendShort(clientId: string, text: string): void {
    this.send(clientId, { type: 'chat.message', message: { role: 'assistant', text } })
  }

  send(clientId: string, frame: GatewayServerMessage): void {
    this.connections.get(clientId)?.send(frame)
  }

  broadcast(frame: GatewayServerMessage): void {
    for (const connection of this.connections.values()) connection.send(frame)
  }

  receive(clientId: string, frame: GatewayClientMessage): void {
    if (frame.type !== 'chat.send') return
    const event: NormalizedChannelEvent = {
      adapterId: this.id,
      clientId,
      text: frame.text,
      receivedAt: new Date().toISOString(),
    }
    if (frame.spaceId !== undefined) event.spaceId = frame.spaceId
    this.messageHandler(event)
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler
  }
}

export function bridgeShortReply(text: string, homeUrl: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const link = `Open Home: ${homeUrl}`
  if (link.length >= 240) return link.slice(0, 240)

  const budget = 240 - link.length - 1
  const body =
    normalized.length > budget
      ? `${normalized.slice(0, Math.max(0, budget - 3)).trim()}...`
      : normalized
  return body ? `${body} ${link}` : link
}
