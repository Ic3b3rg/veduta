import type {
  ChatMessage,
  PendingDecision,
  PendingDecisionResolution,
  Surface,
  SurfaceMoveDirection,
} from '@veduta/protocol'
import { Link } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
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
import type { BrowserInstallPromptEvent, QueuedFastAction } from './pwa-storage.ts'
import { SpaceSection } from './space-section.tsx'
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
  chatEntries: ChatMessage[]
  streamingEntries: { turnId: string; text: string }[]
  focusChatToken: string
  focusChatOnRouteChange: boolean
  onOpenModelConnections: () => void
  onRetrySpaces: () => void
  onInstallDone: () => void
  onFocusSpace: (space: SpaceWithSurfaces, surface?: Surface) => void
  onMoveSurface: (
    space: SpaceWithSurfaces,
    surfaceId: string,
    direction: SurfaceMoveDirection,
  ) => void
  onSurfacePatched: (
    surface: Surface,
    affectedAtomIds?: readonly string[],
    surfaceCursor?: number,
  ) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (surface: Surface, pinned: boolean) => void
  onSurfaceRevealFeedbackShown: (surfaceId: string, feedbackKey: string) => void
  onError: (message: string) => void
  onResolvePendingDecision: (
    decisionId: string,
    resolution: PendingDecisionResolution,
  ) => Promise<void> | void
  onDismissPendingDecision: (decisionId: string) => void
  onSend: (message: string) => boolean
}

interface RouteRecovery {
  heading: string
  message: string
}

/** The fixed PWA shell; App owns networking and persistence and supplies route-derived selection. */
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
  chatEntries,
  streamingEntries,
  focusChatToken,
  focusChatOnRouteChange,
  onOpenModelConnections,
  onRetrySpaces,
  onInstallDone,
  onFocusSpace,
  onMoveSurface,
  onSurfacePatched,
  onQueueFastAction,
  onTogglePin,
  onSurfaceRevealFeedbackShown,
  onError,
  onResolvePendingDecision,
  onDismissPendingDecision,
  onSend,
}: AppShellProps) {
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
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to {mainContentName} content
      </a>
      <header className="topbar">
        <h1 className="product-wordmark">Veduta</h1>
        <div className="topbar-actions" aria-live="polite">
          <span className={gatewayOnline ? 'status-pill online' : 'status-pill'}>
            {gatewayOnline ? 'Live' : 'Offline-ready'}
          </span>
          {queuedCount > 0 && <span className="status-pill pending">{queuedCount} queued</span>}
          <ChatModelSelects token={authToken} />
          <button type="button" onClick={onOpenModelConnections}>
            Model connections
          </button>
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
        <aside className="space-rail" aria-label="Spaces">
          {spaces.map((space) => (
            <button
              key={space.id}
              type="button"
              className={space.id === focusedSpace?.id ? 'space-button selected' : 'space-button'}
              aria-pressed={space.id === focusedSpace?.id}
              onClick={() => onFocusSpace(space)}
            >
              <span>{space.name}</span>
              <span className="badge-group">
                <AttentionBadge count={space.attention} />
                <span className="space-badge">{space.surfaces.length}</span>
              </span>
            </button>
          ))}
        </aside>

        <main className="shell-main" id="main-content" aria-label={mainContentName}>
          {focusedSpace && !routeRecovery && (
            <nav className="space-breadcrumb" aria-label="Breadcrumb">
              <Link to={clientPath.home}>
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
            <SpacePendingDecisionNotifications
              notifications={focusedPendingNotifications}
              resolvingDecisionIds={resolvingDecisionIds}
              onResolve={onResolvePendingDecision}
              onDismiss={onDismissPendingDecision}
            />
          )}

          {visibleSpaces.map((space) => (
            <SpaceSection
              key={space.id}
              space={space}
              authToken={authToken}
              focused={space.id === focusedSpace?.id}
              focusedSurfaceId={focusedSurfaceId}
              surfaceRevealFeedbackKeys={surfaceRevealFeedbackKeys}
              surfaceUpdateFeedbacks={surfaceUpdateFeedbacks}
              onFocus={onFocusSpace}
              onMoveSurface={onMoveSurface}
              onPatched={onSurfacePatched}
              onQueueFastAction={onQueueFastAction}
              onTogglePin={onTogglePin}
              onSurfaceRevealFeedbackShown={onSurfaceRevealFeedbackShown}
              onError={onError}
            />
          ))}
        </main>
      </div>

      <ChatBar
        entries={chatEntries}
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
      />
    </div>
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
