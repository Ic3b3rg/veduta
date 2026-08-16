import {
  GatewayServerMessageSchema,
  type GatewayServerMessage,
  type SurfaceArchivedEvent,
  type SurfaceMovedEvent,
  type SurfacePatchEvent,
  type SurfacePinnedEvent,
} from '@veduta/protocol'

export interface GatewayConnection {
  close(): void
  sendChat(text: string, spaceId?: string): boolean
}

export interface GatewayHandlers {
  token?: string | undefined
  /** Reuses this tab's Gateway identity after a reconnect (issue 037). */
  clientId?: string | undefined
  surfaceCursor: number
  onHello(cursor: number, clientId: string): void
  onSurfacePatch(event: SurfacePatchEvent): void
  onSurfaceCreated(message: Extract<GatewayServerMessage, { type: 'surface.created' }>): void
  onSurfaceArchived(event: SurfaceArchivedEvent): void
  onSurfacePinned(event: SurfacePinnedEvent): void
  onSurfaceMoved(event: SurfaceMovedEvent): void
  onChatMessage(message: Extract<GatewayServerMessage, { type: 'chat.message' }>): void
  onChatTurnStart(message: Extract<GatewayServerMessage, { type: 'chat.turn-start' }>): void
  onChatTurnDelta(message: Extract<GatewayServerMessage, { type: 'chat.turn-delta' }>): void
  onChatTurnEnd(message: Extract<GatewayServerMessage, { type: 'chat.turn-end' }>): void
  onChatTurnError(message: Extract<GatewayServerMessage, { type: 'chat.turn-error' }>): void
  onApprovalCard(message: Extract<GatewayServerMessage, { type: 'approval.card' }>): void
  onPresence(message: Extract<GatewayServerMessage, { type: 'presence.update' }>): void
  onSpaceAttention(message: Extract<GatewayServerMessage, { type: 'space.attention' }>): void
  onError(message: string): void
  onClose(): void
}

export function connectGateway(handlers: GatewayHandlers): GatewayConnection {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws/gateway`)

  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        surfaceCursor: handlers.surfaceCursor,
        token: handlers.token,
        ...(handlers.clientId ? { clientId: handlers.clientId } : {}),
      }),
    )
  }

  socket.onmessage = (event) => {
    const message = parseGatewayMessage(event.data)
    if (message) dispatchGatewayMessage(handlers, message)
  }
  socket.onclose = () => handlers.onClose()

  return {
    close: () => socket.close(),
    sendChat(text, spaceId) {
      if (socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify({ type: 'chat.send', text, ...(spaceId ? { spaceId } : {}) }))
      return true
    },
  }
}

function parseGatewayMessage(input: unknown): GatewayServerMessage | undefined {
  let json: unknown
  try {
    json = JSON.parse(String(input))
  } catch {
    return undefined
  }
  const parsed = GatewayServerMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

function dispatchGatewayMessage(handlers: GatewayHandlers, message: GatewayServerMessage): void {
  switch (message.type) {
    case 'hello':
      handlers.onHello(message.surfaceCursor, message.clientId)
      break
    case 'surface.patch':
      handlers.onSurfacePatch(message.event)
      break
    case 'surface.created':
      handlers.onSurfaceCreated(message)
      break
    case 'surface.archived':
      handlers.onSurfaceArchived(message.event)
      break
    case 'surface.pinned':
      handlers.onSurfacePinned(message.event)
      break
    case 'surface.moved':
      handlers.onSurfaceMoved(message.event)
      break
    case 'chat.message':
      handlers.onChatMessage(message)
      break
    case 'chat.turn-start':
      handlers.onChatTurnStart(message)
      break
    case 'chat.turn-delta':
      handlers.onChatTurnDelta(message)
      break
    case 'chat.turn-end':
      handlers.onChatTurnEnd(message)
      break
    case 'chat.turn-error':
      handlers.onChatTurnError(message)
      break
    case 'approval.card':
      handlers.onApprovalCard(message)
      break
    case 'presence.update':
      handlers.onPresence(message)
      break
    case 'space.attention':
      handlers.onSpaceAttention(message)
      break
    case 'error':
      handlers.onError(message.error)
      break
  }
}
