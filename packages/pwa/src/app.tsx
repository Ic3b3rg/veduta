import {
  type OnboardingStatus,
  type RenderableSurface,
  type SurfaceMoveDirection,
} from '@veduta/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { ApiResponseError, fetchOnboardingStatus, type SpaceWithSurfaces } from './api.ts'
import { AuthGate } from './auth-gate.tsx'
import { OnboardingWizard } from './onboarding-wizard.tsx'
import { ConnectionsRoute } from './connections-route.tsx'
import { ClientRouteTable, clientPath, useClientRouting } from './client-router.tsx'
import { AppShell, type AppRouteSelection } from './app-shell.tsx'
import { homeBlockedByStatusFailure } from './onboarding-state.ts'
import {
  INSTALL_DISMISSED_KEY,
  isStandalone,
  type BrowserInstallPromptEvent,
} from './pwa-storage.ts'
import { syncPush } from './push.ts'
import { useSurfaceCreationFeedback } from './surface-creation-feedback.ts'
import { usePendingDecisionPresentation } from './use-pending-decision-presentation.ts'
import { PwaRuntimeContext, useLiveState } from './use-live-state.ts'
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
    focusChatOnRouteChange,
    spaceSlug: focusedSpaceSlug,
    surfaceId: focusedSurfaceId,
  } = useClientRouting()
  const { runtime, snapshot } = useLiveState()
  const {
    spaces,
    homeSpacesLoadState,
    error,
    authToken,
    chatEntries,
    streamingTurns,
    gatewayOnline,
    surfaceUpdateFeedbacks,
    automationOutcomeNotifications,
  } = snapshot
  const authMode = snapshot.authStatus?.mode
  const bootstrapRequired = snapshot.authStatus?.bootstrapRequired ?? false
  const passkeyRegistered = snapshot.authStatus?.passkeyRegistered ?? false
  const resolvingDecisionIds = useMemo(
    () => new Set(snapshot.resolvingDecisionIds),
    [snapshot.resolvingDecisionIds],
  )
  const pendingAutomationOutcomeNotificationIds = useMemo(
    () => new Set(snapshot.pendingAutomationOutcomeNotificationIds),
    [snapshot.pendingAutomationOutcomeNotificationIds],
  )
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [onboardingLoad, setOnboardingLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [onboardingRetryToken, setOnboardingRetryToken] = useState(0)
  const waitingForAccess = useRef(false)
  const hasOnboardingStatus = useRef(false)
  const [installPrompt, setInstallPrompt] = useState<BrowserInstallPromptEvent | null>(null)
  const [showInstallGuide, setShowInstallGuide] = useState(
    () => !isStandalone() && localStorage.getItem(INSTALL_DISMISSED_KEY) !== '1',
  )
  const setError = runtime.reportError
  const resetUnauthorizedSession = useCallback(() => {
    runtime.authenticate(undefined)
    waitingForAccess.current = false
    hasOnboardingStatus.current = false
    setOnboardingStatus(null)
    setOnboardingLoad('loading')
  }, [runtime])
  const focusedSpace = useMemo(
    () => spaces.find((space) => space.slug === focusedSpaceSlug),
    [spaces, focusedSpaceSlug],
  )
  const focusedSpaceId = focusedSpace?.id
  const focusChatToken = `${locationKey}:${focusedSpaceId ?? ''}:${focusedSurfaceId ?? ''}`
  const shownSurfaceRevealKeysRef = useRef(new Set<string>())
  const wasSurfaceRevealShown = useCallback(
    (key: string) => shownSurfaceRevealKeysRef.current.has(key),
    [],
  )
  const {
    feedbackKeys: surfaceCreationFeedbackKeys,
    registerLiveCreation,
    acknowledge: acknowledgeSurfaceCreationFeedback,
  } = useSurfaceCreationFeedback(wasSurfaceRevealShown)
  const revealPendingDecisionSurface = useCallback(
    (slug: string, id: string) =>
      navigate(clientPath.surface(slug, id), { state: { preserveKeyboardFocus: true } }),
    [navigate],
  )
  const {
    revealKeys: pendingDecisionRevealKeys,
    registerLiveTurn,
    acknowledge: acknowledgePendingDecisionReveal,
    dismissedDecisionIds,
    dismiss: dismissPendingDecision,
    cancelAll: cancelPendingDecisionReveals,
  } = usePendingDecisionPresentation({
    decisions: snapshot.pendingDecisions,
    spaces,
    focusedSpaceId,
    onRevealSurface: revealPendingDecisionSurface,
    wasRevealShown: wasSurfaceRevealShown,
  })
  const pendingDecisions = snapshot.pendingDecisions.filter(
    (decision) => !dismissedDecisionIds.has(decision.id),
  )
  const surfaceRevealFeedbackKeys = useMemo(
    () => ({ ...surfaceCreationFeedbackKeys, ...pendingDecisionRevealKeys }),
    [surfaceCreationFeedbackKeys, pendingDecisionRevealKeys],
  )
  const presentedSequence = useRef(0)
  useEffect(() => {
    for (const event of snapshot.presentationEvents) {
      if (event.sequence <= presentedSequence.current) continue
      presentedSequence.current = event.sequence
      const pendingTurns = new Set(event.pendingTurnIds)
      if (event.frame.type === 'surface.created')
        registerLiveCreation(event.frame, event.clientId, pendingTurns)
      else registerLiveTurn(event.frame, event.clientId, pendingTurns)
    }
  }, [snapshot.presentationEvents, registerLiveCreation, registerLiveTurn])
  useEffect(() => {
    if (!gatewayOnline) cancelPendingDecisionReveals()
  }, [gatewayOnline, cancelPendingDecisionReveals])
  useEffect(() => {
    runtime.focus(focusedSpaceId, focusChatToken)
  }, [runtime, focusedSpaceId, focusChatToken, gatewayOnline])
  const openAutomationOutcomeNotification = async (
    notification: (typeof automationOutcomeNotifications)[number],
  ) => {
    const href = await runtime.actOnNotification(notification, 'open')
    if (href) navigate(href, { state: { preserveKeyboardFocus: true } })
  }
  const dismissAutomationOutcomeNotification = (
    notification: (typeof automationOutcomeNotifications)[number],
  ) => runtime.actOnNotification(notification, 'dismiss').then(() => undefined)
  const focusSpace = (space: SpaceWithSurfaces, surface?: RenderableSurface) =>
    navigate(surface ? clientPath.surface(space.slug, surface.id) : clientPath.space(space.slug))
  const moveSurface = (space: SpaceWithSurfaces, id: string, direction: SurfaceMoveDirection) => {
    void runtime.moveSurface(space.id, id, direction)
  }
  const queuedCount = snapshot.queuedChat.length + snapshot.queuedFastActions.length
  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BrowserInstallPromptEvent)
      setShowInstallGuide(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

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
    if (!gatewayOnline && hasOnboardingStatus.current && !waitingForAccess.current) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const status = await fetchOnboardingStatus(authToken)
        if (cancelled) return
        waitingForAccess.current = status.domain?.pending === true
        hasOnboardingStatus.current = true
        setOnboardingStatus(status)
        setOnboardingLoad('ready')
        if (waitingForAccess.current) timer = setTimeout(() => void load(), 1000)
      } catch (e) {
        if (cancelled) return
        if (e instanceof ApiResponseError && e.status === 401) {
          resetUnauthorizedSession()
          return
        }
        if (waitingForAccess.current) {
          timer = setTimeout(() => void load(), 1000)
          return
        }
        hasOnboardingStatus.current = false
        console.warn('failed to fetch onboarding status:', e)
        setOnboardingLoad('error')
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [authMode, authToken, onboardingRetryToken, resetUnauthorizedSession, gatewayOnline])

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

  if (authMode === 'production' && !authToken) {
    return (
      <AuthGate
        bootstrapRequired={bootstrapRequired}
        passkeyRegistered={passkeyRegistered}
        error={error}
        onAuthenticated={(token) => {
          runtime.authenticate(token)
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
  if (onboardingStatus?.domain?.pending) {
    return (
      <main className="wizard-shell">
        <p role="status">Saving your new access…</p>
        <p>Veduta will reconnect automatically.</p>
      </main>
    )
  }

  if (onboardingLoad === 'loading' && !(authMode === undefined && error !== null && !authToken)) {
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
          <button
            type="button"
            onClick={() => {
              setOnboardingLoad('loading')
              setOnboardingRetryToken((value) => value + 1)
            }}
          >
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
          void runtime.refreshSpaces()
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
      authToken={authToken}
      gatewayOnline={gatewayOnline}
      queuedCount={queuedCount}
      installPrompt={installPrompt}
      showInstallGuide={showInstallGuide}
      error={error}
      spaces={spaces}
      homeSpacesLoadState={homeSpacesLoadState}
      route={appRouteSelection}
      surfaceRevealFeedbackKeys={surfaceRevealFeedbackKeys}
      surfaceUpdateFeedbacks={surfaceUpdateFeedbacks}
      pendingDecisions={pendingDecisions}
      dismissedDecisionIds={dismissedDecisionIds}
      resolvingDecisionIds={resolvingDecisionIds}
      automationOutcomeNotifications={automationOutcomeNotifications}
      pendingAutomationOutcomeNotificationIds={pendingAutomationOutcomeNotificationIds}
      chatEntries={chatEntries}
      chatTimelineEntries={snapshot.chatTimelineEntries}
      chatHasOlder={snapshot.chatHasOlder}
      chatLoadingOlder={snapshot.chatLoadingOlder}
      queuedChat={snapshot.queuedChat.filter((entry) => entry.spaceId === focusedSpaceId)}
      streamingEntries={streamingTurns.map((turn) => ({
        turnId: turn.turnId,
        text: turn.text,
      }))}
      focusChatToken={focusChatToken}
      focusChatOnRouteChange={focusChatOnRouteChange}
      onOpenModelConnections={() => navigate(clientPath.modelConnections)}
      onOpenServiceConnections={() => navigate(clientPath.serviceConnections)}
      onRetrySpaces={runtime.retry}
      onInstallDone={() => {
        localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
        setShowInstallGuide(false)
      }}
      onFocusSpace={focusSpace}
      onMoveSurface={moveSurface}
      onTogglePin={(surface) => void runtime.togglePin(surface)}
      onSurfaceRevealFeedbackShown={(surfaceId, feedbackKey) => {
        shownSurfaceRevealKeysRef.current.add(feedbackKey)
        const creationFeedbackKey = surfaceCreationFeedbackKeys[surfaceId]
        if (creationFeedbackKey !== undefined) {
          acknowledgeSurfaceCreationFeedback(surfaceId, creationFeedbackKey)
        }
        const pendingDecisionRevealKey = pendingDecisionRevealKeys[surfaceId]
        if (pendingDecisionRevealKey !== undefined) {
          acknowledgePendingDecisionReveal(surfaceId, pendingDecisionRevealKey)
        }
      }}
      onResolvePendingDecision={runtime.resolveDecision}
      onDismissPendingDecision={dismissPendingDecision}
      onOpenAutomationOutcomeNotification={openAutomationOutcomeNotification}
      onDismissAutomationOutcomeNotification={dismissAutomationOutcomeNotification}
      onSend={(message) => runtime.sendChat(message, focusedSpaceId)}
      onLoadOlderChat={() => void runtime.loadOlderChat()}
      onRetryInterruptedChat={(turnId) => void runtime.retryInterrupted(turnId)}
      onRetryQueuedChat={runtime.retryQueuedChat}
    />
  )

  return (
    <PwaRuntimeContext.Provider value={runtime}>
      <ClientRouteTable
        appShell={appShell}
        modelConnections={
          <ConnectionsRoute token={authToken} spaces={spaces} initialSection="models" />
        }
        gmailConnections={<ConnectionsRoute token={authToken} spaces={spaces} />}
        himalayaConnections={<ConnectionsRoute token={authToken} spaces={spaces} />}
        serviceConnections={<ConnectionsRoute token={authToken} spaces={spaces} />}
      />
    </PwaRuntimeContext.Provider>
  )
}
