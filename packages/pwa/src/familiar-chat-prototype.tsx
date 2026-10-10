import { Button } from '@veduta/catalog/ui/button'
import { NativeSelect } from '@veduta/catalog/ui/native-select'
import { PortalContainerContext } from '@veduta/catalog/ui/portal-container'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@veduta/catalog/ui/sheet'
import { SYSTEM_SPACE_ID, type RenderableSurface } from '@veduta/protocol'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  Info,
  MessageSquare,
  RotateCcw,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react'
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { PrototypeConversation } from './familiar-chat-prototype-conversation.tsx'
import {
  afterWalk,
  beforeWalk,
  initialMessages,
  longReply,
  prototypeNow,
  prototypeSpace,
  weeklyPlan,
  type PrototypeMessage,
} from './familiar-chat-prototype-data.ts'
import { HomeSpaceGrid } from './home-space-grid.tsx'
import { PresentationContext } from './presentation-context.ts'
import { SpaceNavigation } from './space-navigation.tsx'
import { SpaceSection } from './space-section.tsx'
import './familiar-chat-prototype.css'

const systemSpace: SpaceWithSurfaces = {
  id: SYSTEM_SPACE_ID,
  slug: 'system',
  name: 'System',
  archived: false,
  attention: 0,
  attentionRevision: 0,
  surfaces: [],
}

/** One disposable proposal on the existing Space route; research 42 and issue #228. */
export function FamiliarChatPrototype() {
  const [generation, setGeneration] = useState(0)
  return (
    <MemoryRouter initialEntries={['/app/space/health']}>
      <PrototypeScene key={generation} onReset={() => setGeneration((value) => value + 1)} />
    </MemoryRouter>
  )
}

