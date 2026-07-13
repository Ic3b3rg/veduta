import type { ApprovalCard, ChatMessage, Surface } from '@veduta/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApprovalCards, dismissCardsForSurface } from './approval-cards.tsx'
import {
  connectGateway,
  fetchAuthStatus,
  fetchSpaces,
  invokeFastAction,
  type GatewayConnection,
  type SpaceWithSurfaces,
} from './api.ts'
import { AuthGate } from './auth-gate.tsx'
import { ChatBar } from './chat-bar.tsx'
import {
  applyBufferedSurfaceStreamEvents,
  applySurfaceStreamEvent,
  cachedSnapshot,
  mergeSurfaceOrder,
  moveSurfaceId,
  parseSurfaceDeepLink,
  saveSnapshot,
  surfaceDeepLink,
  type SurfaceStreamEvent,
} from './home-state.ts'
import { InstallButton } from './install-button.tsx'
import {
  AUTH_TOKEN_KEY,
  CHAT_HISTORY_LIMIT,
  HOME_CACHE_KEY,
  INSTALL_DISMISSED_KEY,
  isStandalone,
  persistChatHistory,
  persistQueuedChat,
  persistQueuedFastActions,
  persistSurfaceOrders,
  queuedChatEntry,
  readChatHistory,
  readQueuedChat,
  readQueuedFastActions,
  readSurfaceOrders,
  type BrowserInstallPromptEvent,
  type QueuedFastAction,
} from './pwa-storage.ts'
import { SpaceSection } from './space-section.tsx'
import './app.css'

