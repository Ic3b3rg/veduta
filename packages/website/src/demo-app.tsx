import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { SpaceWithSurfacesSchema, SYSTEM_SPACE_ID, type ChatMessage } from '@veduta/protocol'
import {
  ChatBar,
  HomeSpaceGrid,
  PresentationContext,
  SpaceSection,
  clientPath,
} from '@veduta/pwa/demo-components'
import {
  DEMO_SPACE_REQUEST,
  DEMO_CREATE_REQUEST,
  DEMO_EDIT_REQUEST,
  demoSeed,
  demoSurface,
} from '@veduta/demo-data'
import { readDemoState, saveDemoState, transitionDemo, type DemoAction } from './demo-state.ts'
const ignore = () => {}

export function Demo() {
  const [loaded] = useState(() => {
    try {
      return readDemoState(localStorage)
    } catch {
      return readDemoState({
        getItem: () => {
          throw new Error('Storage unavailable')
        },
      })
    }
  })
  const [state, setState] = useState(loaded.state)
  const [warning, setWarning] = useState(loaded.warning)
  const [notice, setNotice] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const seed = demoSeed(state.updatedAt)
  const hasWork = ['space', 'surface', 'edited'].includes(state.stage)
  const hasSurface = state.stage === 'surface' || state.stage === 'edited'
  const spaces = [
    ...seed.spaces.map((space) => ({
      ...space,
      surfaces: seed.surfaces.filter((surface) => surface.spaceId === space.id),
    })),
    ...(hasWork
      ? [
          {
            id: 'demo-work',
            slug: 'work',
            name: 'Work',
            archived: false,
            surfaces: hasSurface
              ? [demoSurface('demo-work', state.stage === 'edited', state.updatedAt)]
              : [],
          },
        ]
      : []),
    { id: SYSTEM_SPACE_ID, slug: 'system', name: 'System', archived: false, surfaces: [] },
  ].map((space) =>
    SpaceWithSurfacesSchema.parse({
      ...space,
      surfaces: space.surfaces.map((surface) => ({ ...surface, pinnable: false })),
    }),
  )
  const focused = spaces.find((space) => location.pathname.startsWith(clientPath.space(space.slug)))

  function act(action: DemoAction) {
    try {
      const next = transitionDemo(state, action)
      setState(next)
      setNotice('')
      try {
        saveDemoState(next, localStorage)
        setWarning(null)
      } catch {
        setWarning(
          'Browser storage is unavailable. Changes work in this tab, but refreshing will discard them.',
        )
      }
      if (action === 'accept') navigate(clientPath.space('work'))
      if (action === 'reset') navigate('/')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Try the next guided step.')
    }
  }

  const entries: ChatMessage[] = []
  if (state.stage !== 'start')
    entries.push(
      { role: 'user', text: DEMO_SPACE_REQUEST },
      {
        role: 'assistant',
        text: hasWork
          ? 'Work is ready. Prepare a Surface for your weekly priorities.'
          : 'Create Work to keep your plans together. Confirm below to continue.',
      },
    )
  if (hasSurface)
    entries.push(
      { role: 'user', text: DEMO_CREATE_REQUEST },
      { role: 'assistant', text: 'Weekly plan is ready, with three priorities.' },
    )
  if (state.stage === 'edited')
    entries.push(
      { role: 'user', text: DEMO_EDIT_REQUEST },
      {
        role: 'assistant',
        text: 'Talk to testers is now the top priority, on Tuesday. Refresh to check that your change stays here.',
      },
    )
  const nextAction =
    state.stage === 'start' ? 'propose' : state.stage === 'space' ? 'create' : 'edit'
  const nextPrompt =
    nextAction === 'propose'
      ? DEMO_SPACE_REQUEST
      : nextAction === 'create'
        ? DEMO_CREATE_REQUEST
        : DEMO_EDIT_REQUEST

  return (
    <PresentationContext.Provider value={{ theme: 'dark' }}>
      <div className="precision-tool demo-app">
        <header className="demo-header">
          <a href="./index.html" className="product-wordmark">
            Veduta
          </a>
          <span>Guided demo · fictional data</span>
          <button type="button" onClick={() => act('reset')}>
            Reset demo
          </button>
          <a href="https://github.com/Ic3b3rg/veduta">GitHub</a>
        </header>
        <p className="demo-disclosure">
          Scripted responses. Changes stay in this browser. No model, accounts, external tools or
          Gateway are connected. Please use the sample prompts.
        </p>
        {warning && (
          <p className="demo-warning" role="alert">
            {warning}
          </p>
        )}
        <div className="demo-layout">
          <section className="demo-guide" aria-label="Next demo step">
            <h2>Try one small change.</h2>
            {state.stage === 'proposed' ? (
              <button className="demo-next" onClick={() => act('accept')}>
                Accept Create Space “Work”
              </button>
            ) : state.stage === 'edited' ? (
              <button className="demo-next" onClick={() => window.location.reload()}>
                Refresh and see it stay
              </button>
            ) : (
              <button className="demo-next" onClick={() => act(nextAction)}>
                {nextPrompt}
              </button>
            )}
            <p className="demo-hint">You can also send the sample prompt through Chat.</p>
            {notice && (
              <p role="status" className="demo-warning">
                {notice}
              </p>
            )}
          </section>
          <main id="demo-content">
            <nav className="demo-navigation" aria-label="Demo Spaces">
              <Link to="/" aria-current={!focused ? 'page' : undefined}>
                Home
              </Link>
              {spaces
                .filter((space) => space.id !== SYSTEM_SPACE_ID)
                .map((space) => (
                  <Link
                    key={space.id}
                    to={clientPath.space(space.slug)}
                    aria-current={focused?.id === space.id ? 'page' : undefined}
                  >
                    {space.slug === 'home' ? 'Home Space' : space.name}
                  </Link>
                ))}
            </nav>
            {focused ? (
              <SpaceSection
                space={focused}
                focused
                focusedSurfaceId={location.pathname.split('/surface/')[1]}
                surfaceRevealFeedbackKeys={{}}
                surfaceUpdateFeedbacks={{}}
                onFocus={(space, surface) =>
                  navigate(
                    surface
                      ? clientPath.surface(space.slug, surface.id)
                      : clientPath.space(space.slug),
                  )
                }
                onMoveSurface={ignore}
                onTogglePin={ignore}
                onSurfaceRevealFeedbackShown={ignore}
              />
            ) : (
              <HomeSpaceGrid spaces={spaces} loadState="ready" onRetry={() => act('reset')} />
            )}
            {focused && focused.surfaces.length === 0 && (
              <p className="demo-empty">
                {focused.id === 'demo-work'
                  ? 'Work is ready. Use the next sample prompt to prepare your Weekly plan.'
                  : 'System controls are available in the full self-hosted app.'}
              </p>
            )}
          </main>
          <aside className="demo-chat" aria-label="Guided Chat">
            <h2>Chat</h2>
            <ChatBar
              entries={entries}
              timelineEntries={[]}
              hasOlder={false}
              loadingOlder={false}
              queuedChat={[]}
              streamingEntries={[]}
              focusedSpace={focused}
              focusToken={location.pathname}
              focusOnRouteChange={false}
              pendingDecisionReviewPaths={new Map()}
              dismissedDecisionIds={new Set()}
              resolvingDecisionIds={new Set()}
              onResolvePendingDecision={ignore}
              onDismissPendingDecision={ignore}
              onSend={(text) => {
                const action =
                  text.trim() === DEMO_SPACE_REQUEST
                    ? 'propose'
                    : text.trim() === DEMO_CREATE_REQUEST
                      ? 'create'
                      : text.trim() === DEMO_EDIT_REQUEST
                        ? 'edit'
                        : undefined
                if (action) act(action)
                else
                  setNotice(
                    'This demo supports the three sample prompts above. Try locally with a real Model connection for your own requests.',
                  )
                return true
              }}
              onLoadOlder={ignore}
              onRetryInterrupted={ignore}
              onRetryQueued={ignore}
            />
          </aside>
        </div>
      </div>
    </PresentationContext.Provider>
  )
}
