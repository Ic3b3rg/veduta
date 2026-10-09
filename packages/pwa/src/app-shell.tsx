import type {
  AutomationOutcomeNotification,
  ChatMessage,
  ChatTimelineEntry,
  PendingDecision,
  PendingDecisionResolution,
  RenderableSurface,
  SurfaceMoveDirection,
} from '@veduta/protocol'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { Button } from '@veduta/catalog/ui/button'
import { PortalContainerContext } from '@veduta/catalog/ui/portal-container'
import { Settings2, SlidersHorizontal } from 'lucide-react'
import type { SpaceWithSurfaces } from './api.ts'
import { ChatBar } from './chat-bar.tsx'
import { ChatModelSelects } from './chat-model-selects.tsx'
import { clientPath } from './client-router.tsx'
import { HomeSpaceGrid, type HomeSpacesLoadState } from './home-space-grid.tsx'
import { InstallButton } from './install-button.tsx'
import { NotificationBell } from './notification-bell.tsx'
import {
  PendingDecisionStrip,
  SpacePendingDecisionNotifications,
} from './pending-decision-notifications.tsx'
import { presentPendingDecisions } from './pending-decision-presentation.ts'
import { latestPendingDecisionFeedback } from './pending-decision-state.ts'
import type { BrowserInstallPromptEvent, QueuedChat } from './pwa-storage.ts'
import { SpaceSection } from './space-section.tsx'
import { SpaceNavigation } from './space-navigation.tsx'
import { PresentationContext, usePresentation } from './presentation-context.ts'
import { SpaceAutomationOutcomeNotifications } from './space-automation-outcome-notifications.tsx'
import type { SurfaceUpdateFeedback } from './surface-motion.ts'

export type AppRouteSelection =
  | { kind: 'home' }
  | {
      kind: 'space'
      slug: string
      space: SpaceWithSurfaces | undefined
      surfaceId: string | undefined
    }

