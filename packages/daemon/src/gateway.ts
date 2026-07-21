import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  type ApprovalCard,
  type ChatMessage,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type PresenceEntry,
} from '@veduta/protocol'
import { handleChatText, mealPatchFromChat } from './chat.ts'
import { PwaChannelAdapter, type NormalizedChannelEvent } from './channel-adapter.ts'
import type { SurfaceEngineEvent } from './surface-engine.ts'
import { SurfaceActionError, type Store } from './store.ts'

export interface GatewaySocket {
  send(data: string): void
  on(event: 'message', handler: (raw: Buffer | string) => void): void
  on(event: 'close', handler: () => void): void
  close?(): void
}

export interface GatewayAuth {
  verifySession(token: string | undefined): { device: { id: string; name: string } } | undefined
  onSessionRevoked(listener: (event: { deviceId: string }) => void): () => void
}

/**
 * "show/read [me] the full text [of] [event|queue] #<id>" — recognized
 * before the mock chat path so the real full-text flow (SECURITY.md §3.3)
 * can answer it once wired; falls through to the ordinary chat reply when
 * `onFullTextRequest` is not configured.
 */
const FULL_TEXT_REQUEST_RE =
  /^(?:show|read)(?:\s+me)?\s+the\s+full\s+text(?:\s+of)?\s*(?:event|queue)?\s*#?(\d+)$/i

interface GatewayClientSession {
  clientId: string
  deviceId?: string
  history: ChatMessage[]
  presence: PresenceEntry
  send: (frame: GatewayServerMessage) => void
  socket: GatewaySocket
}

export class GatewayHub {
  private pwa = new PwaChannelAdapter()
  private clients = new Map<string, GatewayClientSession>()
  private nextClientId = 1
  private disposeAuthListener: (() => void) | undefined
  private disposeSurfaceEventListener: () => void
  private pendingSystemNotices: string[] = []

