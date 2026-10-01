import {
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  type AutomationOutcomeNotification,
  type AuthStatus,
  type AtomNode,
  type ChatMessage,
  type GatewayServerMessage,
  type JsonObject,
  type JsonValue,
  type FastSurfaceActionResult,
  type PendingDecisionResolution,
  type Surface,
  type SurfaceMoveDirection,
} from '@veduta/protocol'
import * as defaultApi from './api.ts'
import {
  applyTurnFrame,
  interruptTurns,
  type ChatTurnFrame,
  type StreamingTurn,
} from './chat-turn-state.ts'
import { cachedSnapshot, saveSnapshot, type SurfaceStreamEvent } from './home-state.ts'
import type { HomeSpacesLoadState } from './home-space-grid.tsx'
import { LiveSurfaceProjection } from './live-surface-projection.ts'
import { LiveDecisionProjection } from './live-decision-projection.ts'
import { LiveNotificationProjection } from './live-notification-projection.ts'
import { appendAuthoritativeChatEntry } from './pending-decision-state.ts'
import {
  AUTH_TOKEN_KEY,
  HOME_CACHE_KEY,
  SURFACE_ORDER_KEY,
  CHAT_HISTORY_LIMIT,
  readChatHistory,
  readQueuedChat,
  readQueuedFastActions,
  persistChatHistory,
  persistQueuedChat,
  persistQueuedFastActions,
  queuedChatEntry,
  type QueuedChat,
  type QueuedFastAction,
} from './pwa-storage.ts'
import {
  affectedAtomIdsForPatch,
  affectedAtomIdsForStateKey,
  type SurfaceUpdateFeedback,
} from './surface-motion.ts'

type Presence = Extract<GatewayServerMessage, { type: 'presence.update' }>['presence']
export type LivePresentationEvent = {
  sequence: number
  frame: Extract<GatewayServerMessage, { type: 'surface.created' }> | ChatTurnFrame
  clientId: string | undefined
  pendingTurnIds: string[]
}

export interface PwaLiveStateSnapshot {
  readonly spaces: defaultApi.SpaceWithSurfaces[]
  readonly surfaceCursor: number
  readonly homeSpacesLoadState: HomeSpacesLoadState
  readonly authToken: string | undefined
  readonly authStatus: AuthStatus | undefined
  readonly gatewayOnline: boolean
  readonly error: string | null
  readonly chatEntries: ChatMessage[]
  readonly streamingTurns: StreamingTurn[]
  readonly presence: Presence
  readonly pendingDecisions: ReturnType<LiveDecisionProjection['decisions']['slice']>
  readonly resolvingDecisionIds: string[]
  readonly automationOutcomeNotifications: AutomationOutcomeNotification[]
  readonly pendingAutomationOutcomeNotificationIds: string[]
  readonly queuedChat: QueuedChat[]
  readonly queuedFastActions: QueuedFastAction[]
  readonly surfaceUpdateFeedbacks: Record<string, SurfaceUpdateFeedback>
  readonly presentationEvents: LivePresentationEvent[]
  readonly connectionGeneration: number
}

type RuntimeApi = Pick<
  typeof defaultApi,
  | 'fetchAuthStatus'
  | 'fetchSpaces'
  | 'connectGateway'
  | 'fetchPendingDecisions'
  | 'resolvePendingDecision'
  | 'fetchAutomationOutcomeNotifications'
  | 'openAutomationOutcomeNotification'
  | 'dismissAutomationOutcomeNotification'
  | 'markSpaceAttentionSeen'
  | 'pinSurface'
  | 'moveSurface'
  | 'invokeFastAction'
  | 'invokeSurfaceAction'
>

export interface PwaLiveStateRuntimeOptions {
  storage?: Storage
  api?: RuntimeApi
}