export function App() {
  const [cachedHome] = useState(() => cachedSnapshot(localStorage, HOME_CACHE_KEY))
  const [spaces, setSpaces] = useState<SpaceWithSurfaces[]>(() => cachedHome?.spaces ?? [])
  const [error, setError] = useState<string | null>(null)
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>(readChatHistory)
  const [approvalCards, setApprovalCards] = useState<ApprovalCard[]>([])
  const [queuedChat, setQueuedChat] = useState(readQueuedChat)
  const [queuedFastActions, setQueuedFastActions] = useState(readQueuedFastActions)
  const [surfaceOrders, setSurfaceOrders] = useState<Record<string, string[]>>(readSurfaceOrders)
  const [authToken, setAuthToken] = useState<string | undefined>(
    () => localStorage.getItem(AUTH_TOKEN_KEY) ?? undefined,
  )
  const [authMode, setAuthMode] = useState<'dev' | 'production' | undefined>(undefined)
  const [bootstrapRequired, setBootstrapRequired] = useState(false)
  const [passkeyRegistered, setPasskeyRegistered] = useState(false)
  const [gatewayOnline, setGatewayOnline] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BrowserInstallPromptEvent | null>(null)
  const [showInstallGuide, setShowInstallGuide] = useState(
    () => !isStandalone() && localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1',
  )
  const [focusedSpaceId, setFocusedSpaceId] = useState<string | undefined>(undefined)
  const [focusedSurfaceId, setFocusedSurfaceId] = useState<string | undefined>(
    () => parseSurfaceDeepLink(location.pathname)?.surfaceId,
  )
  const [focusChatToken, setFocusChatToken] = useState(0)
  const gatewayRef = useRef<GatewayConnection | null>(null)
  const spacesRef = useRef<SpaceWithSurfaces[]>(cachedHome?.spaces ?? [])
  const surfaceCursorRef = useRef(cachedHome?.surfaceCursor ?? 0)

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
    setChatEntries((prev) => [...prev, entry].slice(-CHAT_HISTORY_LIMIT))
  }, [])

  // localStorage writes live in effects so setState updaters stay pure.
  useEffect(() => persistChatHistory(chatEntries), [chatEntries])
  useEffect(() => persistQueuedChat(queuedChat), [queuedChat])
  useEffect(() => persistQueuedFastActions(queuedFastActions), [queuedFastActions])
  useEffect(() => persistSurfaceOrders(surfaceOrders), [surfaceOrders])

  const replaceSurface = useCallback(
    (updated: Surface) => {
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

  const queueFastAction = useCallback((action: QueuedFastAction) => {
    setQueuedFastActions((prev) =>
      prev.some((queued) => queued.id === action.id) ? prev : [...prev, action],
    )
  }, [])

  // Surface lifecycle stream (D9/R2-M2): surface.patch / surface.created /
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

        const replay = applyBufferedSurfaceStreamEvents(
          snapshot.spaces,
          snapshot.surfaceCursor,
          buffered,
        )
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
        const result = applySurfaceStreamEvent(spacesRef.current, streamEvent)
        if (!result.applied) {
          bufferedStreamEventsRef.current.push(streamEvent)
          refetchAndReplay()
          return
        }
        replaceSpaces(result.spaces, streamEvent.event.cursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to apply Surface event')
      }
    },
    [refetchAndReplay, replaceSpaces],
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

    const startGateway = () => {
      gatewayRef.current = connectGateway({
        token: authToken,
        surfaceCursor: surfaceCursorRef.current,
        onHello() {
          reconnectDelay = 1000
          setGatewayOnline(true)
          setError(null)
        },
        onSurfacePatch(event) {
          handleSurfaceStreamEvent({ type: 'surface.patch', event })
        },
        onSurfaceCreated(event) {
          handleSurfaceStreamEvent({ type: 'surface.created', event })
        },
        onSurfaceArchived(event) {
          handleSurfaceStreamEvent({ type: 'surface.archived', event })
        },
        onChatMessage(message) {
          appendChatEntry(message.message)
        },
        onApprovalCard(message) {
          setApprovalCards((prev) =>
            prev.some((card) => card.id === message.card.id) ? prev : [...prev, message.card],
          )
        },
        onPresence() {
          // Presence is part of the Gateway protocol; device detail lives in the linked devices Surface.
        },
        onError: setError,
        onClose: scheduleReconnect,
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
        replaceSpaces(snapshot.spaces, snapshot.surfaceCursor)
        startGateway()
      })
      .catch((e: Error) => {
        setGatewayOnline(false)
        if (spacesRef.current.length === 0) {
          localStorage.removeItem(AUTH_TOKEN_KEY)
          setAuthToken(undefined)
        }
        setError(
          spacesRef.current.length > 0 ? `Offline: showing cached Home. ${e.message}` : e.message,
        )
      })

    return () => {
      closedByApp = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      gatewayRef.current?.close()
    }
  }, [handleSurfaceStreamEvent, appendChatEntry, authToken, replaceSpaces])

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

  const spacesLoaded = spaces.length > 0
  useEffect(() => {
    const applyLocation = () => {
      const link = parseSurfaceDeepLink(location.pathname)
      const space = link
        ? spacesRef.current.find((candidate) => candidate.slug === link.spaceSlug)
        : undefined
      if (!link || !space) {
        // Back to a non-Surface URL (e.g. "/") returns chat to global scope.
        setFocusedSpaceId(undefined)
        setFocusedSurfaceId(undefined)
        return
      }
      setFocusedSpaceId(space.id)
      setFocusedSurfaceId(link.surfaceId)
      setFocusChatToken((value) => value + 1)
    }

    window.addEventListener('popstate', applyLocation)
    if (spacesLoaded) applyLocation()
    return () => window.removeEventListener('popstate', applyLocation)
  }, [spacesLoaded])

  // Undefined until the user (or a deep link) picks a Space: chat stays
  // global instead of silently pre-routing to the first Space.
  const focusedSpace = useMemo(
    () => spaces.find((space) => space.id === focusedSpaceId),
    [focusedSpaceId, spaces],
  )

  const focusSpace = (space: SpaceWithSurfaces, surface?: Surface) => {
    setFocusedSpaceId(space.id)
    if (surface) {
      setFocusedSurfaceId(surface.id)
      history.pushState(null, '', surfaceDeepLink(space.slug, surface.id))
    }
    setFocusChatToken((value) => value + 1)
  }

  const moveSurface = (space: SpaceWithSurfaces, surfaceId: string, offset: -1 | 1) => {
    const ids = mergeSurfaceOrder(
      space.surfaces.map((surface) => surface.id),
      surfaceOrders[space.id] ?? [],
    )
    const nextOrder = moveSurfaceId(ids, surfaceId, offset)
    setSurfaceOrders({ ...surfaceOrders, [space.id]: nextOrder })
  }

  const queuedCount = queuedChat.length + queuedFastActions.length

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Veduta</h1>
          <p>{authMode === 'production' ? 'Passkey session' : 'Local VPS profile'}</p>
        </div>
        <div className="topbar-actions" aria-live="polite">
          <span className={gatewayOnline ? 'status-pill online' : 'status-pill'}>
            {gatewayOnline ? 'Live' : 'Offline-ready'}
          </span>
          {queuedCount > 0 && <span className="status-pill pending">{queuedCount} queued</span>}
          {showInstallGuide && (
            <InstallButton
              prompt={installPrompt}
              onDone={() => {
                localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
                setShowInstallGuide(false)
              }}
            />
          )}
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="home-layout">
        <aside className="space-rail" aria-label="Spaces">
          {spaces.map((space) => (
            <button
              key={space.id}
              type="button"
              className={space.id === focusedSpace?.id ? 'space-button selected' : 'space-button'}
              onClick={() => focusSpace(space)}
            >
              <span>{space.name}</span>
              <span className="space-badge">{space.surfaces.length}</span>
            </button>
          ))}
        </aside>

        <main className="home" aria-label="Home">
          {approvalCards.length > 0 && (
            <ApprovalCards cards={approvalCards} onDismiss={setApprovalCards} />
          )}

          {spaces.map((space) => (
            <SpaceSection
              key={space.id}
              space={space}
              authToken={authToken}
              focused={space.id === focusedSpace?.id}
              focusedSurfaceId={focusedSurfaceId}
              surfaceOrder={surfaceOrders[space.id] ?? []}
              onFocus={focusSpace}
              onMoveSurface={moveSurface}
              onPatched={replaceSurface}
              onQueueFastAction={queueFastAction}
              onError={setError}
            />
          ))}
        </main>
      </div>

      <ChatBar
        entries={chatEntries}
        approvalCards={approvalCards}
        focusedSpace={focusedSpace}
        focusToken={focusChatToken}
        onDismissApprovalCards={setApprovalCards}
        onSend={(message) => {
          const spaceId = focusedSpace?.id
          const sent = gatewayRef.current?.sendChat(message, spaceId) ?? false
          appendChatEntry({ role: 'user', text: message })
          if (!sent) {
            setQueuedChat((prev) => [...prev, queuedChatEntry(message, spaceId)])
          }
          return true
        }}
      />
    </div>
  )
}

function surfaceStreamEventErrorMessage(streamEvent: SurfaceStreamEvent): string {
  switch (streamEvent.type) {
    case 'surface.patch':
      return `patch for unknown Surface: ${streamEvent.event.patch.surfaceId}`
    case 'surface.created':
      return `Surface created for unknown Space: ${streamEvent.event.spaceId}`
    case 'surface.archived':
      return `archived unknown Surface: ${streamEvent.event.surfaceId}`
  }
}