  constructor(
    private readonly store: Store,
    private readonly options: {
      auth?: GatewayAuth
      mockChatEffects?: boolean
      /** Extra dev-profile chat effect (e.g. the scheduler's "remind me…" demo). */
      onDevChatEffect?: (event: NormalizedChannelEvent) => void
      /**
       * Answers a recognized "show me the full text of event #N" request
       * (docs/SECURITY.md §3.3): runs the dedicated, gated turn
       * (`promptFullText`) and resolves with its reply. Rejection (unknown
       * queue id, transport failure) yields a content-free system notice —
       * never the underlying error detail.
       */
      onFullTextRequest?: (queueId: number) => Promise<string>
    } = {},
  ) {
    this.pwa.onMessage((event) => this.handleChannelMessage(event))
    this.disposeAuthListener = options.auth?.onSessionRevoked((event) => {
      this.closeRevokedDevice(event.deviceId)
    })
    // The one and only Surface-lifecycle broadcaster (D9): every committed
    // patch/created/archived event flows through here exactly once, however
    // it was produced (fast path, Agent tool, scheduler projection, mock
    // chat effect) — nothing else in this class calls `pwa.broadcast` with a
    // surface.* frame.
    this.disposeSurfaceEventListener = this.store.onSurfaceEvent((event) => {
      this.pwa.broadcast(surfaceEventFrame(event))
    })
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
        const authSession = this.options.auth?.verifySession(frame.token)
        if (this.options.auth && !authSession) {
          send({ type: 'error', error: 'authenticated Gateway session required' })
          socket.close?.()
          return
        }
        if (clientId) this.disconnectClient(clientId)
        clientId = frame.clientId ?? this.allocateClientId()
        this.connectClient(clientId, send, socket, authSession?.device.id)
        const replay = this.store.surfaceEventsAfter(frame.surfaceCursor)
        send({
          type: 'hello',
          clientId,
          surfaceCursor: this.store.latestSurfaceCursor(),
          replayed: replay.length,
        })
        for (const event of replay) send(surfaceEventFrame(event))
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

  /**
   * Daemon-originated notice (e.g. spending cap reached) to every client.
   * With nobody connected (boot-time re-notify) it queues and reaches the
   * next client that completes the hello.
   */
  broadcastSystemNotice(text: string): void {
    if (this.clients.size === 0) {
      this.pendingSystemNotices.push(text)
      return
    }
    this.pwa.broadcast({ type: 'chat.message', message: { role: 'assistant', text } })
  }

  /** Broadcasts a new approval card chip (issue #14, D13) to every connected client. */
  broadcastApprovalCard(card: ApprovalCard): void {
    this.pwa.broadcast({ type: 'approval.card', card })
  }

  /**
   * Broadcasts a Space's updated attention badge (issue #18, plan v2
   * decision 12) to every connected client. No queueing for offline
   * clients, unlike `broadcastSystemNotice`: a reconnecting/late client
   * always gets the authoritative value from the next `/api/spaces`
   * snapshot, and the client applies highest-revision-wins, so a missed
   * live frame is never lost, only superseded.
   */
  broadcastSpaceAttention(spaceId: string, count: number, revision: number): void {
    this.pwa.broadcast({ type: 'space.attention', spaceId, count, revision })
  }

  /**
   * Out-of-band reply to one specific client (issue #14's dev dispatcher):
   * `onDevChatEffect` itself is a fire-and-forget void callback with no
   * reply channel of its own — this is that channel, mirroring the same
   * `pwa.sendShort` every ordinary chat reply already uses.
   */
  replyToClient(clientId: string, text: string): void {
    this.pwa.sendShort(clientId, text)
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

    try {
      // The mutation's own commit already reached every client through the
      // central Surface-event subscription above — this call is only about
      // routing the request and surfacing errors to the requester.
      this.store.invokeSurfaceAction(frame.surfaceId, frame.invocation)
    } catch (error) {
      if (error instanceof SurfaceActionError) {
        send({ type: 'error', error: error.message })
        return
      }
      throw error
    }
  }

  dispose(): void {
    this.disposeAuthListener?.()
    this.disposeSurfaceEventListener()
  }

  private connectClient(
    clientId: string,
    send: (frame: GatewayServerMessage) => void,
    socket: GatewaySocket,
    deviceId?: string,
  ): void {
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
    const session: GatewayClientSession = {
      clientId,
      history: existing?.history ?? [],
      presence,
      send,
      socket,
    }
    if (deviceId !== undefined) session.deviceId = deviceId
    this.clients.set(clientId, session)
    this.pwa.connect({ clientId, send })
    for (const text of this.pendingSystemNotices.splice(0)) this.pwa.sendShort(clientId, text)
  }

  private disconnectClient(clientId: string): void {
    this.pwa.disconnect(clientId)
    this.clients.delete(clientId)
  }

  private handleChannelMessage(event: NormalizedChannelEvent): void {
    const session = this.clients.get(event.clientId)
    if (!session) return
    session.presence.lastSeenAt = event.receivedAt

    const fullTextMatch = FULL_TEXT_REQUEST_RE.exec(event.text)
    if (fullTextMatch && this.options.onFullTextRequest) {
      this.handleFullTextRequest(Number(fullTextMatch[1]), event.clientId)
      return
    }

    const reply = handleChatText(event.text, session.history)
    if (this.options.mockChatEffects) {
      this.applyMockChatSurfaceEffect(event)
      this.options.onDevChatEffect?.(event)
    }
    this.pwa.sendShort(event.clientId, reply.text)
  }

  private handleFullTextRequest(queueId: number, clientId: string): void {
    const onFullTextRequest = this.options.onFullTextRequest
    if (!onFullTextRequest) return
    // Both outcomes answer only the requesting client; the failure message
    // is content-free (never the underlying error detail).
    onFullTextRequest(queueId).then(
      (reply) => this.pwa.sendShort(clientId, reply),
      () => this.pwa.sendShort(clientId, `Full text for queue #${queueId} is not available.`),
    )
  }

  // Dev-profile stand-in for the Agent loop: proves the chat→Surface patch
  // flow end-to-end without an API key. The store's patchState appends the
  // resulting surface.patch_state to the Space Event log, but the user's chat
  // turn itself is not ingested yet — that lands with the real Agent loop,
  // which replaces this method.
  private applyMockChatSurfaceEffect(event: NormalizedChannelEvent): void {
    const surface = this.store.getSurface('srf-meals')
    if (!surface) return
    if (event.spaceId !== undefined && event.spaceId !== surface.spaceId) return

    const operations = mealPatchFromChat(event.text, surface.state, new Date(event.receivedAt))
    if (!operations) return

    // The commit reaches every client through the central Surface-event
    // subscription; no manual broadcast here.
    this.store.patchState(surface.id, operations, { updatedBy: 'agent' })
  }

  private broadcastPresence(): void {
    this.pwa.broadcast({ type: 'presence.update', presence: this.presence() })
  }

  private closeRevokedDevice(deviceId: string): void {
    for (const session of [...this.clients.values()]) {
      if (session.deviceId !== deviceId) continue
      session.send({ type: 'error', error: 'Gateway session revoked' })
      session.socket.close?.()
      this.disconnectClient(session.clientId)
    }
    this.broadcastPresence()
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

/** The one place a `SurfaceEngineEvent` becomes a Gateway server frame, shared by hello replay and the live broadcast. */
function surfaceEventFrame(event: SurfaceEngineEvent): GatewayServerMessage {
  if (event.kind === 'created') return { type: 'surface.created', event: event.event }
  if (event.kind === 'archived') return { type: 'surface.archived', event: event.event }
  return { type: 'surface.patch', event: event.event }
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
