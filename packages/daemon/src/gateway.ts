import { randomUUID } from 'node:crypto'
import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  SurfaceValidationError,
  type ApprovalCard,
  type AgentActionTurn,
  type AutomationOutcomeNotificationLifecycleMessage,
  type ChatAcceptance,
  type ChatTimelineEntry,
  type ChatScope,
  type GatewayClientMessage,
  type GatewayServerMessage,
  type PendingDecisionLifecycleMessage,
  type PresenceEntry,
} from '@veduta/protocol'
import type { QueuedAgentTurn, SurfaceEngineEvent } from './surface-engine.ts'
import { SurfaceActionError, type Store } from './store.ts'
import { SurfaceCommitRecoveryPendingError } from './surface-commit.ts'
import { ChatTimelineError } from './chat-timeline.ts'

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

export interface PwaChatInput {
  clientId: string
  text: string
  spaceId?: string
  submissionId?: string
  retryOf?: string
  turnId?: string
  receivedAt: string
}

/**
 * "show/read [me] the full text [of] [event|queue] #<id>" — recognized
 * before the ordinary chat turn is dispatched, so the real full-text flow
 * (SECURITY.md §3.3) can answer it once wired; falls through to the Agent
 * loop's chat turn when `onFullTextRequest` is not configured.
 */
const FULL_TEXT_REQUEST_RE =
  /^(?:show|read)(?:\s+me)?\s+the\s+full\s+text(?:\s+of)?\s*(?:event|queue)?\s*#?(\d+)$/i

export function fullTextQueueId(text: string): number | undefined {
  const match = FULL_TEXT_REQUEST_RE.exec(text)
  return match ? Number(match[1]) : undefined
}

interface GatewayClientSession {
  clientId: string
  deviceId?: string
  presence: PresenceEntry
  send: (frame: GatewayServerMessage) => void
  socket: GatewaySocket
}

export class GatewayHub {
  private clients = new Map<string, GatewayClientSession>()
  private disposeAuthListener: (() => void) | undefined
  private disposeSurfaceEventListener: () => void
  private disposeFactsListener: () => void
  private disposeSpaceListener: () => void
  private pendingSystemNotices: string[] = []

  constructor(
    private readonly store: Store,
    private readonly options: {
      auth?: GatewayAuth
      /**
       * The real Agent loop's chat turn (issue #37): late-bound — server.ts
       * assigns this after the Gateway is constructed, once the chat loop
       * exists. Not configured is a boot-order bug, surfaced honestly to the
       * requesting client (a `chat.message` frame saying so) rather than
       * silently dropped.
       */
      onChatTurn?: (event: PwaChatInput) => ChatAcceptance | void
      onChatSubscribe?: (clientId: string, turnId: string) => ChatScope | undefined
      onAgentAction?: (turn: QueuedAgentTurn) => void
      /**
       * Answers a recognized "show me the full text of event #N" request
       * (docs/SECURITY.md §3.3): runs the dedicated, gated turn
       * (`promptFullText`) and resolves with its reply. Rejection (unknown
       * queue id, transport failure) yields a content-free system notice —
       * never the underlying error detail.
       */
      onFullTextRequest?: (queueId: number) => Promise<string>
      /**
       * How long a fresh socket may stay open without a successful `hello`
       * before it is closed (docs/SECURITY.md §6 pre-auth guard). Default
       * 10s; tests shrink it to drive the deadline deterministically.
       */
      helloTimeoutMs?: number
    } = {},
  ) {
    this.disposeAuthListener = options.auth?.onSessionRevoked((event) => {
      this.closeRevokedDevice(event.deviceId)
    })
    // The one and only Surface-lifecycle broadcaster: every committed
    // patch/created/archived event flows through here exactly once, however
    // it was produced (fast path, Agent tool, scheduler projection) —
    // nothing else in this class broadcasts a surface.*
    // frame.
    this.disposeSurfaceEventListener = this.store.onSurfaceEvent((event) => {
      this.broadcast(surfaceEventFrame(event, this.store))
    })
    this.disposeFactsListener = this.store.spacesEngine.onMemoryWrite(({ spaceId, kind }) => {
      if (kind === 'fact') this.broadcast({ type: 'space.facts-changed', spaceId })
    })
    this.disposeSpaceListener = this.store.spacesEngine.onSpaceChanged((space) => {
      this.broadcast({ type: 'space.changed', spaceId: space.id })
    })
  }

