import { renderNode } from '@veduta/catalog'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import { PortalContainerContext } from '@veduta/catalog/ui/portal-container'
import { SurfaceSchema, type ChatMessage } from '@veduta/protocol'
import { useState, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ChatBar } from './chat-bar.tsx'
import { HomeSpaceGrid } from './home-space-grid.tsx'
import { ModelConnectionPanel } from './model-connection-panel.tsx'
import { SpacePendingDecisionNotifications } from './pending-decision-notifications.tsx'
import { PresentationContext } from './presentation-context.ts'
import {
  referenceAt,
  referenceCatalog,
  referenceDecision,
  referenceModels,
  referenceNow,
  referenceOnboarding,
  referenceSpace,
  referenceSpaces,
  referenceStates,
  referenceSurface,
  referenceUpdatedSurface,
  referenceTurn,
  type ReferenceState,
} from './product-reference-fixtures.ts'
import { ReferenceRecipes } from './product-reference-recipes.tsx'
import { SpaceSection } from './space-section.tsx'
import { SurfaceCard } from './surface-card.tsx'
import { WizardStepFirstSpace } from './wizard-step-first-space.tsx'
import './styles/product-reference.css'

const presentation = { theme: 'dark' as const, now: referenceNow }
const ignore = () => {}

/** Offline contributor inventory using production components, never an alternate application runtime. */
export function ProductReferencePage() {
  const [state, setState] = useState<ReferenceState>('long')
  const [notice, setNotice] = useState('')
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const previewAction = () => setNotice('Reference interaction only; reload restores the sample.')
  const surface =
    state === 'stale'
      ? SurfaceSchema.parse({
          ...referenceSurface,
          state: { records: [], current: [] },
          validity: {
            kind: 'relative-time',
            window: 'day',
            timeZone: 'UTC',
            startsAt: '2026-10-08T00:00:00.000Z',
            expiresAt: '2026-10-09T00:00:00.000Z',
            source: { stateKey: 'records' },
            projectionStateKeys: ['current'],
          },
        })
      : state === 'updated'
        ? referenceUpdatedSurface
        : referenceSurface
  const space = { ...referenceSpace, surfaces: state === 'empty' ? [] : [surface] }
  const turn =
    state === 'queued'
      ? referenceTurn('accepted')
      : state === 'error'
        ? referenceTurn('interrupted')
        : referenceTurn('running')
  const timeline = ['queued', 'error', 'loading'].includes(state) ? [turn] : []
  const messages: ChatMessage[] =
    state === 'empty' || state === 'offline'
      ? []
      : timeline.length
        ? [turn.message]
        : [
            { role: 'user', text: 'Help me make room for the weekend.' },
            {
              role: 'assistant',
              text: '**Three practical next steps**\n\n1. Confirm the kitchen appointment.\n2. Buy groceries for six people.\n3. Keep Saturday afternoon free.\n\nThe appointment message is ready for your approval.',
            },
          ]
  return (
    <PresentationContext.Provider
      value={{ ...presentation, reducedMotion: state === 'reduced-motion' }}
    >
      <MemoryRouter initialEntries={['/showcase/reference']}>
        <PortalContainerContext.Provider value={portalContainer}>
          <main
            ref={setPortalContainer}
            className="precision-tool product-reference"
            data-reference-state={state}
          >
            <header className="reference-heading">
              <div>
                <p className="reference-kicker">Contributor reference</p>
                <h1>Precision Tool</h1>
                <p>
                  Real product regions and the complete Atom catalog, with fixed local sample data.
                </p>
              </div>
              <label>
                Representative state
                <NativeSelect
                  value={state}
                  onChange={(event) => {
                    const next = referenceStates.find(
                      (candidate) => candidate === event.target.value,
                    )
                    if (next) {
                      setState(next)
                      setNotice('')
                    }
                  }}
                >
                  {referenceStates.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            </header>
            {state === 'offline' && (
              <p className="recipe-status" role="status">
                Waiting for connection
              </p>
            )}
            {notice && (
              <p className="recipe-status" role="status">
                {notice}
              </p>
            )}
            <div className="reference-grid">
              <ReferenceRegion name="Home" id="reference-home">
                <HomeSpaceGrid
                  spaces={
                    state === 'empty' || state === 'loading' || state === 'error'
                      ? []
                      : referenceSpaces
                  }
                  loadState={
                    state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'ready'
                  }
                  pendingDecisionCounts={new Map([[referenceSpace.id, 1]])}
                  onRetry={previewAction}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Space detail">
                <SpaceSection
                  space={space}
                  focused
                  focusedSurfaceId={undefined}
                  surfaceRevealFeedbackKeys={{}}
                  surfaceUpdateFeedbacks={
                    state === 'updated'
                      ? { [surface.id]: { key: 'reference-update', atomIds: ['plan-detail'] } }
                      : {}
                  }
                  onFocus={previewAction}
                  onMoveSurface={previewAction}
                  onTogglePin={previewAction}
                  onSurfaceRevealFeedbackShown={ignore}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Surface chrome">
                <SurfaceCard
                  surface={surface}
                  selected={false}
                  canMoveUp={false}
                  canMoveDown
                  onFocus={previewAction}
                  onMoveUp={previewAction}
                  onMoveDown={previewAction}
                  onTogglePin={previewAction}
                  onRevealFeedbackShown={ignore}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Chat">
                <ChatBar
                  entries={messages}
                  timelineEntries={timeline}
                  hasOlder={false}
                  loadingOlder={false}
                  queuedChat={
                    state === 'offline'
                      ? [
                          {
                            id: 'reference-offline',
                            text: 'Save the weekend plan when the connection returns.',
                            at: referenceAt,
                          },
                        ]
                      : []
                  }
                  streamingEntries={
                    state === 'loading'
                      ? [{ turnId: turn.turnId, text: 'Checking the latest plan…' }]
                      : []
                  }
                  focusedSpace={space}
                  focusToken="reference"
                  focusOnRouteChange={false}
                  pendingDecisionReviewPaths={new Map()}
                  dismissedDecisionIds={new Set()}
                  resolvingDecisionIds={new Set()}
                  onResolvePendingDecision={previewAction}
                  onDismissPendingDecision={previewAction}
                  onSend={() => {
                    previewAction()
                    return true
                  }}
                  onLoadOlder={previewAction}
                  onRetryInterrupted={previewAction}
                  onRetryQueued={previewAction}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Pending decisions">
                <SpacePendingDecisionNotifications
                  notifications={[{ decision: referenceDecision }]}
                  resolvingDecisionIds={
                    state === 'loading' ? new Set([referenceDecision.id]) : new Set()
                  }
                  onResolve={previewAction}
                  onDismiss={previewAction}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Onboarding">
                <WizardStepFirstSpace
                  status={referenceOnboarding}
                  busy={state === 'loading'}
                  onApply={previewAction}
                  error={
                    state === 'error'
                      ? 'The Space could not be saved. Your name is preserved; try again.'
                      : undefined
                  }
                />
              </ReferenceRegion>
              <ReferenceRegion name="Model connections">
                <ModelConnectionPanel
                  snapshot={
                    state === 'empty'
                      ? { ...referenceModels, connections: [], selection: null }
                      : referenceModels
                  }
                  busy={state === 'loading'}
                  error={
                    state === 'error'
                      ? 'The connection could not be verified. Retry when the provider is reachable.'
                      : null
                  }
                  now={() => new Date(referenceNow)}
                  onCreate={previewAction}
                  onAuthorize={previewAction}
                  onVerify={previewAction}
                  onApplySelection={async () => {
                    previewAction()
                    return false
                  }}
                  onUpdate={previewAction}
                  onRemove={previewAction}
                  onSetMock={previewAction}
                  onRefreshCatalog={previewAction}
                />
              </ReferenceRegion>
              <ReferenceRegion name="Shared recipes">
                <ReferenceRecipes />
              </ReferenceRegion>
              <ReferenceRegion name="Atom catalog" id="reference-atoms">
                {renderNode(referenceCatalog.tree, {
                  state:
                    state === 'empty'
                      ? { ...referenceCatalog.state, chartData: [], tableRows: [] }
                      : referenceCatalog.state,
                  theme: 'dark',
                  now: referenceNow,
                  motion: { reduced: state === 'reduced-motion' },
                  dispatch: previewAction,
                })}
              </ReferenceRegion>
            </div>
          </main>
        </PortalContainerContext.Provider>
      </MemoryRouter>
    </PresentationContext.Provider>
  )
}

function ReferenceRegion({
  name,
  id,
  children,
}: {
  name: string
  id?: string
  children: ReactNode
}) {
  return (
    <section id={id} className="reference-region recipe-surface" aria-label={`${name} reference`}>
      <h2>{name}</h2>
      {children}
    </section>
  )
}
