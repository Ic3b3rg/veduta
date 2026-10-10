import { Button } from '@veduta/catalog/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@veduta/catalog/ui/sheet'
import { ArrowUpRight, FileText, MessageSquare, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { ChatBar } from './chat-bar.tsx'
import { createChatViewState, type ChatViewState } from './chat-view-state.ts'
import type { PendingDecisionNotification } from './pending-decision-presentation.ts'

/** One conversation presentation in a desktop rail or a focus-managed mobile Sheet. */
export function ChatPanel({
  notifications = [],
  ...props
}: ComponentProps<typeof ChatBar> & {
  notifications?: PendingDecisionNotification[]
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.('(max-width: 959px)').matches ?? false,
  )
  const [open, setOpen] = useState(false)
  const [views] = useState(() => new Map<string, ChatViewState>())
  const heading = useRef<HTMLHeadingElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const scope = props.focusedSpace?.id ?? 'global'
  let view = views.get(scope)
  if (!view) {
    view = createChatViewState()
    views.set(scope, view)
  }

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 959px)')
    if (!media) return
    const change = () => setMobile(media.matches)
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!mobile || !open || !viewport) return
    const resize = () => {
      if (viewport.scale !== 1) return
      sheet.current?.style.setProperty('--chat-viewport-height', `${viewport.height}px`)
      sheet.current?.style.setProperty('--chat-viewport-top', `${viewport.offsetTop}px`)
    }
    resize()
    viewport.addEventListener('resize', resize)
    viewport.addEventListener('scroll', resize)
    return () => {
      viewport.removeEventListener('resize', resize)
      viewport.removeEventListener('scroll', resize)
    }
  }, [mobile, open])

  const conversation = (
    <ChatBar
      {...props}
      viewState={view}
      focusOnRouteChange={!mobile && props.focusOnRouteChange}
      onOpenResult={() => setOpen(false)}
    />
  )
  const title = (
    <>
      Chat <span>{props.focusedSpace?.name ?? 'Global'}</span>
    </>
  )
  const nextReview = notifications.find((notification) => notification.reviewPath !== undefined)
  const reviewAccess = nextReview && (
    <Link
      className="recipe-control chat-review-access"
      to={nextReview.reviewPath!}
      aria-label={`Review ${nextReview.decision.summary}`}
      title={nextReview.decision.summary}
      onClick={() => setOpen(false)}
    >
      <FileText aria-hidden="true" />
      <span>
        {notifications.length === 1
          ? 'Review 1 decision'
          : `Review next · ${notifications.length} pending`}
      </span>
      <ArrowUpRight aria-hidden="true" />
    </Link>
  )

  if (!mobile) {
    return (
      <aside className="chat-panel" aria-label="Chat">
        <header className="chat-panel-header">
          <h2>{title}</h2>
        </header>
        {reviewAccess}
        {conversation}
      </aside>
    )
  }

  return (
    <>
      <div className="chat-mobile-access">
        {reviewAccess}
        <Button
          ref={launcher}
          className="recipe-control chat-launcher"
          data-variant="primary"
          aria-label="Open Chat"
          title="Open Chat"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <MessageSquare aria-hidden="true" />
          {(props.streamingEntries.length > 0 || props.queuedChat.length > 0) && (
            <span className="chat-launcher-activity" aria-hidden="true" />
          )}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          ref={sheet}
          side="bottom"
          showCloseButton={false}
          className="recipe-overlay chat-sheet"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            heading.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            launcher.current?.focus({ preventScroll: true })
          }}
        >
          <header className="chat-panel-header">
            <SheetTitle ref={heading} tabIndex={-1}>
              {title}
            </SheetTitle>
            <Button
              className="recipe-control chat-close"
              aria-label="Back to Space"
              title="Back to Space"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          {reviewAccess}
          {conversation}
        </SheetContent>
      </Sheet>
    </>
  )
}
