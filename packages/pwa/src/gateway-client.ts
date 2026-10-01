import {
  RenderableGatewayServerMessageSchema,
  GatewayClientMessageSchema,
  type RenderableGatewayServerMessage,
  type SurfaceArchivedEvent,
  type SurfaceMovedEvent,
  type RenderableSurfacePatchEvent,
  type SurfacePinnedEvent,
  type SurfacePresentationEvent,
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
  onSurfacePatch(event: RenderableSurfacePatchEvent): void
  onSurfaceCreated(
    message: Extract<RenderableGatewayServerMessage, { type: 'surface.created' }>,
  ): void
  onSurfaceArchived(event: SurfaceArchivedEvent): void
  onSurfacePinned(event: SurfacePinnedEvent): void
  onSurfaceMoved(event: SurfaceMovedEvent): void
  onSurfacePresentation(event: SurfacePresentationEvent): void
  onChatMessage(message: Extract<RenderableGatewayServerMessage, { type: 'chat.message' }>): void
  onChatTurnStart(
    message: Extract<RenderableGatewayServerMessage, { type: 'chat.turn-start' }>,
  ): void
  onChatTurnDelta(
    message: Extract<RenderableGatewayServerMessage, { type: 'chat.turn-delta' }>,
  ): void
  onChatTurnReplace(
    message: Extract<RenderableGatewayServerMessage, { type: 'chat.turn-replace' }>,
  ): void
  onChatTurnEnd(message: Extract<RenderableGatewayServerMessage, { type: 'chat.turn-end' }>): void
  onChatTurnError(
    message: Extract<RenderableGatewayServerMessage, { type: 'chat.turn-error' }>,
  ): void
  onPendingDecisionLifecycle(
    message: Extract<RenderableGatewayServerMessage, { type: 'pending-decision.lifecycle' }>,
  ): void
  onAutomationOutcomeNotificationLifecycle(
    message: Extract<
      RenderableGatewayServerMessage,
      { type: 'automation-outcome-notification.lifecycle' }
    >,
  ): void
  onApprovalCard(message: Extract<RenderableGatewayServerMessage, { type: 'approval.card' }>): void
  onPresence(message: Extract<RenderableGatewayServerMessage, { type: 'presence.update' }>): void
  onSpaceAttention(
    message: Extract<RenderableGatewayServerMessage, { type: 'space.attention' }>,
  ): void
  onError(message: string): void
  onClose(): void
}

export function connectGateway(handlers: GatewayHandlers): GatewayConnection {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws/gateway`)

  socket.onopen = () => {
    socket.send(
      JSON.stringify(
        GatewayClientMessageSchema.parse({
          type: 'hello',
          surfaceCursor: handlers.surfaceCursor,
          token: handlers.token,
          ...(handlers.clientId ? { clientId: handlers.clientId } : {}),
        }),
      ),
    )
  }

  socket.onmessage = (event) => {
    const message = parseGatewayMessage(event.data)
    if (message) dispatchGatewayMessage(handlers, message)
    else handlers.onError('Malformed Gateway frame; refreshing confirmed state.')
  }
  socket.onclose = () => handlers.onClose()

  return {
    close: () => socket.close(),
    sendChat(text, spaceId) {
      if (socket.readyState !== WebSocket.OPEN) return false
      socket.send(
        JSON.stringify(
          GatewayClientMessageSchema.parse({
            type: 'chat.send',
            text,
            ...(spaceId ? { spaceId } : {}),
          }),
        ),
      )
      return true
    },
  }
}

function parseGatewayMessage(input: unknown): RenderableGatewayServerMessage | undefined {
  let json: unknown
  try {
    json = JSON.parse(String(input))
  } catch {
    return undefined
  }
  const parsed = RenderableGatewayServerMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

function dispatchGatewayMessage(
  handlers: GatewayHandlers,
  message: RenderableGatewayServerMessage,
): void {
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
    case 'surface.presentation':
      handlers.onSurfacePresentation(message.event)
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
    case 'chat.turn-replace':
      handlers.onChatTurnReplace(message)
      break
    case 'chat.turn-end':
      handlers.onChatTurnEnd(message)
      break
    case 'chat.turn-error':
      handlers.onChatTurnError(message)
      break
    case 'pending-decision.lifecycle':
      handlers.onPendingDecisionLifecycle(message)
      break
    case 'automation-outcome-notification.lifecycle':
      handlers.onAutomationOutcomeNotificationLifecycle(message)
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