/** The concrete PWA's sole owner of live projection, transport, recovery, and queued intent. */
export class PwaLiveStateRuntime {
  private readonly api: RuntimeApi
  private readonly storage: Storage
  private readonly surfaces: LiveSurfaceProjection
  private readonly decisions: LiveDecisionProjection
  private readonly notifications: LiveNotificationProjection
  private readonly listeners = new Set<() => void>()
  private snapshot!: PwaLiveStateSnapshot
  private started = false
  private epoch = 0
  private connectionGeneration = 0
  private gateway: defaultApi.GatewayConnection | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay = 1000
  private clientId: string | undefined
  private online = false
  private token: string | undefined
  private authStatus: AuthStatus | undefined
  private loadState: HomeSpacesLoadState
  private error: string | null = null
  private chatEntries: ChatMessage[]
  private turns = new Map<string, StreamingTurn>()
  private presence: Presence = []
  private queuedChat: QueuedChat[]
  private queuedFastActions: QueuedFastAction[]
  private queueFlush: Promise<void> | undefined
  private refetch: Promise<void> | undefined
  private refetchGeneration = 0
  private eventBuffer: SurfaceStreamEvent[] = []
  private surfaceUpdateFeedbacks: Record<string, SurfaceUpdateFeedback> = {}
  private feedbackSequence = 0
  private presentationEvents: LivePresentationEvent[] = []
  private optimisticSurfaces = new Map<string, { key: string; surface: Surface }>()
  private formRetryKeys = new Map<string, string>()

  constructor(options: PwaLiveStateRuntimeOptions = {}) {
    this.api = options.api ?? defaultApi
    this.storage = options.storage ?? localStorage
    const cached = cachedSnapshot(this.storage, HOME_CACHE_KEY)
    this.surfaces = new LiveSurfaceProjection(cached)
    this.loadState = cached === undefined ? 'loading' : 'ready'
    this.token = this.storage.getItem(AUTH_TOKEN_KEY) ?? undefined
    this.chatEntries = readChatHistory(this.storage)
    this.queuedChat = readQueuedChat(this.storage)
    this.queuedFastActions = readQueuedFastActions(this.storage)
    this.decisions = new LiveDecisionProjection({
      api: this.api,
      token: () => this.token,
      publish: () => this.publish(),
      feedback: (update) => this.updateChat(update(this.chatEntries)),
      refreshSpaces: () => this.refreshSpaces(),
      failed: (error) => this.failed(error),
    })
    this.notifications = new LiveNotificationProjection({
      api: this.api,
      token: () => this.token,
      publish: () => this.publish(),
      failed: (error) => this.failed(error, 'Automation notification failed'),
    })
    this.publish()
  }

  getSnapshot = (): PwaLiveStateSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const epoch = ++this.epoch
    try {
      const status = await this.api.fetchAuthStatus()
      if (!this.active(epoch)) return
      this.authStatus = status
      this.publish()
      if (status.mode === 'production' && !this.token) return
      await this.refreshSpaces()
      if (this.active(epoch)) this.connect()
    } catch (error) {
      if (!this.active(epoch)) return
      this.loadState = this.surfaces.spaces.length ? 'ready' : 'error'
      this.failed(error, this.surfaces.spaces.length ? 'Offline: showing cached Home' : undefined)
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.epoch += 1
    this.connectionGeneration += 1
    this.refetchGeneration += 1
    this.refetch = undefined
    this.eventBuffer = []
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const gateway = this.gateway
    this.gateway = undefined
    this.online = false
    this.decisions.cancel()
    this.notifications.beginConnection()
    gateway?.close()
    this.publish()
  }

  authenticate = (token: string | undefined): void => {
    this.stop()
    this.token = token
    this.clientId = undefined
    this.authStatus = undefined
    this.error = null
    if (token) this.storage.setItem(AUTH_TOKEN_KEY, token)
    else this.storage.removeItem(AUTH_TOKEN_KEY)
    this.publish()
    void this.start()
  }

  reportError = (message: string | null): void => {
    this.error = message
    this.publish()
  }

  private active(epoch: number): boolean {
    return this.started && epoch === this.epoch
  }