  connect(socket: GatewaySocket): void {
    let clientId: string | null = null

    const send = (frame: GatewayServerMessage) => {
      socket.send(JSON.stringify(GatewayServerMessageSchema.parse(frame)))
    }

    // Pre-auth guard (docs/SECURITY.md §6): the WebSocket upgrade is exempt
    // from the per-request Bearer check, so an unauthenticated socket must
    // not be allowed to linger — it either authenticates with a valid
    // `hello` within the deadline or gets closed. Unref'd so a held-open
    // test socket never keeps the process alive.
    const helloDeadline = setTimeout(() => {
      if (!clientId) socket.close?.()
    }, this.options.helloTimeoutMs ?? 10_000)
    helloDeadline.unref?.()

    socket.on('message', (raw) => {
      if (clientId && this.clients.get(clientId)?.socket !== socket) {
        socket.close?.()
        return
      }
      const frame = parseClientFrame(raw)
      if (!frame) {
        send({ type: 'error', error: 'invalid Gateway frame' })
        // A client that has not authenticated yet gets no second chance to
        // hold the socket open with garbage frames.
        if (!clientId) socket.close?.()
        return
      }

      if (frame.type === 'hello') {
        const authSession = this.options.auth?.verifySession(frame.token)
        if (this.options.auth && !authSession) {
          send({ type: 'error', error: 'authenticated Gateway session required' })
          socket.close?.()
          return
        }
        clearTimeout(helloDeadline)
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
        for (const event of replay) send(surfaceEventFrame(event, this.store))
        this.broadcastPresence()
        return
      }

      if (!clientId) {
        send({ type: 'error', error: 'send hello before Gateway messages' })
        // Same pre-auth rule as above: no unauthenticated lingering.
        socket.close?.()
        return
      }

      this.handleClientFrame(clientId, frame, send)
    })

    socket.on('close', () => {
      // Whatever ended this socket (deadline, rejection, client hangup),
      // its pre-auth timer must not linger for the full deadline window.
      clearTimeout(helloDeadline)
      if (!clientId) return
      // Stale-close guard (issue #37 fix): a reconnect (`hello` carrying a
      // returning `clientId`) already rebound this id to a NEW socket via
      // `connectClient` before this OLD socket's own `close` fires — the two
      // events race, and a slow disconnect notification for the old socket
      // must never win. Only tear down the binding this socket itself still
      // owns; if `clientId` now points at a different socket, this close
      // event is stale and must be a no-op.
      if (this.clients.get(clientId)?.socket !== socket) {
        clientId = null
        return
      }
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
    this.broadcast({ type: 'chat.message', message: { role: 'assistant', text } })
  }

  /** Broadcasts a new approval card chip (issue #14) to every connected client. */
  broadcastApprovalCard(card: ApprovalCard): void {
    this.broadcast({ type: 'approval.card', card })
  }

  /** Broadcasts daemon-authored decision progress/outcome; HTTP list recovery covers offline clients. */
  broadcastPendingDecision(lifecycle: Omit<PendingDecisionLifecycleMessage, 'type'>): void {
    this.broadcast({ type: 'pending-decision.lifecycle', ...lifecycle })
  }

  broadcastChatTimelineEntry(entry: ChatTimelineEntry): void {
    this.broadcast({ type: 'chat.timeline-entry', entry })
  }

  /** Broadcasts confirmed durable In-app notification state; HTTP snapshots recover missed frames. */
  broadcastAutomationOutcomeNotification(
    lifecycle: Omit<AutomationOutcomeNotificationLifecycleMessage, 'type'>,
  ): void {
    this.broadcast({ type: 'automation-outcome-notification.lifecycle', ...lifecycle })
  }

  /**
   * Broadcasts a Space's updated attention badge (issue #18) to every
   * connected client. No queueing for offline
   * clients, unlike `broadcastSystemNotice`: a reconnecting/late client
   * always gets the authoritative value from the next `/api/spaces`
   * snapshot, and the client applies highest-revision-wins, so a missed
   * live frame is never lost, only superseded.
   */
  broadcastSpaceAttention(spaceId: string, count: number, revision: number): void {
    this.broadcast({ type: 'space.attention', spaceId, count, revision })
  }

  /**
   * Delivers one Gateway frame to a specific client — the chat loop's
   * channel for a turn's lifecycle frames (start / text delta / end /
   * error, issue #37). Looks the client up and calls its
   * own `send`, which zod-parses every outgoing frame exactly like every
   * other path out of this class. Silently no-ops when the client has
   * disconnected: a streamed turn may outlive its socket.
   */
  sendToClient(clientId: string, frame: GatewayServerMessage): void {
    this.clients.get(clientId)?.send(frame)
  }

  broadcastAgentActionTurn(turn: AgentActionTurn): void {
    this.broadcast({ type: 'surface.action-turn', turn })
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
      this.handleChatMessage({
        clientId,
        text: frame.text,
        receivedAt: new Date().toISOString(),
        ...(frame.spaceId === undefined ? {} : { spaceId: frame.spaceId }),
        ...(frame.submissionId === undefined ? {} : { submissionId: frame.submissionId }),
        ...(frame.retryOf === undefined ? {} : { retryOf: frame.retryOf }),
      })
      return
    }

    if (frame.type === 'chat.subscribe') {
      const scope = this.options.onChatSubscribe?.(clientId, frame.turnId)
      if (scope) {
        send({
          type: 'chat.turn-start',
          turnId: frame.turnId,
          ...(scope.type === 'space' ? { spaceId: scope.spaceId } : {}),
        })
      }
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
      const result = this.store.invokeSurfaceAction(frame.surfaceId, frame.invocation)
      if (result.path === 'agent') {
        if (this.options.onAgentAction) this.options.onAgentAction(result.turn)
        else send({ type: 'error', error: 'The Agent action executor is unavailable.' })
      }
    } catch (error) {
      if (error instanceof SurfaceCommitRecoveryPendingError) {
        send({
          type: 'error',
          error: `Surface commit ${error.commitId} is recovery_pending in Space ${error.spaceId}.`,
        })
        return
      }
      if (error instanceof SurfaceActionError) {
        send({ type: 'error', error: error.message, code: error.code })
        return
      }
      if (error instanceof SurfaceValidationError) {
        send({
          type: 'error',
          error: error.message,
          code: error.code,
          issues: error.validationIssues,
        })
        return
      }
      throw error
    }
  }

  dispose(): void {
    this.disposeAuthListener?.()
    this.disposeSurfaceEventListener()
    this.disposeFactsListener()
    this.disposeSpaceListener()
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
      presence,
      send,
      socket,
    }
    if (deviceId !== undefined) session.deviceId = deviceId
    this.clients.set(clientId, session)
    if (existing && existing.socket !== socket) existing.socket.close?.()
    for (const text of this.pendingSystemNotices.splice(0)) this.sendChatMessage(clientId, text)
  }