function PrototypeScene({ onReset }: { onReset: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [space, setSpace] = useState(prototypeSpace)
  const [focusedSurfaceId, setFocusedSurfaceId] = useState<string>()
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState('')
  const [decision, setDecision] = useState<'none' | 'pending' | 'accepted' | 'declined'>('none')
  const [generating, setGenerating] = useState(false)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 959px)').matches)
  const [chatOpen, setChatOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [model, setModel] = useState('Reasoning')
  const [connection, setConnection] = useState('Personal subscription')
  const [notice, setNotice] = useState('')
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const readingPosition = useRef(0)
  const chatHeading = useRef<HTMLHeadingElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const activeSpace = location.pathname.includes('/space/health')
    ? space
    : location.pathname.includes('/space/system')
      ? systemSpace
      : undefined
  const isHealth = activeSpace?.id === space.id

  useEffect(() => {
    const query = matchMedia('(max-width: 959px)')
    const onChange = () => setMobile(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  useEffect(() => () => clearInterval(timer.current), [])
  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timeout)
  }, [notice])

  function stop() {
    clearInterval(timer.current)
    setGenerating(false)
  }

  function send(text: string) {
    if (!text.trim() || generating) return
    const userId = Date.now()
    const proposes = /move|friday|saturday|sposta|venerd|sabato|change/i.test(text)
    const alreadyPending = decision === 'pending'
    const createsProposal = proposes && !alreadyPending && decision !== 'accepted'
    const answer =
      alreadyPending && proposes
        ? 'The change is still waiting for your review. The Weekly plan has not changed.'
        : proposes && decision === 'accepted'
          ? 'Saturday at 10:00 is already in your Weekly plan. The 40-minute walk was moved after you accepted the change.'
          : createsProposal
            ? 'I can move the **40-minute walk** from Friday at 18:30 to Saturday at 10:00. Monday and Wednesday stay the same.\n\nYour plan is pinned, so nothing changes until you review and accept.'
            : longReply
    setDraft('')
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', text },
      { id: userId + 1, role: 'assistant', text: '' },
    ])
    setGenerating(true)
    let length = 0
    timer.current = setInterval(() => {
      length = Math.min(answer.length, length + 190)
      const done = length === answer.length
      setMessages((current) =>
        current.map((message): PrototypeMessage =>
          message.id === userId + 1
            ? {
                ...message,
                text: answer.slice(0, length),
                ...(done && createsProposal ? { proposal: true } : {}),
              }
            : message,
        ),
      )
      if (done) {
        clearInterval(timer.current)
        setGenerating(false)
        if (createsProposal) setDecision('pending')
      }
    }, 180)
  }

  function rememberFocus() {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  function openReview() {
    rememberFocus()
    setReviewOpen(true)
  }

  function resolve(next: 'accepted' | 'declined') {
    if (decision !== 'pending') return
    setDecision(next)
    setMessages((current) =>
      current.map((message) =>
        message.proposal && !message.resolution ? { ...message, resolution: next } : message,
      ),
    )
    if (next === 'accepted')
      setSpace((current) => ({
        ...current,
        surfaces: current.surfaces.map((surface) =>
          surface.id === weeklyPlan().id
            ? { ...weeklyPlan(true), pinned: surface.pinned }
            : surface,
        ),
      }))
    setReviewOpen(false)
    setNotice(
      next === 'accepted'
        ? 'Walk moved to Saturday. Weekly plan updated.'
        : 'Change declined. Weekly plan unchanged.',
    )
  }

  function showSurface() {
    setChatOpen(false)
    setFocusedSurfaceId(weeklyPlan().id)
    navigate('/app/space/health')
    setTimeout(
      () =>
        document
          .querySelector<HTMLElement>('.surface-card.selected')
          ?.scrollIntoView({ block: 'nearest' }),
      0,
    )
  }

  function focusSpace(next: SpaceWithSurfaces, surface?: RenderableSurface) {
    setFocusedSurfaceId(surface?.id)
    navigate(`/app/space/${next.slug}`)
  }

  const conversation = (
    <PrototypeConversation
      messages={messages}
      draft={draft}
      onDraft={setDraft}
      onSend={send}
      generating={generating}
      onStop={stop}
      readingPositionRef={readingPosition}
      decision={decision}
      onReview={openReview}
      onSurface={showSurface}
    />
  )
  const chatHeader = (
    <header className="familiar-chat-header">
      <div>
        <h2 ref={chatHeading} tabIndex={-1}>
          Chat <span>Health</span>
        </h2>
      </div>
      {mobile ? (
        <Button
          className="recipe-control familiar-icon"
          aria-label="Back to Space"
          title="Back to Space"
          onClick={() => setChatOpen(false)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : (
        <span className="familiar-local-indicator">Local demo</span>
      )}
    </header>
  )

  return (
    <PresentationContext.Provider value={{ theme: 'dark', now: prototypeNow }}>
      <PortalContainerContext.Provider value={portalContainer}>
        <div className="precision-tool familiar-prototype" ref={setPortalContainer}>
          <a href="#familiar-main" className="skip-link">
            Skip to Space
          </a>
          <header className="topbar">
            <h1 className="product-wordmark">Veduta</h1>
            <div className="topbar-actions">
              <Button
                className="recipe-control familiar-model-trigger"
                aria-label="Choose model"
                onClick={() => {
                  rememberFocus()
                  setModelOpen(true)
                }}
              >
                {model}
                <ChevronDown aria-hidden="true" />
              </Button>
              <Button
                className="recipe-control"
                onClick={() => {
                  rememberFocus()
                  setHelpOpen(true)
                }}
              >
                <Info aria-hidden="true" />
                Demo
              </Button>
            </div>
          </header>
          <div className="familiar-body">
            <div className="familiar-space-layout">
              <div className="familiar-navigation">
                <Link className="familiar-home-link" to="/app">
                  <ArrowLeft aria-hidden="true" />
                  Home
                </Link>
                <SpaceNavigation
                  spaces={[space, systemSpace]}
                  selectedSpace={activeSpace}
                  onFocusSpace={focusSpace}
                />
              </div>
              <main
                className="familiar-main"
                id="familiar-main"
                aria-label={activeSpace?.name ?? 'Home'}
              >
                {activeSpace ? (
                  <>
                    <SpaceSection
                      space={activeSpace}
                      focused
                      focusedSurfaceId={focusedSurfaceId}
                      surfaceRevealFeedbackKeys={{}}
                      surfaceUpdateFeedbacks={{}}
                      onFocus={focusSpace}
                      onMoveSurface={(_space, surfaceId, direction) =>
                        setSpace((current) => {
                          const surfaces = [...current.surfaces]
                          const from = surfaces.findIndex((surface) => surface.id === surfaceId)
                          const to = from + (direction === 'up' ? -1 : 1)
                          const source = surfaces[from]
                          const target = surfaces[to]
                          if (source && target) {
                            surfaces[to] = source
                            surfaces[from] = target
                          }
                          return { ...current, surfaces }
                        })
                      }
                      onTogglePin={(surface, pinned) =>
                        setSpace((current) => ({
                          ...current,
                          surfaces: current.surfaces.map((candidate) =>
                            candidate.id === surface.id ? { ...candidate, pinned } : candidate,
                          ),
                        }))
                      }
                      onSurfaceRevealFeedbackShown={() => {}}
                    />
                    {!isHealth && (
                      <p className="familiar-empty">
                        This local demo focuses on the Health Space.{' '}
                        <Link to="/app/space/health">Return to Health</Link>
                      </p>
                    )}
                  </>
                ) : (
                  <HomeSpaceGrid
                    spaces={[space, systemSpace]}
                    loadState="ready"
                    pendingDecisionCounts={new Map([[space.id, decision === 'pending' ? 1 : 0]])}
                    onRetry={() => {}}
                  />
                )}
              </main>
            </div>
            {!mobile && isHealth && (
              <aside className="familiar-chat" aria-label="Chat in Health">
                {chatHeader}
                {conversation}
              </aside>
            )}
          </div>
          {mobile && isHealth && (
            <div className="familiar-mobile-access">
              {decision === 'pending' && (
                <Button className="recipe-control familiar-review-access" onClick={openReview}>
                  <FileText aria-hidden="true" />
                  Review 1 change
                  <ArrowUpRight aria-hidden="true" />
                </Button>
              )}
              <Button
                ref={launcher}
                className="recipe-control familiar-chat-launcher"
                data-variant="primary"
                onClick={() => setChatOpen(true)}
                aria-label="Open Chat"
              >
                <MessageSquare aria-hidden="true" />
                Chat{generating && <span className="familiar-unread" />}
              </Button>
            </div>
          )}
          {notice && (
            <div className="familiar-toast" role="status">
              <Check aria-hidden="true" />
              <span>{notice}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
                <X aria-hidden="true" />
              </button>
            </div>
          )}
          <Sheet open={mobile && chatOpen && isHealth} onOpenChange={setChatOpen}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="recipe-overlay familiar-chat-sheet"
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                chatHeading.current?.focus()
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                launcher.current?.focus({ preventScroll: true })
              }}
            >
              <SheetTitle className="sr-only">Chat in Health</SheetTitle>
              {chatHeader}
              {mobile && conversation}
            </SheetContent>
          </Sheet>
          <PrototypeOverlay
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            title="Review change"
            description="Weekly plan · Health"
            returnFocusRef={returnFocus}
          >
            <div className="familiar-review-content">
              <div className="familiar-review-intro">
                <FileText aria-hidden="true" />
                <div>
                  <h3>Move Friday’s walk to Saturday</h3>
                  <p>One entry in your pinned Weekly plan.</p>
                </div>
              </div>
              <div className="familiar-comparison">
                <section>
                  <h4>Current</h4>
                  <p>{beforeWalk}</p>
                </section>
                <section data-proposed>
                  <h4>After accepting</h4>
                  <p>{afterWalk}</p>
                </section>
              </div>
              <div className="familiar-review-details">
                <h4>What this changes</h4>
                <ul>
                  <li>The Friday walk moves to Saturday morning.</li>
                  <li>Its duration stays 40 minutes.</li>
                  <li>The Monday and Wednesday walks stay the same.</li>
                </ul>
                <p>
                  Accepting updates the Weekly plan. Declining keeps the current plan. No reminders
                  or calendar events will be created.
                </p>
              </div>
            </div>
            <footer className="familiar-review-footer">
              <Button className="recipe-control" onClick={() => resolve('declined')}>
                Decline
              </Button>
              <Button
                className="recipe-control"
                data-variant="primary"
                onClick={() => resolve('accepted')}
              >
                <Check aria-hidden="true" />
                Accept change
              </Button>
            </footer>
          </PrototypeOverlay>
          <PrototypeOverlay
            open={modelOpen}
            onOpenChange={setModelOpen}
            title="Model settings"
            description="Choose how Veduta responds."
            returnFocusRef={returnFocus}
          >
            <div className="familiar-settings">
              <label>
                Model connection
                <NativeSelect
                  value={connection}
                  onChange={(event) => setConnection(event.target.value)}
                >
                  <option>Personal subscription</option>
                  <option>API connection</option>
                </NativeSelect>
              </label>
              <label>
                Model
                <NativeSelect value={model} onChange={(event) => setModel(event.target.value)}>
                  <option>Reasoning</option>
                  <option>Fast</option>
                </NativeSelect>
              </label>
              <p>These are sample choices. Replies in this demo are preset.</p>
            </div>
            <footer className="familiar-review-footer">
              <Button
                className="recipe-control"
                data-variant="primary"
                onClick={() => setModelOpen(false)}
              >
                Done
              </Button>
            </footer>
          </PrototypeOverlay>
          <PrototypeOverlay
            open={helpOpen}
            onOpenChange={setHelpOpen}
            title="Try the Chat proposal"
            description="A disposable local prototype for issue #228."
            returnFocusRef={returnFocus}
          >
            <div className="familiar-settings">
              <ol>
                <li>
                  Open Chat, then choose <strong>Explain the plan</strong> to read a long reply.
                </li>
                <li>
                  Ask to <strong>move Friday’s walk</strong>, then review the exact change.
                </li>
                <li>Accept or decline, and return to the Space.</li>
                <li>
                  Write a draft, close Chat, and reopen it. Your draft and reading position stay.
                </li>
              </ol>
              <p>
                Replies, model choices and changes are simulated in memory. Reload resets
                everything. This does not connect to your VPS or an AI provider.
              </p>
            </div>
            <footer className="familiar-review-footer">
              <Button
                className="recipe-control"
                onClick={() => {
                  navigate('/app/space/health')
                  onReset()
                }}
              >
                <RotateCcw aria-hidden="true" />
                Restart demo
              </Button>
              <Button
                className="recipe-control"
                data-variant="primary"
                onClick={() => setHelpOpen(false)}
              >
                Try it
              </Button>
            </footer>
          </PrototypeOverlay>
        </div>
      </PortalContainerContext.Provider>
    </PresentationContext.Provider>
  )
}

function PrototypeOverlay({
  open,
  onOpenChange,
  title,
  description,
  returnFocusRef,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  returnFocusRef: MutableRefObject<HTMLElement | null>
  children: ReactNode
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="recipe-overlay familiar-overlay"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          heading.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusRef.current?.isConnected)
            returnFocusRef.current.focus({ preventScroll: true })
        }}
      >
        <header className="familiar-overlay-heading">
          <div>
            <SheetTitle ref={heading} tabIndex={-1}>
              {title}
            </SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </div>
          <Button
            className="recipe-control familiar-icon"
            aria-label={`Close ${title}`}
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        {children}
      </SheetContent>
    </Sheet>
  )
}
