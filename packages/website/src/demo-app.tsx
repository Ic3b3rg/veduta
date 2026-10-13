import { useState } from 'react'
import type { ChatMessage } from '@veduta/protocol'
import { Link } from 'react-router-dom'
import {
  AppShell,
  ClientRouteTable,
  PresentationContext,
  clientPath,
  useClientRouting,
} from '@veduta/pwa/demo-components'
import { DEMO_SPACE_REQUEST, DEMO_CREATE_REQUEST, DEMO_EDIT_REQUEST } from '@veduta/demo-data'
import { readDemoState, saveDemoState, transitionDemo, type DemoAction } from './demo-state.ts'
import { DEMO_DECISION_ID, DEMO_WORK_ID, demoProjection } from './demo-projection.ts'

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
  const [chatHint, setChatHint] = useState<{ scope: string; text: string } | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [dismissedDecisionIds, setDismissedDecisionIds] = useState(new Set<string>())
  const { navigate, spaceSlug, surfaceId, locationKey, focusChatOnRouteChange } = useClientRouting()
  const projection = demoProjection(state)
  const focused = projection.spaces.find((space) => space.slug === spaceSlug)
  const chatScope = focused?.id ?? 'global'

  function act(action: DemoAction): boolean {
    try {
      const next = transitionDemo(state, action)
      setState(next)
      setNotice('')
      setChatHint(null)
      try {
        saveDemoState(next, localStorage)
        setWarning(null)
      } catch {
        setWarning(
          'Browser storage is unavailable. Changes work in this tab, but refreshing will discard them.',
        )
      }
      if (action === 'reset') {
        setResetKey((value) => value + 1)
        setDismissedDecisionIds(new Set())
        navigate(clientPath.home)
      }
      if (action === 'propose') {
        setDismissedDecisionIds(new Set())
        navigate(clientPath.home)
      }
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Try the next guided step.')
      return false
    }
  }

  const guide = (
    <section className="demo-guide" aria-label="Demo guide">
      <div className="demo-guide-bar">
        <details>
          <summary>Guided demo · fictional data</summary>
          <div className="demo-guide-content">
            <p>
              Scripted responses. Changes stay in this browser. No model, accounts, external tools
              or Gateway are connected. Use these sample prompts through Chat or the guide.
            </p>
            {state.stage === 'proposed' ? (
              <p>Open Chat and accept the Work proposal. You can also reject it and start again.</p>
            ) : state.stage === 'edited' ? (
              <button className="recipe-control demo-next" onClick={() => window.location.reload()}>
                Refresh and see it stay
              </button>
            ) : state.stage === 'start' || state.stage === 'rejected' ? (
              <button className="recipe-control demo-next" onClick={() => act('propose')}>
                {DEMO_SPACE_REQUEST}
              </button>
            ) : focused?.id !== DEMO_WORK_ID ? (
              <Link className="recipe-control demo-next" to={clientPath.space('work')}>
                Open Work
              </Link>
            ) : (
              <button
                className="recipe-control demo-next"
                onClick={() => act(state.stage === 'space' ? 'create' : 'edit')}
              >
                {state.stage === 'space' ? DEMO_CREATE_REQUEST : DEMO_EDIT_REQUEST}
              </button>
            )}
          </div>
        </details>
        <nav aria-label="Demo controls">
          <button className="recipe-control" type="button" onClick={() => act('reset')}>
            Reset demo
          </button>
          <a href="./index.html">About Veduta</a>
          <a href="https://github.com/Ic3b3rg/veduta">GitHub</a>
        </nav>
      </div>
      {warning && (
        <p className="demo-warning" role="alert">
          {warning}
        </p>
      )}
      {notice && (
        <p className="demo-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  )

  const shell = (
    <AppShell
      key={resetKey}
      brandMarkSrc="./icons/logo-mark.png"
      announcement={guide}
      gatewayOnline
      queuedCount={0}
      error={null}
      onDismissError={ignore}
      spaces={projection.spaces}
      homeSpacesLoadState="ready"
      route={
        spaceSlug === undefined
          ? { kind: 'home' }
          : { kind: 'space', slug: spaceSlug, space: focused, surfaceId }
      }
      surfaceRevealFeedbackKeys={{}}
      surfaceUpdateFeedbacks={{}}
      pendingDecisions={projection.pendingDecisions}
      dismissedDecisionIds={dismissedDecisionIds}
      resolvingDecisionIds={new Set()}
      automationOutcomeNotifications={[]}
      pendingAutomationOutcomeNotificationIds={new Set()}
      chatEntries={[
        ...(focused === undefined
          ? projection.globalEntries
          : focused.id === DEMO_WORK_ID
            ? projection.workEntries
            : []),
        ...(chatHint?.scope === chatScope
          ? [{ role: 'assistant', text: chatHint.text } satisfies ChatMessage]
          : []),
      ]}
      chatTimelineEntries={[]}
      chatHasOlder={false}
      chatLoadingOlder={false}
      queuedChat={[]}
      streamingEntries={[]}
      focusChatToken={locationKey}
      focusChatOnRouteChange={focusChatOnRouteChange}
      onOpenSettings={() =>
        setNotice(
          'Settings, connections and notifications are available in the self-hosted app. This demo uses fictional data only.',
        )
      }
      onRetrySpaces={() => act('reset')}
      onFocusSpace={(space, surface) =>
        navigate(
          surface ? clientPath.surface(space.slug, surface.id) : clientPath.space(space.slug),
        )
      }
      onMoveSurface={ignore}
      onTogglePin={ignore}
      onSurfaceRevealFeedbackShown={ignore}
      onResolvePendingDecision={(id, resolution) => {
        if (id === DEMO_DECISION_ID && state.stage === 'proposed') {
          if (resolution === 'accept') act('accept')
          if (resolution === 'reject') act('reject')
        }
      }}
      onDismissPendingDecision={(id) =>
        setDismissedDecisionIds((previous) => new Set([...previous, id]))
      }
      onOpenAutomationOutcomeNotification={ignore}
      onDismissAutomationOutcomeNotification={ignore}
      onSend={(text) => {
        if (text.trim() === DEMO_SPACE_REQUEST && focused === undefined) return act('propose')
        if (focused?.id === DEMO_WORK_ID) {
          if (text.trim() === DEMO_CREATE_REQUEST) return act('create')
          if (text.trim() === DEMO_EDIT_REQUEST) return act('edit')
        }
        setChatHint({
          scope: chatScope,
          text: 'This demo supports the three sample prompts in the guide. Create Work from Global Chat, then prepare and edit the plan in Work.',
        })
        return false
      }}
      onLoadOlderChat={ignore}
      onRetryInterruptedChat={ignore}
      onRetryQueuedChat={ignore}
    />
  )

  return (
    <PresentationContext.Provider value={{ theme: 'dark' }}>
      <ClientRouteTable
        appShell={shell}
        modelConnections={shell}
        gmailConnections={shell}
        himalayaConnections={shell}
        serviceConnections={shell}
      />
    </PresentationContext.Provider>
  )
}