interface AppShellProps {
  authToken: string | undefined
  gatewayOnline: boolean
  queuedCount: number
  installPrompt: BrowserInstallPromptEvent | null
  showInstallGuide: boolean
  error: string | null
  spaces: SpaceWithSurfaces[]
  homeSpacesLoadState: HomeSpacesLoadState
  route: AppRouteSelection
  surfaceRevealFeedbackKeys: Record<string, string>
  surfaceUpdateFeedbacks: Record<string, SurfaceUpdateFeedback>
  pendingDecisions: PendingDecision[]
  dismissedDecisionIds: ReadonlySet<string>
  resolvingDecisionIds: ReadonlySet<string>
  automationOutcomeNotifications: AutomationOutcomeNotification[]
  pendingAutomationOutcomeNotificationIds: ReadonlySet<string>
  chatEntries: ChatMessage[]
  chatTimelineEntries: ChatTimelineEntry[]
  chatHasOlder: boolean
  chatLoadingOlder: boolean
  queuedChat: QueuedChat[]
  streamingEntries: { turnId: string; text: string }[]
  focusChatToken: string
  focusChatOnRouteChange: boolean
  onOpenModelConnections: () => void
  onOpenServiceConnections: () => void
  onRetrySpaces: () => void
  onInstallDone: () => void
  onFocusSpace: (space: SpaceWithSurfaces, surface?: RenderableSurface) => void
  onMoveSurface: (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => void
  onTogglePin: (surface: RenderableSurface, pinned: boolean) => void
  onSurfaceRevealFeedbackShown: (surfaceId: string, feedbackKey: string) => void
  onResolvePendingDecision: (
    decisionId: string,
    resolution: PendingDecisionResolution,
  ) => Promise<void> | void
  onDismissPendingDecision: (decisionId: string) => void
  onOpenAutomationOutcomeNotification: (
    notification: AutomationOutcomeNotification,
  ) => Promise<void> | void
  onDismissAutomationOutcomeNotification: (
    notification: AutomationOutcomeNotification,
  ) => Promise<void> | void
  onSend: (message: string) => boolean
  onLoadOlderChat: () => void
  onRetryInterruptedChat: (turnId: string) => void
  onRetryQueuedChat: (id: string) => void
}

interface RouteRecovery {
  heading: string
  message: string
}

/** The fixed PWA shell; React supplies presentation and route-derived selection from the live runtime. */
export function AppShell({
  authToken,
  gatewayOnline,
  queuedCount,
  installPrompt,
  showInstallGuide,
  error,
  spaces,
  homeSpacesLoadState,
  route,
  surfaceRevealFeedbackKeys,
  surfaceUpdateFeedbacks,
  pendingDecisions,
  dismissedDecisionIds,
  resolvingDecisionIds,
  automationOutcomeNotifications,
  pendingAutomationOutcomeNotificationIds,
  chatEntries,
  chatTimelineEntries,
  chatHasOlder,
  chatLoadingOlder,
  queuedChat,
  streamingEntries,
  focusChatToken,
  focusChatOnRouteChange,
  onOpenModelConnections,
  onOpenServiceConnections,
  onRetrySpaces,
  onInstallDone,
  onFocusSpace,
  onMoveSurface,
  onTogglePin,
  onSurfaceRevealFeedbackShown,
  onResolvePendingDecision,
  onDismissPendingDecision,
  onOpenAutomationOutcomeNotification,
  onDismissAutomationOutcomeNotification,
  onSend,
  onLoadOlderChat,
  onRetryInterruptedChat,
  onRetryQueuedChat,
}: AppShellProps) {
  const presentation = usePresentation()
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const focusedSpace = route.kind === 'space' ? route.space : undefined
  const focusedSurfaceId = route.kind === 'space' ? route.surfaceId : undefined
  const routeRecovery = resolveRouteRecovery(route)
  const visibleSpaces = routeRecovery || focusedSpace === undefined ? [] : [focusedSpace]
  const mainContentName = routeRecovery
    ? 'Route recovery'
    : focusedSpace
      ? `${focusedSpace.name} Space`
      : 'Home'
  const pendingDecisionFeedback = latestPendingDecisionFeedback(chatEntries)
  const pendingDecisionPresentation = presentPendingDecisions(pendingDecisions, spaces)
  const focusedPendingNotifications =
    (focusedSpace && pendingDecisionPresentation.notificationsBySpaceId.get(focusedSpace.id)) ?? []

  return (
    <PresentationContext.Provider value={{ ...presentation, theme: 'dark' }}>
      <PortalContainerContext.Provider value={portalContainer}>
        <div
          ref={setPortalContainer}
          className="app-shell precision-tool"
          data-gateway-online={gatewayOnline}
        >
          <a className="skip-link" href="#main-content">
            Skip to {mainContentName} content
          </a>
          <header className="topbar">
            <h1 className="product-wordmark">Veduta</h1>
            <ChatModelSelects token={authToken} />
            <div className="topbar-actions" aria-live="polite">
              {queuedCount > 0 && <span className="status-pill pending">{queuedCount} queued</span>}
              <Button
                className="recipe-control utility-control"
                aria-label="Model connections"
                title="Model connections"
                onClick={onOpenModelConnections}
              >
                <SlidersHorizontal aria-hidden="true" />
              </Button>
              <Button
                className="recipe-control utility-control"
                aria-label="Connections"
                title="Connections"
                onClick={onOpenServiceConnections}
              >
                <Settings2 aria-hidden="true" />
              </Button>
              <NotificationBell token={authToken} />
              {showInstallGuide && <InstallButton prompt={installPrompt} onDone={onInstallDone} />}
            </div>
          </header>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          {pendingDecisionFeedback && (
            <p
              className={`pending-decision-feedback ${pendingDecisionFeedback.state}`}
              role="status"
              data-decision-feedback-id={pendingDecisionFeedback.id}
            >
              {pendingDecisionFeedback.text}
            </p>
          )}

          <div className="shell-layout">
            <SpaceNavigation
              spaces={spaces}
              selectedSpace={focusedSpace}
              onFocusSpace={onFocusSpace}
            />

            <main className="shell-main" id="main-content" aria-label={mainContentName}>
              {focusedSpace && !routeRecovery && (
                <nav className="space-breadcrumb" aria-label="Breadcrumb">
                  <Link to={clientPath.home} aria-label="Home">
                    <span aria-hidden="true">← </span>
                    Home
                  </Link>
                  <span aria-current="page">{focusedSpace.name}</span>
                </nav>
              )}

              {routeRecovery ? (
                <section className="route-recovery" aria-labelledby="route-recovery-title">
                  <h2 id="route-recovery-title">{routeRecovery.heading}</h2>
                  <p>{routeRecovery.message}</p>
                  <Link to={clientPath.home}>Back to Home</Link>
                </section>
              ) : null}

              {route.kind === 'home' && !routeRecovery && (
                <>
                  <PendingDecisionStrip
                    notifications={pendingDecisionPresentation.globalNotifications}
                    resolvingDecisionIds={resolvingDecisionIds}
                    onResolve={onResolvePendingDecision}
                    onDismiss={onDismissPendingDecision}
                  />
                  <HomeSpaceGrid
                    spaces={spaces}
                    loadState={homeSpacesLoadState}
                    pendingDecisionCounts={pendingDecisionPresentation.countsBySpaceId}
                    onRetry={onRetrySpaces}
                  />
                </>
              )}

              {focusedSpace && !routeRecovery && (
                <>
                  <SpaceAutomationOutcomeNotifications
                    notifications={automationOutcomeNotifications}
                    pendingIds={pendingAutomationOutcomeNotificationIds}
                    onOpen={onOpenAutomationOutcomeNotification}
                    onDismiss={onDismissAutomationOutcomeNotification}
                  />
                  <SpacePendingDecisionNotifications
                    notifications={focusedPendingNotifications}
                    resolvingDecisionIds={resolvingDecisionIds}
                    onResolve={onResolvePendingDecision}
                    onDismiss={onDismissPendingDecision}
                  />
                </>
              )}

              {visibleSpaces.map((space) => (
                <SpaceSection
                  key={space.id}
                  space={space}
                  focused={space.id === focusedSpace?.id}
                  focusedSurfaceId={focusedSurfaceId}
                  surfaceRevealFeedbackKeys={surfaceRevealFeedbackKeys}
                  surfaceUpdateFeedbacks={surfaceUpdateFeedbacks}
                  onFocus={onFocusSpace}
                  onMoveSurface={onMoveSurface}
                  onTogglePin={onTogglePin}
                  onSurfaceRevealFeedbackShown={onSurfaceRevealFeedbackShown}
                />
              ))}
            </main>
          </div>

          <ChatBar
            entries={chatEntries}
            timelineEntries={chatTimelineEntries}
            hasOlder={chatHasOlder}
            loadingOlder={chatLoadingOlder}
            queuedChat={queuedChat}
            streamingEntries={streamingEntries}
            focusedSpace={focusedSpace}
            focusToken={focusChatToken}
            focusOnRouteChange={focusChatOnRouteChange}
            pendingDecisionReviewPaths={pendingDecisionPresentation.reviewPaths}
            dismissedDecisionIds={dismissedDecisionIds}
            resolvingDecisionIds={resolvingDecisionIds}
            onResolvePendingDecision={onResolvePendingDecision}
            onDismissPendingDecision={onDismissPendingDecision}
            onSend={onSend}
            onLoadOlder={onLoadOlderChat}
            onRetryInterrupted={onRetryInterruptedChat}
            onRetryQueued={onRetryQueuedChat}
          />
        </div>
      </PortalContainerContext.Provider>
    </PresentationContext.Provider>
  )
}

function resolveRouteRecovery(route: AppRouteSelection): RouteRecovery | undefined {
  if (route.kind === 'home') return undefined
  if (route.space === undefined) {
    return {
      heading: 'Space not found',
      message: `No active Space matches “${route.slug}”.`,
    }
  }
  if (
    route.surfaceId !== undefined &&
    !route.space.surfaces.some((surface) => surface.id === route.surfaceId)
  ) {
    return {
      heading: 'Surface not found',
      message: `No Surface “${route.surfaceId}” belongs to ${route.space.name}.`,
    }
  }
  return undefined
}
