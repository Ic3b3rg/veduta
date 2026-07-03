import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  findDeclaredFastAction,
  type ChatMessage,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type PresenceEntry,
  type SurfacePatchEvent,
} from '@veduta/protocol'
import { handleChatText } from './chat.ts'
import { PwaChannelAdapter, type NormalizedChannelEvent } from './channel-adapter.ts'
import type { Store } from './store.ts'

export interface GatewaySocket {
  send(data: string): void
  on(event: 'message', handler: (raw: Buffer | string) => void): void
  on(event: 'close', handler: () => void): void
}

interface GatewayClientSession {
  clientId: string
  history: ChatMessage[]
  presence: PresenceEntry
}

export class GatewayHub {
  private pwa = new PwaChannelAdapter()
  private clients = new Map<string, GatewayClientSession>()
  private nextClientId = 1

  constructor(private readonly store: Store) {
    this.pwa.onMessage((event) => this.handleChannelMessage(event))
  }

  connect(socket: GatewaySocket): void {
    let clientId: string | null = null

    const send = (frame: GatewayServerMessage) => {
      socket.send(JSON.stringify(GatewayServerMessageSchema.parse(frame)))
    }

    socket.on('message', (raw) => {
      const frame = parseClientFrame(raw)
      if (!frame) {
        send({ type: 'error', error: 'invalid Gateway frame' })
        return
      }

      if (frame.type === 'hello') {
        if (clientId) this.disconnectClient(clientId)
        clientId = frame.clientId ?? this.allocateClientId()
        this.connectClient(clientId, send)
        const replay = this.store.surfaceEventsAfter(frame.surfaceCursor)
        send({
          type: 'hello',
          clientId,
          surfaceCursor: this.store.latestSurfaceCursor(),
          replayed: replay.length,
        })
        for (const event of replay) send({ type: 'surface.patch', event })
        this.broadcastPresence()
        return
      }

      if (!clientId) {
        send({ type: 'error', error: 'send hello before Gateway messages' })
        return
      }

      this.handleClientFrame(clientId, frame, send)
    })

    socket.on('close', () => {
      if (!clientId) return
      this.disconnectClient(clientId)
      this.broadcastPresence()
      clientId = null
    })
  }

  broadcastSurfacePatch(event: SurfacePatchEvent): void {
    this.pwa.broadcast({ type: 'surface.patch', event })
  }

  private handleClientFrame(
    clientId: string,
    frame: Exclude<GatewayClientMessage, { type: 'hello' }>,
    send: (frame: GatewayServerMessage) => void,
  ): void {
    const session = this.clients.get(clientId)
    if (!session) {
      send({ type: 'error', error: `unknown Gateway client: ${clientId}` })
      return
    }

    session.presence.lastSeenAt = new Date().toISOString()

    if (frame.type === 'chat.send') {
      this.pwa.receive(clientId, frame)
      return
    }

    if (frame.type === 'presence.update') {
      session.presence.status = frame.status
      this.broadcastPresence()
      return
    }

    const target = this.store.getSurface(frame.surfaceId)
    if (!target) {
      send({ type: 'error', error: `unknown Surface: ${frame.surfaceId}` })
      return
    }

    const declared = findDeclaredFastAction(
      target.tree,
      frame.invocation.nodeId,
      frame.invocation.name,
    )
    if (!declared) {
      send({
        type: 'error',
        error: `action "${frame.invocation.name}" is not declared as fast by node "${frame.invocation.nodeId}"`,
      })
      return
    }

    const value = frame.invocation.payload?.['value']
    if (value === undefined) {
      send({
        type: 'error',
        error: `fast action "${frame.invocation.name}" did not provide a value`,
      })
      return
    }

    const mutation = this.store.applyFastAction(frame.surfaceId, declared.stateKey, value)
    this.broadcastSurfacePatch(mutation.event)
  }

  private connectClient(clientId: string, send: (frame: GatewayServerMessage) => void): void {
    const now = new Date().toISOString()
    const existing = this.clients.get(clientId)
    const presence: PresenceEntry = existing?.presence ?? {
      clientId,
      status: 'online',
      connectedAt: now,
      lastSeenAt: now,
    }

    presence.status = 'online'
    presence.lastSeenAt = now
    this.clients.set(clientId, {
      clientId,
      history: existing?.history ?? [],
      presence,
    })
    this.pwa.connect({ clientId, send })
  }

  private disconnectClient(clientId: string): void {
    this.pwa.disconnect(clientId)
    this.clients.delete(clientId)
  }

  private handleChannelMessage(event: NormalizedChannelEvent): void {
    const session = this.clients.get(event.clientId)
    if (!session) return
    session.presence.lastSeenAt = event.receivedAt
    const reply = handleChatText(event.text, session.history)
    this.pwa.sendShort(event.clientId, reply.text)
  }

  private broadcastPresence(): void {
    this.pwa.broadcast({ type: 'presence.update', presence: this.presence() })
  }

  private presence(): PresenceEntry[] {
    return [...this.clients.values()].map((client) => client.presence)
  }

  private allocateClientId(): string {
    const clientId = `pwa-${this.nextClientId}`
    this.nextClientId += 1
    return clientId
  }
}

function parseClientFrame(raw: Buffer | string): GatewayClientMessage | null {
  let json: unknown
  try {
    json = JSON.parse(raw.toString())
  } catch {
    return null
  }

  const parsed = GatewayClientMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
