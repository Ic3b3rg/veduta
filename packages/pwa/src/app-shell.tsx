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
import { useState, type ReactNode } from 'react'
import { Button } from '@veduta/catalog/ui/button'
import { PortalContainerContext } from '@veduta/catalog/ui/portal-container'
import { Settings } from 'lucide-react'
import type { SpaceWithSurfaces } from './api.ts'
import { ChatPanel } from './chat-panel.tsx'
import { DecisionFeedbackNotice } from './decision-feedback-notice.tsx'
import { clientPath } from './client-router.tsx'
import { HomeSpaceGrid, type HomeSpacesLoadState } from './home-space-grid.tsx'
import type { HomeActivityLastSeen } from './home-state.ts'
import {
  PendingDecisionStrip,
  SpacePendingDecisionNotifications,
} from './pending-decision-notifications.tsx'
import { presentPendingDecisions } from './pending-decision-presentation.ts'
import { latestPendingDecisionFeedback } from './pending-decision-state.ts'
import type { QueuedChat } from './pwa-storage.ts'
import { SpaceSection } from './space-section.tsx'
import { ShellNotice } from './shell-notice.tsx'
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
  deviceControls?: ReactNode
  announcement?: ReactNode
  brandMarkSrc?: string
  gatewayOnline: boolean
  queuedCount: number
  error: string | null
  onDismissError: () => void
  spaces: SpaceWithSurfaces[]
  homeSpacesLoadState: HomeSpacesLoadState
  homeActivityLastSeen?: HomeActivityLastSeen
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
  onOpenSettings: () => void
  onRetrySpaces: () => void
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
  deviceControls,
  announcement,
  brandMarkSrc = '/icons/logo-mark.png',
  gatewayOnline,
  queuedCount,
  error,
  onDismissError,
  spaces,
  homeSpacesLoadState,
  homeActivityLastSeen = {},
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
  onOpenSettings,
  onRetrySpaces,
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
  const pendingDecisionPresentation = presentPendingDecisions(
    pendingDecisions,
    spaces,
    dismissedDecisionIds,
  )
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
            <h1 className="product-wordmark">
              <img className="brand-logo" src={brandMarkSrc} alt="" width={32} height={32} />
              Veduta
            </h1>
            <div className="topbar-actions" aria-live="polite">
              {queuedCount > 0 && <span className="status-pill pending">{queuedCount} queued</span>}
              <Button
                className="recipe-control utility-control"
                aria-label="Settings"
                title="Settings"
                onClick={onOpenSettings}
              >
                <Settings aria-hidden="true" />
              </Button>
              {deviceControls}
            </div>
          </header>
          {announcement}
          {pendingDecisionPresentation.updateNotice && (
            <section
              className="software-update-notice recipe-surface"
              aria-label="Veduta software update"
            >
              <p role="status">
                Veduta {pendingDecisionPresentation.updateNotice.version} is available
              </p>
              <Link
                className="recipe-control recipe-focus"
                to={pendingDecisionPresentation.updateNotice.reviewPath}
              >
                Review update
              </Link>
            </section>
          )}

          <div className="shell-layout">
            <SpaceNavigation
              spaces={spaces}
              selectedSpace={focusedSpace}
              onFocusSpace={onFocusSpace}
            />

            <main className="shell-main" id="main-content" aria-label={mainContentName}>
              {error && (
                <ShellNotice
                  className="error"
                  role="alert"
                  message={error}
                  dismissLabel="Dismiss error"
                  onDismiss={onDismissError}
                />
              )}
              <DecisionFeedbackNotice feedback={pendingDecisionFeedback} />
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
                    homeActivityLastSeen={homeActivityLastSeen}
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
            <ChatPanel
              notifications={
                focusedSpace
                  ? focusedPendingNotifications
                  : pendingDecisionPresentation.globalNotifications
              }
              gatewayOnline={gatewayOnline}
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
