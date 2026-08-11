import type { ApprovalCard, ChatMessage, Surface } from '@veduta/protocol'
import { ApprovalCards } from './approval-cards.tsx'
import type { SpaceWithSurfaces } from './api.ts'
import { AttentionBadge } from './attention-badge.tsx'
import { ChatBar } from './chat-bar.tsx'
import { ChatModelSelects } from './chat-model-selects.tsx'
import { InstallButton } from './install-button.tsx'
import { NotificationBell } from './notification-bell.tsx'
import type { BrowserInstallPromptEvent, QueuedFastAction } from './pwa-storage.ts'
import { SpaceSection } from './space-section.tsx'

interface HomeScreenProps {
  authMode: 'dev' | 'production' | undefined
  authToken: string | undefined
  gatewayOnline: boolean
  queuedCount: number
  installPrompt: BrowserInstallPromptEvent | null
  showInstallGuide: boolean
  error: string | null
  spaces: SpaceWithSurfaces[]
  focusedSpace: SpaceWithSurfaces | undefined
  focusedSurfaceId: string | undefined
  surfaceOrders: Record<string, string[]>
  approvalCards: ApprovalCard[]
  chatEntries: ChatMessage[]
  streamingEntries: { turnId: string; text: string }[]
  focusChatToken: number
  onOpenModelConnections: () => void
  onInstallDone: () => void
  onFocusSpace: (space: SpaceWithSurfaces, surface?: Surface) => void
  onMoveSurface: (space: SpaceWithSurfaces, surfaceId: string, offset: -1 | 1) => void
  onSurfacePatched: (surface: Surface) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (surface: Surface, pinned: boolean) => void
  onError: (message: string) => void
  onApprovalCardsChange: (cards: ApprovalCard[]) => void
  onSend: (message: string) => boolean
}

/** The presentational Home shell; App owns networking, persistence, and routing. */
export function HomeScreen({
  authMode,
  authToken,
  gatewayOnline,
  queuedCount,
  installPrompt,
  showInstallGuide,
  error,
  spaces,
  focusedSpace,
  focusedSurfaceId,
  surfaceOrders,
  approvalCards,
  chatEntries,
  streamingEntries,
  focusChatToken,
  onOpenModelConnections,
  onInstallDone,
  onFocusSpace,
  onMoveSurface,
  onSurfacePatched,
  onQueueFastAction,
  onTogglePin,
  onError,
  onApprovalCardsChange,
  onSend,
}: HomeScreenProps) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Veduta</h1>
          <p>{authMode === 'production' ? 'Passkey session' : 'Loopback profile'}</p>
        </div>
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

      <div className="home-layout">
        <aside className="space-rail" aria-label="Spaces">
          {spaces.map((space) => (
            <button
              key={space.id}
              type="button"
              className={space.id === focusedSpace?.id ? 'space-button selected' : 'space-button'}
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

        <main className="home" aria-label="Home">
          {approvalCards.length > 0 && (
            <ApprovalCards cards={approvalCards} onDismiss={onApprovalCardsChange} />
          )}

          {spaces.map((space) => (
            <SpaceSection
              key={space.id}
              space={space}
              authToken={authToken}
              focused={space.id === focusedSpace?.id}
              focusedSurfaceId={focusedSurfaceId}
              surfaceOrder={surfaceOrders[space.id] ?? []}
              onFocus={onFocusSpace}
              onMoveSurface={onMoveSurface}
              onPatched={onSurfacePatched}
              onQueueFastAction={onQueueFastAction}
              onTogglePin={onTogglePin}
              onError={onError}
            />
          ))}
        </main>
      </div>

      <ChatBar
        entries={chatEntries}
        streamingEntries={streamingEntries}
        approvalCards={approvalCards}
        focusedSpace={focusedSpace}
        focusToken={focusChatToken}
        onDismissApprovalCards={onApprovalCardsChange}
        onSend={onSend}
      />
    </div>
  )
}