  private failed(error: unknown, prefix?: string): void {
    if (error instanceof defaultApi.ApiResponseError && error.status === 401) {
      this.authenticate(undefined)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    this.reportError(prefix ? `${prefix}: ${message}` : message)
  }

  private publish(): void {
    this.snapshot = freeze({
      spaces: this.surfaces.spaces.map((space) => ({
        ...space,
        surfaces: space.surfaces.map(
          (surface) => this.optimisticSurfaces.get(surface.id)?.surface ?? surface,
        ),
      })),
      surfaceCursor: this.surfaces.cursor,
      homeSpacesLoadState: this.loadState,
      authToken: this.token,
      authStatus: this.authStatus,
      gatewayOnline: this.online,
      error: this.error,
      chatEntries: this.chatEntries,
      streamingTurns: [...this.turns.values()],
      presence: this.presence,
      pendingDecisions: this.decisions?.decisions ?? [],
      resolvingDecisionIds: this.decisions?.resolvingIds ?? [],
      automationOutcomeNotifications: this.notifications?.notifications ?? [],
      pendingAutomationOutcomeNotificationIds: this.notifications?.pendingIds ?? [],
      queuedChat: this.queuedChat,
      queuedFastActions: this.queuedFastActions,
      surfaceUpdateFeedbacks: this.surfaceUpdateFeedbacks,
      presentationEvents: this.presentationEvents,
      connectionGeneration: this.connectionGeneration,
    })
    for (const listener of this.listeners) listener()
  }

  private saveSurfaces(): void {
    saveSnapshot(this.storage, HOME_CACHE_KEY, {
      spaces: this.surfaces.spaces,
      surfaceCursor: this.surfaces.cursor,
    })
  }

  private updateChat(entries: ChatMessage[]): void {
    this.chatEntries = entries.slice(-CHAT_HISTORY_LIMIT)
    persistChatHistory(this.chatEntries, this.storage)
  }

  private appendChat(entry: ChatMessage): void {
    this.updateChat(appendAuthoritativeChatEntry(this.chatEntries, entry))
  }

  private connect(): void {
    if (!this.started || this.gateway !== undefined) return
    const epoch = this.epoch
    const generation = ++this.connectionGeneration
    this.notifications.beginConnection()
    const receive = (frame: GatewayServerMessage) => {
      if (!this.active(epoch) || generation !== this.connectionGeneration) return
      this.receive(frame)
    }
    const onClose = () => {
      if (!this.active(epoch) || generation !== this.connectionGeneration) return
      this.gateway = undefined
      this.online = false
      this.refetchGeneration += 1
      this.refetch = undefined
      this.eventBuffer = []
      for (const entry of interruptTurns(this.turns)) this.appendChat(entry)
      this.turns = new Map()
      this.decisions.cancel()
      this.notifications.beginConnection()
      this.publish()
      if (this.reconnectTimer !== undefined) return
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        if (this.active(epoch)) this.connect()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    }
    this.gateway = this.api.connectGateway({
      token: this.token,
      clientId: this.clientId,
      surfaceCursor: this.surfaces.cursor,
      onHello: (surfaceCursor, clientId) =>
        receive({ type: 'hello', surfaceCursor, clientId, replayed: 0 }),
      onSurfacePatch: (event) => receive({ type: 'surface.patch', event }),
      onSurfaceCreated: receive,
      onSurfaceArchived: (event) => receive({ type: 'surface.archived', event }),
      onSurfacePinned: (event) => receive({ type: 'surface.pinned', event }),
      onSurfaceMoved: (event) => receive({ type: 'surface.moved', event }),
      onSurfacePresentation: (event) => receive({ type: 'surface.presentation', event }),
      onChatMessage: receive,
      onChatTurnStart: receive,
      onChatTurnDelta: receive,
      onChatTurnReplace: receive,
      onChatTurnEnd: receive,
      onChatTurnError: receive,
      onPendingDecisionLifecycle: receive,
      onAutomationOutcomeNotificationLifecycle: receive,
      onApprovalCard: receive,
      onPresence: receive,
      onSpaceAttention: receive,
      onError: (message) => {
        if (!this.active(epoch) || generation !== this.connectionGeneration) return
        if (
          message === 'Gateway session revoked' ||
          message === 'authenticated Gateway session required'
        ) {
          this.authenticate(undefined)
          return
        }
        this.reportError(message)
        if (message.startsWith('Malformed Gateway')) void this.refreshSpaces()
      },
      onClose,
    })
    this.publish()
  }

  private receive(input: GatewayServerMessage): void {
    const parsed = GatewayServerMessageSchema.safeParse(input)
    if (!parsed.success) {
      this.reportError('Malformed Gateway frame')
      void this.refreshSpaces()
      return
    }
    const frame = parsed.data
    switch (frame.type) {
      case 'hello':
        if (frame.surfaceCursor < this.surfaces.cursor) {
          this.refetchGeneration += 1
          this.refetch = undefined
          this.eventBuffer = []
          this.optimisticSurfaces.clear()
          this.surfaces.rebase()
        }
        this.clientId = frame.clientId
        this.reconnectDelay = 1000
        this.online = true
        this.error = null
        void this.refreshSpaces()
        void this.decisions.refresh()
        void this.notifications.refresh()
        this.flushChat()
        void this.flushActions()
        break
      case 'surface.created':
        this.present(frame)
        this.applySurfaceEvent(frame)
        break
      case 'surface.patch':
      case 'surface.archived':
      case 'surface.pinned':
      case 'surface.moved':
      case 'surface.presentation':
        this.applySurfaceEvent(frame)
        break
      case 'chat.message':
        this.appendChat(frame.message)
        break
      case 'chat.turn-start':
      case 'chat.turn-delta':
      case 'chat.turn-replace':
      case 'chat.turn-end':
      case 'chat.turn-error': {
        this.present(frame)
        if (frame.type === 'chat.turn-replace' || frame.type === 'chat.turn-end')
          this.decisions.observe(frame.message.pendingDecisions ?? [])
        const result = applyTurnFrame(this.turns, frame)
        this.turns = result.turns
        if (result.completed) this.appendChat(result.completed)
        break
      }
      case 'pending-decision.lifecycle':
        this.decisions.accept(frame)
        break
      case 'automation-outcome-notification.lifecycle':
        this.notifications.accept(frame)
        break
      case 'space.attention':
        this.surfaces.attention(frame)
        this.saveSurfaces()
        break
      case 'presence.update':
        this.presence = frame.presence
        break
      case 'error':
        this.error = frame.error
        break
      case 'approval.card':
        break
    }
    this.publish()
  }

  private present(frame: LivePresentationEvent['frame']): void {
    this.presentationEvents = [
      ...this.presentationEvents,
      {
        sequence: ++this.feedbackSequence,
        frame,
        clientId: this.clientId,
        pendingTurnIds: [...this.turns.keys()],
      },
    ].slice(-40)
  }

  private applySurfaceEvent(event: SurfaceStreamEvent): void {
    if (this.refetch !== undefined) {
      this.eventBuffer.push(event)
      return
    }
    try {
      const previous =
        event.type === 'surface.patch' ? this.findSurface(event.event.patch.surfaceId) : undefined
      if (!this.surfaces.apply(event)) {
        this.eventBuffer.push(event)
        void this.refreshSpaces()
        return
      }
      if (event.type === 'surface.patch' && previous !== undefined) {
        const current = this.findSurface(previous.id)
        if (current && current !== previous) {
          this.optimisticSurfaces.delete(current.id)
          this.feedback(
            current.id,
            affectedAtomIdsForPatch(previous, current, event.event.patch.operations),
          )
        }
      }
      this.saveSurfaces()
    } catch (error) {
      this.failed(error)
      void this.refreshSpaces()
    }
  }

  async refreshSpaces(): Promise<void> {
    if (!this.started) return
    if (this.refetch !== undefined) return this.refetch
    const epoch = this.epoch
    const generation = ++this.refetchGeneration
    const refresh = async () => {
      try {
        const snapshot = await this.api.fetchSpaces(this.token)
        if (!this.active(epoch) || generation !== this.refetchGeneration) return
        this.storage.removeItem(SURFACE_ORDER_KEY)
        this.surfaces.replace(snapshot)
        const buffered = this.eventBuffer.sort((a, b) => a.event.cursor - b.event.cursor)
        this.eventBuffer = []
        for (const event of buffered) {
          if (event.event.cursor <= snapshot.surfaceCursor) continue
          const previous =
            event.type === 'surface.patch'
              ? this.findSurface(event.event.patch.surfaceId)
              : undefined
          if (!this.surfaces.apply(event))
            this.error = `Surface update could not be applied at cursor ${event.event.cursor}`
          if (previous && previous !== this.findSurface(previous.id))
            this.optimisticSurfaces.delete(previous.id)
        }
        this.loadState = 'ready'
        this.saveSurfaces()
      } catch (error) {
        if (!this.active(epoch) || generation !== this.refetchGeneration) return
        if (this.surfaces.spaces.length === 0) this.loadState = 'error'
        this.failed(error)
      } finally {
        if (this.active(epoch) && generation === this.refetchGeneration) {
          this.refetch = undefined
          this.publish()
        }
      }
    }
    this.refetch = refresh()
    return this.refetch
  }

  retry = (): void => {
    this.stop()
    this.error = null
    if (!this.surfaces.spaces.length) this.loadState = 'loading'
    void this.start()
  }

  sendChat = (text: string, spaceId?: string): boolean => {
    const parsed = GatewayClientMessageSchema.safeParse({
      type: 'chat.send',
      text,
      ...(spaceId ? { spaceId } : {}),
    })
    if (!parsed.success) {
      this.reportError('Invalid Chat message')
      return false
    }
    this.appendChat({ role: 'user', text })
    const sent = this.online && (this.gateway?.sendChat(text, spaceId) ?? false)
    if (!sent) {
      this.queuedChat = [...this.queuedChat, queuedChatEntry(text, spaceId)]
      persistQueuedChat(this.queuedChat, this.storage)
    }
    this.publish()
    return true
  }

  private flushChat(): void {
    if (!this.online) return
    this.queuedChat = this.queuedChat.filter(
      (entry) => !this.gateway?.sendChat(entry.text, entry.spaceId),
    )
    persistQueuedChat(this.queuedChat, this.storage)
  }

  queueFastAction = (action: QueuedFastAction): void => {
    if (!this.started) return
    if (this.queuedFastActions.some((candidate) => candidate.id === action.id)) return
    this.queuedFastActions = [...this.queuedFastActions, action]
    persistQueuedFastActions(this.queuedFastActions, this.storage)
    this.publish()
    if (this.online) void this.flushActions()
  }

  private async flushActions(): Promise<void> {
    if (!this.online) return
    if (this.queueFlush) return this.queueFlush
    const epoch = this.epoch
    const queued = [...this.queuedFastActions]
    const flush = async () => {
      for (const action of queued) {
        if (!this.active(epoch) || !this.online) break
        try {
          const result = await this.api.invokeFastAction(
            action.surfaceId,
            action.nodeId,
            action.actionName,
            action.value,
            this.token,
            action.idempotencyKey,
          )
          if (!this.active(epoch)) return
          this.confirmSurface(result.surface, undefined, result.surfaceCursor)
          this.clearOptimistic(action.surfaceId, action.idempotencyKey)
          this.queuedFastActions = this.queuedFastActions.filter(
            (candidate) => candidate.id !== action.id,
          )
          persistQueuedFastActions(this.queuedFastActions, this.storage)
        } catch (error) {
          if (this.active(epoch)) this.failed(error)
        }
      }
    }
    this.queueFlush = flush()
    try {
      await this.queueFlush
    } finally {
      this.queueFlush = undefined
      this.publish()
      if (epoch !== this.epoch && this.online) void this.flushActions()
    }
  }

  confirmSurface = (surface: Surface, atomIds?: readonly string[], cursor?: number): void => {
    try {
      if (!this.surfaces.confirmSurface(surface, cursor)) return
      if (atomIds) this.feedback(surface.id, atomIds)
      this.saveSurfaces()
      this.publish()
    } catch (error) {
      this.failed(error)
    }
  }

  private feedback(surfaceId: string, atomIds: readonly string[]): void {
    if (!atomIds.length) return
    this.surfaceUpdateFeedbacks = {
      ...this.surfaceUpdateFeedbacks,
      [surfaceId]: {
        key: `live-update:${surfaceId}:${++this.feedbackSequence}`,
        atomIds,
      },
    }
  }

  private findSurface(id: string): Surface | undefined {
    return this.surfaces.spaces
      .flatMap((space) => space.surfaces)
      .find((surface) => surface.id === id)
  }

  async dispatchSurfaceAction(
    surfaceId: string,
    nodeId: string,
    name: string,
    value?: JsonValue,
  ): Promise<void> {
    const surface = this.findSurface(surfaceId)
    const node = surface && findNode(surface.tree, nodeId)
    const action = node?.actions?.find((action) => action.name === name)
    if (!surface || !node || !action) {
      this.reportError(`Surface update failed: undeclared action "${name}"`)
      return
    }
    if (action.path === 'agent') {
      const payload = value === undefined ? action.payload : { ...action.payload, value }
      try {
        await this.invokeAction(surfaceId, nodeId, name, payload)
      } catch (error) {
        this.failed(error, `"${surface.title}" action failed`)
      }
      return
    }
    const form = action.stateKeys !== undefined
    if (
      value === undefined ||
      (form && (value === null || typeof value !== 'object' || Array.isArray(value)))
    ) {
      const error = new Error(`fast action "${name}" did not provide its declared input`)
      this.failed(error, `"${surface.title}" update failed`)
      if (form) throw error
      return
    }
    const scope = JSON.stringify({ surfaceId, nodeId, name })
    const fingerprint = `${scope}:${JSON.stringify(value)}`
    const initialKey = defaultApi.fastActionIdempotencyKey({
      surfaceId,
      surfaceUpdatedAt: surface.freshness.updatedAt,
      nodeId,
      actionName: name,
      value,
    })
    const key = form ? (this.formRetryKeys.get(fingerprint) ?? initialKey) : initialKey
    if (form) this.formRetryKeys.set(fingerprint, key)
    else {
      const optimistic = defaultApi.optimisticFastSurface(surface, node, name, value)
      this.optimisticSurfaces.set(surfaceId, { key, surface: optimistic })
      this.feedback(
        surfaceId,
        action.stateKey ? affectedAtomIdsForStateKey(surface.tree, action.stateKey) : [nodeId],
      )
      this.publish()
    }
    const epoch = this.epoch
    const generation = this.connectionGeneration
    try {
      const result = await this.api.invokeFastAction(
        surfaceId,
        nodeId,
        name,
        value,
        this.token,
        key,
      )
      if (!this.active(epoch) || generation !== this.connectionGeneration) return
      this.clearOptimistic(surfaceId, key)
      const atomIds = form
        ? [
            ...new Set(
              action.stateKeys?.flatMap((stateKey) =>
                affectedAtomIdsForStateKey(result.surface.tree, stateKey),
              ),
            ),
          ]
        : undefined
      this.confirmSurface(result.surface, atomIds, result.surfaceCursor)
      for (const fingerprint of this.formRetryKeys.keys())
        if (fingerprint.startsWith(`${scope}:`)) this.formRetryKeys.delete(fingerprint)
      this.publish()
    } catch (error) {
      if (!this.active(epoch)) return
      if (form) {
        this.failed(error, `"${surface.title}" update failed`)
        throw error
      }
      this.queueFastAction({
        id: key,
        surfaceId,
        nodeId,
        actionName: name,
        value,
        idempotencyKey: key,
        at: new Date().toISOString(),
      })
      this.failed(error, `"${surface.title}" update queued`)
    }
  }

  private clearOptimistic(surfaceId: string, key: string): void {
    if (this.optimisticSurfaces.get(surfaceId)?.key === key)
      this.optimisticSurfaces.delete(surfaceId)
  }

  async togglePin(surface: Surface): Promise<void> {
    const epoch = this.epoch
    try {
      const result = await this.api.pinSurface(surface.id, !surface.pinned, this.token)
      if (!this.active(epoch)) return
      if (!this.surfaces.confirmOrder(result.order, result.surface))
        throw new Error('Pin order could not be applied')
      this.saveSurfaces()
      this.publish()
    } catch (error) {
      if (this.active(epoch)) this.failed(error, `"${surface.title}" pin failed`)
    }
  }

  async moveSurface(
    spaceId: string,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ): Promise<void> {
    const epoch = this.epoch
    try {
      const result = await this.api.moveSurface(spaceId, surfaceId, direction, this.token)
      if (!this.active(epoch)) return
      if (!this.surfaces.confirmOrder(result.order))
        throw new Error('Move order could not be applied')
      this.saveSurfaces()
      this.publish()
    } catch (error) {
      if (this.active(epoch)) this.failed(error, 'Surface move failed')
    }
  }

  focus = (spaceId: string | undefined, focusKey: string): void => {
    if (this.notifications.focus(spaceId, focusKey) && this.online)
      void this.notifications.refresh()
    const space = this.surfaces.spaces.find((space) => space.id === spaceId)
    if (space && space.attention > 0 && this.online) {
      const epoch = this.epoch
      void this.api
        .markSpaceAttentionSeen(space.id, this.token)
        .then((result) => {
          if (!this.active(epoch)) return
          this.surfaces.attention({ spaceId: space.id, ...result })
          this.saveSurfaces()
          this.publish()
        })
        .catch((error) => {
          if (this.active(epoch)) this.failed(error)
        })
    }
    this.publish()
  }

  resolveDecision = (id: string, resolution: PendingDecisionResolution): Promise<void> =>
    this.decisions.resolve(id, resolution)
  actOnNotification = (
    notification: AutomationOutcomeNotification,
    action: 'open' | 'dismiss',
  ): Promise<string | undefined> => this.notifications.act(notification, action)

  async invokeAction(
    surfaceId: string,
    nodeId: string,
    name: string,
    payload?: JsonObject,
    idempotencyKey?: string,
  ): Promise<defaultApi.SurfaceActionResponse> {
    const epoch = this.epoch
    const result = await this.api.invokeSurfaceAction(
      surfaceId,
      nodeId,
      name,
      payload,
      this.token,
      idempotencyKey,
    )
    if (this.active(epoch) && 'surface' in result)
      this.confirmSurface(result.surface, undefined, result.surfaceCursor)
    return result
  }

  async invokeFastValue(
    surfaceId: string,
    nodeId: string,
    name: string,
    value: JsonValue,
    idempotencyKey?: string,
  ): Promise<FastSurfaceActionResult> {
    const epoch = this.epoch
    const result = await this.api.invokeFastAction(
      surfaceId,
      nodeId,
      name,
      value,
      this.token,
      idempotencyKey,
    )
    if (this.active(epoch)) this.confirmSurface(result.surface, undefined, result.surfaceCursor)
    return result
  }
}

export function createPwaLiveStateRuntime(
  options?: PwaLiveStateRuntimeOptions,
): PwaLiveStateRuntime {
  return new PwaLiveStateRuntime(options)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}

function findNode(node: AtomNode, id: string): AtomNode | undefined {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}