  private disconnectClient(clientId: string): void {
    this.clients.delete(clientId)
  }

  private handleChatMessage(event: PwaChatInput): void {
    const session = this.clients.get(event.clientId)
    if (!session) return
    session.presence.lastSeenAt = event.receivedAt

    const queueId = fullTextQueueId(event.text)
    if (queueId !== undefined && this.options.onFullTextRequest && !this.options.onChatTurn) {
      this.handleFullTextRequest(queueId, event.clientId)
      return
    }

    if (!this.options.onChatTurn) {
      // A boot-order bug surfaced honestly, not silence (AGENTS.md): the
      // Gateway exists before server.ts finishes wiring the chat loop, but
      // by the time a client can send `chat.send` the hook must be bound.
      this.sendChatMessage(event.clientId, 'The Agent loop is not configured on this daemon yet.')
      return
    }
    try {
      const acceptance = this.options.onChatTurn(event)
      if (acceptance) session.send({ type: 'chat.accepted', acceptance })
    } catch (error) {
      const message =
        error instanceof ChatTimelineError
          ? error.message
          : error instanceof Error && error.message === 'Unknown Chat Space'
            ? error.message
            : 'Chat request could not be accepted.'
      if (event.submissionId)
        session.send({
          type: 'chat.submission-rejected',
          submissionId: event.submissionId,
          error: message,
        })
      else session.send({ type: 'error', error: message })
    }
  }

  private handleFullTextRequest(queueId: number, clientId: string): void {
    const onFullTextRequest = this.options.onFullTextRequest
    if (!onFullTextRequest) return
    // Both outcomes answer only the requesting client; the failure message
    // is content-free (never the underlying error detail).
    onFullTextRequest(queueId).then(
      (reply) => this.sendChatMessage(clientId, reply),
      () => this.sendChatMessage(clientId, `Full text for queue #${queueId} is not available.`),
    )
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence.update', presence: this.presence() })
  }

  private sendChatMessage(clientId: string, text: string): void {
    this.sendToClient(clientId, { type: 'chat.message', message: { role: 'assistant', text } })
  }

  private broadcast(frame: GatewayServerMessage): void {
    for (const session of this.clients.values()) session.send(frame)
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

  /**
   * A fresh clientId for a socket that sent no `clientId` of its own in its
   * `hello` (a first-ever connection, never a reconnect). Random, not
   * sequential (issue #37 fix): a returning `clientId` rebinds whatever
   * socket currently owns it (`connectClient` below), so a guessable/
   * sequential id would let one tab steal another tab's binding — a mid-turn
   * frame meant for tab A's socket would instead reach whichever socket last
   * claimed `pwa-N`. In production mode `hello` is already token-gated
   * (`GatewayAuth.verifySession` above), so a rebind can only ever happen
   * within the one authenticated user's own sockets; this is defense in
   * depth for the single-user, multi-tab case, not a second auth boundary.
   */
  private allocateClientId(): string {
    return `pwa-${randomUUID()}`
  }
}

/** The one place a `SurfaceEngineEvent` becomes a Gateway server frame, shared by hello replay and the live broadcast. */
function surfaceEventFrame(event: SurfaceEngineEvent, store: Store): GatewayServerMessage {
  if (event.kind === 'created') {
    return {
      type: 'surface.created',
      event: { ...event.event, surface: store.projectManagementSurface(event.event.surface) },
      ...(event.initiatingTurn === undefined ? {} : { initiatingTurn: event.initiatingTurn }),
    }
  }
  if (event.kind === 'archived') return { type: 'surface.archived', event: event.event }
  if (event.kind === 'pinned') return { type: 'surface.pinned', event: event.event }
  if (event.kind === 'moved') return { type: 'surface.moved', event: event.event }
  if (event.kind === 'presentation') return { type: 'surface.presentation', event: event.event }
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
