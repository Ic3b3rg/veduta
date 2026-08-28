import {
  pendingDecisionFeedback,
  type ApprovalCard,
  type ChatMessage,
  type GatewayServerMessage,
  type OnboardingStatus,
  type PendingDecision,
  type PendingDecisionResolution,
  type Surface,
  type SurfaceMoveDirection,
  type SurfaceOrder,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { dismissCardsForSurface } from './approval-cards.tsx'
import {
  ApiResponseError,
  connectGateway,
  fetchAuthStatus,
  fetchOnboardingStatus,
  fetchSpaces,
  invokeFastAction,
  markSpaceAttentionSeen,
  moveSurface as requestSurfaceMove,
  pinSurface,
  resolvePendingDecision,
  type GatewayConnection,
  type SpaceWithSurfaces,
} from './api.ts'
import { AuthGate } from './auth-gate.tsx'
import { OnboardingWizard } from './onboarding-wizard.tsx'
import { SettingsModelConnections } from './settings-model-connections.tsx'
import {
  applyTurnFrame,
  interruptTurns,
  type ChatTurnFrame,
  type StreamingTurn,
} from './chat-turn-state.ts'
import { ClientRouteTable, clientPath, useClientRouting } from './client-router.tsx'
import {
  applyBufferedSurfaceStreamEvents,
  applySpaceAttention,
  applySurfaceOrderToSpaces,
  applySurfaceStreamEvent,
  cachedSnapshot,
  mergeSpaceAttention,
  saveSnapshot,
  surfaceOrderForStreamEvent,
  type SurfaceStreamEvent,
} from './home-state.ts'
import type { HomeSpacesLoadState } from './home-space-grid.tsx'
import { AppShell, type AppRouteSelection } from './app-shell.tsx'
import { homeBlockedByStatusFailure } from './onboarding-state.ts'
import { appendAuthoritativeChatEntry } from './pending-decision-state.ts'
import {
  AUTH_TOKEN_KEY,
  CHAT_HISTORY_LIMIT,
  HOME_CACHE_KEY,
  INSTALL_DISMISSED_KEY,
  SURFACE_ORDER_KEY,
  isStandalone,
  persistChatHistory,
  persistQueuedChat,
  persistQueuedFastActions,
  queuedChatEntry,
  readChatHistory,
  readQueuedChat,
  readQueuedFastActions,
  type BrowserInstallPromptEvent,
  type QueuedFastAction,
} from './pwa-storage.ts'
import { syncPush } from './push.ts'
import { useSurfaceCreationFeedback } from './surface-creation-feedback.ts'
import { usePendingDecisionSync } from './use-pending-decision-sync.ts'
import { affectedAtomIdsForPatch, type SurfaceUpdateFeedback } from './surface-motion.ts'
import './app.css'

export function App() {
  return (
    <BrowserRouter>
      <RoutedApp />
    </BrowserRouter>
  )
}

function RoutedApp() {
  const {
    navigate,
    locationKey,
    spaceSlug: focusedSpaceSlug,
    surfaceId: focusedSurfaceId,
  } = useClientRouting()
  const [cachedHome] = useState(() => cachedSnapshot(localStorage, HOME_CACHE_KEY))
  const [spaces, setSpaces] = useState<SpaceWithSurfaces[]>(() => cachedHome?.spaces ?? [])
  const [homeSpacesLoadState, setHomeSpacesLoadState] = useState<HomeSpacesLoadState>(() =>
    cachedHome === undefined ? 'loading' : 'ready',
  )
  const [error, setError] = useState<string | null>(null)
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>(readChatHistory)
  const [approvalCards, setApprovalCards] = useState<ApprovalCard[]>([])
  const [queuedChat, setQueuedChat] = useState(readQueuedChat)
  const [queuedFastActions, setQueuedFastActions] = useState(readQueuedFastActions)
  const [authToken, setAuthToken] = useState<string | undefined>(
    () => localStorage.getItem(AUTH_TOKEN_KEY) ?? undefined,
  )
  const [authMode, setAuthMode] = useState<'dev' | 'production' | undefined>(undefined)
  const [bootstrapRequired, setBootstrapRequired] = useState(false)
  const [passkeyRegistered, setPasskeyRegistered] = useState(false)
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [onboardingLoad, setOnboardingLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [gatewayOnline, setGatewayOnline] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BrowserInstallPromptEvent | null>(null)
  const [showInstallGuide, setShowInstallGuide] = useState(
    () => !isStandalone() && localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1',
  )
  const [streamingTurns, setStreamingTurns] = useState<Map<string, StreamingTurn>>(new Map())
  const [surfaceUpdateFeedbacks, setSurfaceUpdateFeedbacks] = useState<
    Record<string, SurfaceUpdateFeedback>
  >({})
  const {
    feedbackKeys: surfaceCreationFeedbackKeys,
    registerLiveCreation,
    acknowledge: acknowledgeSurfaceCreationFeedback,
  } = useSurfaceCreationFeedback()
  const [onboardingRetryToken, setOnboardingRetryToken] = useState(0)
  const [spacesRetryToken, setSpacesRetryToken] = useState(0)
  const gatewayRef = useRef<GatewayConnection | null>(null)
  const spacesRef = useRef<SpaceWithSurfaces[]>(cachedHome?.spaces ?? [])
  const surfaceCursorRef = useRef(cachedHome?.surfaceCursor ?? 0)
  const surfaceOrderCursorsRef = useRef<Record<string, number>>(
    Object.fromEntries(
      (cachedHome?.spaces ?? []).map((space) => [space.id, cachedHome?.surfaceCursor ?? 0]),
    ),
  )
  const fastFeedbackSequenceRef = useRef(0)
  const streamingTurnsRef = useRef<Map<string, StreamingTurn>>(new Map())
  // Last clientId this tab was assigned by the Gateway (issue 037), sent
  // back on the next reconnect hello so the daemon re-binds the same
  // session to the new socket instead of allocating a fresh id -- see
  // `applyIncomingTurnFrame`/`onClose` below for why a stale clientId would
  // otherwise strand a turn's closing frame.
  const clientIdRef = useRef<string | undefined>(undefined)
  const resetUnauthorizedSession = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY)
    setAuthToken(undefined)
    setOnboardingStatus(null)
    setOnboardingLoad('loading')
    setError(null)
  }, [])

  const {
    showPendingDecisionFeedback,
    handlePendingDecisionLifecycle,
    refreshPendingDecisionSnapshot,
    cancelPendingDecisionSnapshot,
  } = usePendingDecisionSync({
    authToken,
    setChatEntries,
    setApprovalCards,
    onUnauthorized: resetUnauthorizedSession,
  })

  const replaceSpaces = useCallback(
    (next: SpaceWithSurfaces[], cursor = surfaceCursorRef.current) => {
      spacesRef.current = next
      surfaceCursorRef.current = cursor
      setSpaces(next)
      saveSnapshot(localStorage, HOME_CACHE_KEY, { spaces: next, surfaceCursor: cursor })
    },
    [],
  )

  const appendChatEntry = useCallback((entry: ChatMessage) => {
    setChatEntries((prev) => appendAuthoritativeChatEntry(prev, entry).slice(-CHAT_HISTORY_LIMIT))
  }, [])

  // Streamed Agent turns (issue 037: PWA-side streaming): `chat.turn-start`/`-delta` only
  // ever touch `streamingTurns` (never localStorage-backed `chatEntries`,
  // one persist per closed turn); `chat.turn-end`/`-error` remove the turn
  // from the map and append its final text (or a readable error) as a single
  // `appendChatEntry` call. `streamingTurnsRef` mirrors `spacesRef`'s
  // pattern above: the map is read fresh here rather than closing over
  // `streamingTurns` state, since these Gateway handlers are wired once in
  // the connection effect below.
  const applyIncomingTurnFrame = useCallback(
    (frame: ChatTurnFrame) => {
      const result = applyTurnFrame(streamingTurnsRef.current, frame)
      streamingTurnsRef.current = result.turns
      setStreamingTurns(result.turns)
      if (result.completed) appendChatEntry(result.completed)
    },
    [appendChatEntry],
  )

  // localStorage writes live in effects so setState updaters stay pure.
  useEffect(() => persistChatHistory(chatEntries), [chatEntries])
  useEffect(() => persistQueuedChat(queuedChat), [queuedChat])
  useEffect(() => persistQueuedFastActions(queuedFastActions), [queuedFastActions])

  const replaceSurface = useCallback(
    (updated: Surface, affectedAtomIds?: readonly string[]) => {
      if (affectedAtomIds && affectedAtomIds.length > 0) {
        fastFeedbackSequenceRef.current += 1
        setSurfaceUpdateFeedbacks((current) => ({
          ...current,
          [updated.id]: {
            key: `fast:${fastFeedbackSequenceRef.current}`,
            atomIds: affectedAtomIds,
          },
        }))
      }
      replaceSpaces(
        spacesRef.current.map((space) => ({
          ...space,
          surfaces: space.surfaces.map((surface) =>
            surface.id === updated.id ? updated : surface,
          ),
        })),
      )
    },
    [replaceSpaces],
  )

  const acceptCanonicalSnapshot = useCallback(
    (snapshot: SurfaceSnapshot) => {
      localStorage.removeItem(SURFACE_ORDER_KEY)
      surfaceOrderCursorsRef.current = Object.fromEntries(
        snapshot.spaces.map((space) => [space.id, snapshot.surfaceCursor]),
      )
      replaceSpaces(snapshot.spaces, snapshot.surfaceCursor)
      setHomeSpacesLoadState('ready')
    },
    [replaceSpaces],
  )

  const applyConfirmedSurfaceOrder = useCallback(
    (order: SurfaceOrder, updatedSurface?: Surface) => {
      const currentOrderCursor = surfaceOrderCursorsRef.current[order.spaceId] ?? 0
      if (order.cursor < currentOrderCursor) return
      const withUpdatedSurface =
        updatedSurface === undefined
          ? spacesRef.current
          : spacesRef.current.map((space) => ({
              ...space,
              surfaces: space.surfaces.map((surface) =>
                surface.id === updatedSurface.id ? updatedSurface : surface,
              ),
            }))
      const result = applySurfaceOrderToSpaces(withUpdatedSurface, order)
      if (!result.applied) {
        setError(`authoritative Surface order for Space ${order.spaceId} could not be applied`)
        return
      }
      surfaceOrderCursorsRef.current = {
        ...surfaceOrderCursorsRef.current,
        [order.spaceId]: order.cursor,
      }
      // An HTTP mutation response is not a replay checkpoint: it may race
      // earlier events for another Space, so keep the global cursor where
      // the ordered WebSocket stream last advanced it.
      replaceSpaces(result.spaces)
    },
    [replaceSpaces],
  )

  // Pin toggle (issue 022): no optimistic flip -- `SurfaceCard` renders
  // `surface.pinned` straight from the snapshot, so the toggle keeps
  // showing the server's last known state until the request resolves
  // (`replaceSurface`) or a `surface.pinned` stream event arrives. A failed
  // request never leaves a flipped toggle behind because nothing was
  // flipped locally in the first place.
  const togglePin = useCallback(
    (surface: Surface, pinned: boolean) => {
      pinSurface(surface.id, pinned, authToken)
        .then((result) => applyConfirmedSurfaceOrder(result.order, result.surface))
        .catch((e: Error) => setError(`"${surface.title}" pin failed: ${e.message}`))
    },
    [applyConfirmedSurfaceOrder, authToken],
  )

  const queueFastAction = useCallback((action: QueuedFastAction) => {
    setQueuedFastActions((prev) =>
      prev.some((queued) => queued.id === action.id) ? prev : [...prev, action],
    )
  }, [])

  // Surface lifecycle stream (R2-M2): surface.patch / surface.created /
  // surface.archived can arrive for a Space or Surface this client hasn't
  // seen yet (e.g. right after a reconnect). Rather than erroring straight
  // away, refetch the /api/spaces snapshot and replay whatever arrived
  // meanwhile, in cursor order, once it lands.
  const refetchingRef = useRef(false)
  const bufferedStreamEventsRef = useRef<SurfaceStreamEvent[]>([])

  const refetchAndReplay = useCallback(() => {
    if (refetchingRef.current) return
    refetchingRef.current = true

    fetchSpaces(authToken)
      .then((snapshot) => {
        const buffered = bufferedStreamEventsRef.current
        bufferedStreamEventsRef.current = []
        refetchingRef.current = false
        localStorage.removeItem(SURFACE_ORDER_KEY)
        surfaceOrderCursorsRef.current = Object.fromEntries(
          snapshot.spaces.map((space) => [space.id, snapshot.surfaceCursor]),
        )

        // Revision-wins (home-state.ts): a space.attention frame may have
        // landed on spacesRef.current while this refetch was in flight —
        // the refetched snapshot must not clobber it with a stale count.
        const reconciled = mergeSpaceAttention(snapshot.spaces, spacesRef.current)
        const replay = applyBufferedSurfaceStreamEvents(
          reconciled,
          snapshot.surfaceCursor,
          buffered,
        )
        const unresolved = new Set(replay.unresolved)
        for (const streamEvent of buffered) {
          if (unresolved.has(streamEvent) || streamEvent.event.cursor <= snapshot.surfaceCursor) {
            continue
          }
          const order = surfaceOrderForStreamEvent(streamEvent)
          if (!order) continue
          surfaceOrderCursorsRef.current[order.spaceId] = Math.max(
            surfaceOrderCursorsRef.current[order.spaceId] ?? 0,
            order.cursor,
          )
        }
        replaceSpaces(replay.spaces, replay.cursor)
        for (const unresolved of replay.unresolved) {
          setError(surfaceStreamEventErrorMessage(unresolved))
        }
      })
      .catch((e: Error) => {
        refetchingRef.current = false
        setError(`failed to refetch Spaces snapshot: ${e.message}`)
      })
  }, [authToken, replaceSpaces])

  const handleSurfaceStreamEvent = useCallback(
    (streamEvent: SurfaceStreamEvent) => {
      // Idempotent and independent of whether the Space/Surface is known
      // yet, so the chip clears even if this event is about to be buffered.
      if (streamEvent.type === 'surface.archived') {
        setApprovalCards((prev) => dismissCardsForSurface(prev, streamEvent.event.surfaceId))
      }

      if (refetchingRef.current) {
        bufferedStreamEventsRef.current.push(streamEvent)
        return
      }

      try {
        const previousSurface =
          streamEvent.type === 'surface.patch'
            ? findSurface(spacesRef.current, streamEvent.event.patch.surfaceId)
            : undefined
        const order = surfaceOrderForStreamEvent(streamEvent)
        if (order && order.cursor < (surfaceOrderCursorsRef.current[order.spaceId] ?? 0)) {
          replaceSpaces(
            spacesRef.current,
            Math.max(surfaceCursorRef.current, streamEvent.event.cursor),
          )
          return
        }
        const result = applySurfaceStreamEvent(spacesRef.current, streamEvent)
        if (!result.applied) {
          bufferedStreamEventsRef.current.push(streamEvent)
          refetchAndReplay()
          return
        }
        if (order) {
          surfaceOrderCursorsRef.current[order.spaceId] = order.cursor
        }
        if (streamEvent.type === 'surface.patch' && previousSurface) {
          const nextSurface = findSurface(result.spaces, streamEvent.event.patch.surfaceId)
          if (nextSurface) {
            const atomIds = affectedAtomIdsForPatch(
              previousSurface,
              nextSurface,
              streamEvent.event.patch.operations,
            )
            if (atomIds.length > 0) {
              setSurfaceUpdateFeedbacks((current) => ({
                ...current,
                [nextSurface.id]: { key: String(streamEvent.event.cursor), atomIds },
              }))
            }
          }
        }
        replaceSpaces(result.spaces, Math.max(surfaceCursorRef.current, streamEvent.event.cursor))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to apply Surface event')
      }
    },
    [refetchAndReplay, replaceSpaces],
  )

  const handleSurfaceCreatedMessage = useCallback(
    (message: Extract<GatewayServerMessage, { type: 'surface.created' }>) => {
      registerLiveCreation(message, clientIdRef.current, streamingTurnsRef.current)
      handleSurfaceStreamEvent({ type: 'surface.created', event: message.event })
    },
    [handleSurfaceStreamEvent, registerLiveCreation],
  )

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BrowserInstallPromptEvent)
      setShowInstallGuide(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  useEffect(() => {
    let closedByApp = false
    let reconnectTimer: number | undefined
    let reconnectDelay = 1000

    const scheduleReconnect = () => {
      setGatewayOnline(false)
      if (closedByApp) return
      reconnectTimer = window.setTimeout(() => startGateway(), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    }

    // The Gateway socket closing mid-turn (issue 037) must not leave a ghost
    // "streaming" entry behind forever, nor silently drop whatever text had
    // already arrived: every in-flight turn is converted to a persisted
    // chat entry via `interruptTurns` (dropped silently if it never
    // accumulated any text) and the streaming map is cleared, before
    // `scheduleReconnect` takes over.
    const onGatewayClose = () => {
      const completed = interruptTurns(streamingTurnsRef.current)
      streamingTurnsRef.current = new Map()
      setStreamingTurns(new Map())
      for (const entry of completed) appendChatEntry(entry)
      scheduleReconnect()
    }

    const startGateway = () => {
      gatewayRef.current = connectGateway({
        token: authToken,
        clientId: clientIdRef.current,
        surfaceCursor: surfaceCursorRef.current,
        onHello(_cursor, clientId) {
          clientIdRef.current = clientId
          reconnectDelay = 1000
          setGatewayOnline(true)
          setError(null)
          // space.attention frames carry no cursor, so an attention update
          // broadcast while this client was disconnected leaves no trace to
          // replay. A hello-triggered refetch is the recovery path: it's
          // safe because refetchAndReplay's revision-wins merge
          // (mergeSpaceAttention) never lets the refetched snapshot clobber
          // a newer attention count already applied locally.
          refetchAndReplay()
          refreshPendingDecisionSnapshot()
        },
        onSurfacePatch(event) {
          handleSurfaceStreamEvent({ type: 'surface.patch', event })
        },
        onSurfaceCreated(message) {
          handleSurfaceCreatedMessage(message)
        },
        onSurfaceArchived(event) {
          handleSurfaceStreamEvent({ type: 'surface.archived', event })
        },
        onSurfacePinned(event) {
          handleSurfaceStreamEvent({ type: 'surface.pinned', event })
        },
        onSurfaceMoved(event) {
          handleSurfaceStreamEvent({ type: 'surface.moved', event })
        },
        onChatMessage(message) {
          appendChatEntry(message.message)
        },
        onChatTurnStart: applyIncomingTurnFrame,
        onChatTurnDelta: applyIncomingTurnFrame,
        onChatTurnReplace: applyIncomingTurnFrame,
        onChatTurnEnd: applyIncomingTurnFrame,
        onChatTurnError: applyIncomingTurnFrame,
        onPendingDecisionLifecycle: handlePendingDecisionLifecycle,
        onApprovalCard(message) {
          setApprovalCards((prev) =>
            prev.some((card) => card.id === message.card.id) ? prev : [...prev, message.card],
          )
        },
        onPresence() {
          // Presence is part of the Gateway protocol; device detail lives in the linked devices Surface.
        },
        onSpaceAttention(message) {
          replaceSpaces(applySpaceAttention(spacesRef.current, message))
        },
        onError: setError,
        onClose: onGatewayClose,
      })
    }

    fetchAuthStatus()
      .then((status) => {
        setAuthMode(status.mode)
        setBootstrapRequired(status.bootstrapRequired)
        setPasskeyRegistered(status.passkeyRegistered)
        if (status.mode === 'production' && !authToken) return undefined
        return fetchSpaces(authToken)
      })
      .then((snapshot) => {
        if (!snapshot) return
        acceptCanonicalSnapshot(snapshot)
        startGateway()
      })
      .catch((e: Error) => {
        setGatewayOnline(false)
        if (e instanceof ApiResponseError && e.status === 401) {
          resetUnauthorizedSession()
          return
        }
        if (spacesRef.current.length === 0) {
          localStorage.removeItem(AUTH_TOKEN_KEY)
          setAuthToken(undefined)
          setHomeSpacesLoadState('error')
        }
        setError(
          spacesRef.current.length > 0 ? `Offline: showing cached Home. ${e.message}` : e.message,
        )
        // A failed /api/auth/status leaves `authMode` undefined forever, so the
        // onboarding-wizard effect below (gated on `authMode !== undefined`)
        // never runs and `onboardingLoad` would otherwise stay stuck at its
        // initial 'loading' value — dead-ending on the "Loading…" screen even
        // when there is cached Home data to show. Fail open to Home here too,
        // the same availability choice already made for a failed onboarding
        // fetch below.
        setOnboardingLoad('error')
      })

    return () => {
      closedByApp = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      cancelPendingDecisionSnapshot()
      gatewayRef.current?.close()
    }
  }, [
    handleSurfaceStreamEvent,
    handleSurfaceCreatedMessage,
    handlePendingDecisionLifecycle,
    appendChatEntry,
    applyIncomingTurnFrame,
    acceptCanonicalSnapshot,
    authToken,
    replaceSpaces,
    refetchAndReplay,
    refreshPendingDecisionSnapshot,
    cancelPendingDecisionSnapshot,
    resetUnauthorizedSession,
    spacesRetryToken,
  ])

  // Onboarding wizard gate (issue 019): fetched once
  // authenticated (or immediately in loopback, where no token is required).
  // `onboardingLoad` starts (and is reset to) 'loading' so the render below
  // shows a neutral wait state instead of flashing Home before this resolves.
  // A failed fetch fails OPEN to Home on Loopback dev, where a broken
  // onboarding endpoint must never brick access to the user's data
  // (deliberate availability choice) -- but fails CLOSED on production
  // (issue #47, ADR-0014 amendment, `homeBlockedByStatusFailure`): a status
  // the PWA cannot read might be hiding a required wizard there, so the
  // render below shows a blocking status-unavailable screen instead of Home.
  // `onboardingRetryToken` gives that screen's Retry button a way to re-run
  // this effect without touching `authMode`/`authToken`.
  useEffect(() => {
    if (authMode === undefined) return
    if (authMode === 'production' && !authToken) return

    const load = async () => {
      setOnboardingLoad('loading')
      try {
        const status = await fetchOnboardingStatus(authToken)
        setOnboardingStatus(status)
        setOnboardingLoad('ready')
      } catch (e) {
        if (e instanceof ApiResponseError && e.status === 401) {
          resetUnauthorizedSession()
          return
        }
        console.warn('failed to fetch onboarding status:', e)
        setOnboardingLoad('error')
      }
    }
    void load()
  }, [authMode, authToken, onboardingRetryToken, resetUnauthorizedSession])

  useEffect(() => {
    if (!gatewayOnline || queuedChat.length === 0) return
    const remaining = queuedChat.filter(
      (entry) => !gatewayRef.current?.sendChat(entry.text, entry.spaceId),
    )
    if (remaining.length !== queuedChat.length) setQueuedChat(remaining)
  }, [gatewayOnline, queuedChat])

  useEffect(() => {
    if (!gatewayOnline || queuedFastActions.length === 0) return
    let cancelled = false

    const flush = async () => {
      const remaining: QueuedFastAction[] = []
      for (const action of queuedFastActions) {
        try {
          const updated = await invokeFastAction(
            action.surfaceId,
            action.nodeId,
            action.actionName,
            action.value,
            authToken,
            action.idempotencyKey,
          )
          if (!cancelled) replaceSurface(updated)
        } catch {
          remaining.push(action)
        }
      }
      if (cancelled) return
      const attempted = new Set(queuedFastActions.map((action) => action.id))
      const failed = new Set(remaining.map((action) => action.id))
      // Filter against current state: actions queued while this flush was
      // awaiting the network must survive it. Returning prev unchanged when
      // every attempt failed keeps this effect from re-running immediately.
      setQueuedFastActions((prev) => {
        const next = prev.filter((action) => !attempted.has(action.id) || failed.has(action.id))
        return next.length === prev.length ? prev : next
      })
    }

    void flush()
    return () => {
      cancelled = true
    }
  }, [authToken, gatewayOnline, queuedFastActions, replaceSurface])

  // A push notification click (public/service-worker.js) posts this message
  // to an already-open client instead of always opening a new tab.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | undefined
      if (data?.type !== 'navigate' || typeof data.url !== 'string') return
      navigate(data.url)
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])

  // Re-registers an already-granted push subscription at boot and on every
  // login/token change: keeps the daemon's push store fresh after
  // e.g. a data-dir reset, and re-associates the subscription with the
  // right user once `authToken` settles instead of only firing once at boot
  // with whatever was in storage at first render.
  useEffect(() => {
    void syncPush(authToken ?? null)
  }, [authToken])

  // Clearing the attention badge is a fast-path mutation (AGENTS.md: every
  // mutation appends to the Event log) — fire it whenever focus lands on a
  // Space that still has attention, whether via a click (focusSpace) or a
  // deep links, Back/Forward, and service-worker navigation (all of which
  // update the router params and therefore focusedSpaceId below).
  const focusedSpace = useMemo(
    () => spaces.find((space) => space.slug === focusedSpaceSlug),
    [focusedSpaceSlug, spaces],
  )
  const focusedSpaceId = focusedSpace?.id
  const focusChatToken = `${locationKey}:${focusedSpaceId ?? ''}:${focusedSurfaceId ?? ''}`

  useEffect(() => {
    if (!focusedSpaceId) return
    const space = spacesRef.current.find((candidate) => candidate.id === focusedSpaceId)
    if (!space || space.attention <= 0) return

    markSpaceAttentionSeen(focusedSpaceId, authToken)
      .then(({ count, revision }) => {
        replaceSpaces(
          applySpaceAttention(spacesRef.current, { spaceId: focusedSpaceId, count, revision }),
        )
      })
      .catch(() => undefined)
  }, [focusedSpaceId, authToken, replaceSpaces])

  const focusSpace = (space: SpaceWithSurfaces, surface?: Surface) => {
    navigate(surface ? clientPath.surface(space.slug, surface.id) : clientPath.space(space.slug))
  }

  const moveSurface = (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => {
    const surface = space.surfaces.find((candidate) => candidate.id === surfaceId)
    requestSurfaceMove(space.id, surfaceId, direction, authToken)
      .then((result) => applyConfirmedSurfaceOrder(result.order))
      .catch((e: Error) => setError(`"${surface?.title ?? surfaceId}" move failed: ${e.message}`))
  }

  const resolveChatPendingDecision = async (
    decisionId: string,
    resolution: PendingDecisionResolution,
  ) => {
    let decision: PendingDecision
    try {
      const result = await resolvePendingDecision(decisionId, resolution, authToken)
      decision = result.decision
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 401) {
        resetUnauthorizedSession()
        return
      }
      setError(error instanceof Error ? error.message : 'Pending decision resolution failed')
      return
    }

    showPendingDecisionFeedback(decision, pendingDecisionFeedback(decision))

    if (decision.kind === 'space-proposal' && decision.outcome === 'accepted') {
      try {
        const snapshot = await fetchSpaces(authToken)
        replaceSpaces(snapshot.spaces, snapshot.surfaceCursor)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Space refresh failed')
      }
    }
  }

  const queuedCount = queuedChat.length + queuedFastActions.length

  const retrySpaces = () => {
    setError(null)
    if (spacesRef.current.length === 0) setHomeSpacesLoadState('loading')
    setSpacesRetryToken((value) => value + 1)
  }

  if (authMode === 'production' && !authToken) {
    return (
      <AuthGate
        bootstrapRequired={bootstrapRequired}
        passkeyRegistered={passkeyRegistered}
        error={error}
        onAuthenticated={(token) => {
          localStorage.setItem(AUTH_TOKEN_KEY, token)
          setAuthToken(token)
          setError(null)
        }}
        onError={setError}
      />
    )
  }

  // While the onboarding status fetch is in flight, hold on a neutral view
  // rather than rendering Home (which would flash before the wizard gate
  // below can decide whether it applies). This branch is reachable only in
  // contexts where the wizard could be required — the effect above only sets
  // 'loading' after auth resolves to loopback, or to production with a token.
  if (onboardingLoad === 'loading') {
    return (
      <main className="wizard-shell">
        <p>Loading…</p>
      </main>
    )
  }

  // Fail-closed gate (issue #47, ADR-0014 amendment): a production install
  // whose onboarding-status fetch failed must not fall through to Home --
  // `onboardingStatus` is still whatever it was before (usually `null`), so
  // without this branch the wizard-required check below would see no
  // required step and render Home on a status the PWA never actually read.
  // The Loopback fail-open above is unaffected: `homeBlockedByStatusFailure`
  // always returns false for `authMode === 'dev'`.
  if (
    homeBlockedByStatusFailure({
      authMode,
      hasToken: Boolean(authToken),
      onboardingLoad,
    })
  ) {
    return (
      <main className="wizard-shell">
        <div className="wizard-card">
          <p role="alert">
            Veduta could not read its setup status, so Home is not being shown. Check the daemon and
            try again.
          </p>
          <button type="button" onClick={() => setOnboardingRetryToken((value) => value + 1)}>
            Retry
          </button>
        </div>
      </main>
    )
  }

  if (onboardingStatus?.required && !onboardingStatus.completed) {
    return (
      <OnboardingWizard
        status={onboardingStatus}
        token={authToken}
        onStatus={setOnboardingStatus}
        onCompleted={() => {
          setOnboardingStatus((prev) =>
            prev ? { ...prev, required: false, completed: true } : prev,
          )
          navigate(clientPath.home, { replace: true })
          fetchSpaces(authToken)
            .then((snapshot) => replaceSpaces(snapshot.spaces, snapshot.surfaceCursor))
            .catch((e: Error) => setError(e.message))
        }}
      />
    )
  }

  const appRouteSelection: AppRouteSelection =
    focusedSpaceSlug === undefined
      ? { kind: 'home' }
      : {
          kind: 'space',
          slug: focusedSpaceSlug,
          space: focusedSpace,
          surfaceId: focusedSurfaceId,
        }

  const appShell = (
    <AppShell
      authMode={authMode}
      authToken={authToken}
      gatewayOnline={gatewayOnline}
      queuedCount={queuedCount}
      installPrompt={installPrompt}
      showInstallGuide={showInstallGuide}
      error={error}
      spaces={spaces}
      homeSpacesLoadState={homeSpacesLoadState}
      route={appRouteSelection}
      surfaceCreationFeedbackKeys={surfaceCreationFeedbackKeys}
      surfaceUpdateFeedbacks={surfaceUpdateFeedbacks}
      approvalCards={approvalCards}
      chatEntries={chatEntries}
      streamingEntries={Array.from(streamingTurns.values(), (turn) => ({
        turnId: turn.turnId,
        text: turn.text,
      }))}
      focusChatToken={focusChatToken}
      onOpenModelConnections={() => navigate(clientPath.modelConnections)}
      onRetrySpaces={retrySpaces}
      onInstallDone={() => {
        localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
        setShowInstallGuide(false)
      }}
      onFocusSpace={focusSpace}
      onMoveSurface={moveSurface}
      onSurfacePatched={replaceSurface}
      onQueueFastAction={queueFastAction}
      onTogglePin={togglePin}
      onSurfaceCreationFeedbackShown={acknowledgeSurfaceCreationFeedback}
      onError={setError}
      onApprovalCardsChange={setApprovalCards}
      onResolvePendingDecision={resolveChatPendingDecision}
      onSend={(message) => {
        const spaceId = focusedSpace?.id
        const sent = gatewayRef.current?.sendChat(message, spaceId) ?? false
        appendChatEntry({ role: 'user', text: message })
        if (!sent) setQueuedChat((prev) => [...prev, queuedChatEntry(message, spaceId)])
        return true
      }}
    />
  )

  return (
    <ClientRouteTable
      appShell={appShell}
      modelConnections={
        <SettingsModelConnections token={authToken} onBack={() => navigate(clientPath.home)} />
      }
    />
  )
}

function findSurface(spaces: SpaceWithSurfaces[], surfaceId: string): Surface | undefined {
  return spaces.flatMap((space) => space.surfaces).find((surface) => surface.id === surfaceId)
}

function surfaceStreamEventErrorMessage(streamEvent: SurfaceStreamEvent): string {
  switch (streamEvent.type) {
    case 'surface.patch':
      return `patch for unknown Surface: ${streamEvent.event.patch.surfaceId}`
    case 'surface.created':
      return `Surface created for unknown Space: ${streamEvent.event.spaceId}`
    case 'surface.archived':
      return `archived unknown Surface: ${streamEvent.event.surfaceId}`
    case 'surface.pinned':
      return `pin update for unknown Surface: ${streamEvent.event.surfaceId}`
    case 'surface.moved':
      return `Move result could not be applied for Surface: ${streamEvent.event.surfaceId}`
  }
}
