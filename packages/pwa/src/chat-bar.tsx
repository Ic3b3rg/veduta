import type { ChatMessage, ChatTimelineEntry, PendingDecisionResolution } from '@veduta/protocol'
import { structuredMarkdown } from '@veduta/catalog'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@veduta/catalog/ui/card'
import { Button } from '@veduta/catalog/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@veduta/catalog/ui/input-group'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import { PendingDecisionControls } from './pending-decision-notifications.tsx'
import type { QueuedChat } from './pwa-storage.ts'
import { pendingDecisionStatus } from './pending-decision-status.ts'
import { createChatViewState, type ChatViewState } from './chat-view-state.ts'

export function ChatBar({
  gatewayOnline = true,
  entries,
  timelineEntries,
  hasOlder,
  loadingOlder,
  queuedChat,
  streamingEntries,
  focusedSpace,
  focusToken,
  focusOnRouteChange,
  pendingDecisionReviewPaths,
  dismissedDecisionIds,
  resolvingDecisionIds,
  onResolvePendingDecision,
  onDismissPendingDecision,
  onSend,
  onLoadOlder,
  onRetryInterrupted,
  onRetryQueued,
  viewState,
  onOpenResult,
}: {
  gatewayOnline?: boolean
  entries: ChatMessage[]
  timelineEntries: ChatTimelineEntry[]
  hasOlder: boolean
  loadingOlder: boolean
  queuedChat: QueuedChat[]
  /** In-flight `chat.turn-*` turns, keyed by turnId (issue 037). Always
   * rendered after `entries` -- a turn only lands in `entries` once
   * `chat.turn-end`/`chat.turn-error` closes it. */
  streamingEntries: { turnId: string; text: string }[]
  focusedSpace: SpaceWithSurfaces | undefined
  focusToken: string
  focusOnRouteChange: boolean
  pendingDecisionReviewPaths: ReadonlyMap<string, string>
  dismissedDecisionIds: ReadonlySet<string>
  resolvingDecisionIds: ReadonlySet<string>
  onResolvePendingDecision: (
    decisionId: string,
    resolution: PendingDecisionResolution,
  ) => Promise<void> | void
  onDismissPendingDecision: (decisionId: string) => void
  onSend: (text: string) => boolean
  onLoadOlder: () => void
  onRetryInterrupted: (turnId: string) => void
  onRetryQueued: (id: string) => void
  viewState?: ChatViewState
  onOpenResult?: () => void
}) {
  const [localView] = useState(createChatViewState)
  const view = viewState ?? localView
  const [draft, setDraft] = useState({ view, text: view.getSnapshot().draft })
  if (draft.view !== view) setDraft({ view, text: view.getSnapshot().draft })
  const text = draft.view === view ? draft.text : view.getSnapshot().draft
  const setText = (next: string) => {
    view.remember({ draft: next })
    setDraft({ view, text: next })
  }
  const [isAtBottom, setIsAtBottom] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const anchorNextUserRef = useRef<HTMLElement | null | undefined>(undefined)
  const olderPageAnchor = useRef<{ id: string; top: number } | undefined>(undefined)
  const followsLatestRef = useRef(view.getSnapshot().followsLatest)
  const logGeometryRef = useRef({ scrollHeight: 0, clientHeight: 0, clientWidth: 0, scrollTop: 0 })

  const updateScroll = useCallback(
    (preserveFollowing: boolean) => {
      const log = logRef.current
      if (!log) return
      const held = olderPageAnchor.current
      const firstEntry = log.querySelector<HTMLElement>('[data-chat-entry-id]')
      if (held && firstEntry?.dataset.chatEntryId !== held.id) {
        const previousEntry = [...log.querySelectorAll<HTMLElement>('[data-chat-entry-id]')].find(
          (entry) => entry.dataset.chatEntryId === held.id,
        )
        if (previousEntry) log.scrollTop += previousEntry.getBoundingClientRect().top - held.top
        olderPageAnchor.current = undefined
        followsLatestRef.current = false
      }
      const latestUser = resizeReadingSpace(
        log,
        spacerRef.current,
        view.getSnapshot().anchorLatestTurn,
      )
      if (
        anchorNextUserRef.current !== undefined &&
        latestUser &&
        latestUser !== anchorNextUserRef.current
      ) {
        log.scrollTop +=
          latestUser.getBoundingClientRect().top - log.getBoundingClientRect().top - 24
        anchorNextUserRef.current = undefined
        followsLatestRef.current = false
      }
      const geometry = {
        scrollHeight: log.scrollHeight,
        clientHeight: log.clientHeight,
        clientWidth: log.clientWidth,
      }
      const previous = logGeometryRef.current
      const resized =
        geometry.scrollHeight !== previous.scrollHeight ||
        geometry.clientHeight !== previous.clientHeight ||
        geometry.clientWidth !== previous.clientWidth
      const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
      const movedUp = log.scrollTop <= Math.min(previous.scrollTop, maximum) - 1
      // Resize can emit scroll before ResizeObserver. Keep following unless the reader moved up;
      // clamping to a smaller maximum after content shrinks is not an upward reading gesture.
      if (followsLatestRef.current && !movedUp && (preserveFollowing || resized)) {
        log.scrollTop = log.scrollHeight
      }
      logGeometryRef.current = { ...geometry, scrollTop: log.scrollTop }
      const atBottom = isChatLogAtBottom(log)
      if (
        !view.getSnapshot().anchorLatestTurn ||
        (!preserveFollowing && Math.abs(log.scrollTop - previous.scrollTop) >= 1)
      )
        followsLatestRef.current = atBottom
      view.remember({ scrollTop: log.scrollTop, followsLatest: followsLatestRef.current })
      setIsAtBottom(atBottom)
    },
    [view],
  )

  useLayoutEffect(() => {
    const saved = view.getSnapshot()
    olderPageAnchor.current = undefined
    anchorNextUserRef.current = undefined
    followsLatestRef.current = saved.followsLatest
    logGeometryRef.current = { scrollHeight: 0, clientHeight: 0, clientWidth: 0, scrollTop: 0 }
    const log = logRef.current
    if (log) {
      resizeReadingSpace(log, spacerRef.current, saved.anchorLatestTurn)
      if (saved.scrollTop !== undefined) log.scrollTop = saved.scrollTop
    }
  }, [view])

  useEffect(() => {
    if (focusOnRouteChange && !usesTouchComposer()) inputRef.current?.focus()
  }, [focusOnRouteChange, focusToken])

  useLayoutEffect(() => {
    const log = logRef.current
    if (!log) return
    const updateGeometry = () => updateScroll(true)
    updateGeometry()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateGeometry)
    observer.observe(log)
    for (const entry of log.children) observer.observe(entry)
    return () => observer.disconnect()
  }, [entries, streamingEntries, queuedChat, timelineEntries, hasOlder, loadingOlder, updateScroll])

  const scrollToLatest = () => {
    const log = logRef.current
    if (!log) return
    followsLatestRef.current = true
    setIsAtBottom(true)
    log.scrollTop = log.scrollHeight
    view.remember({ scrollTop: log.scrollTop, followsLatest: true })
  }

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    const users = logRef.current?.querySelectorAll<HTMLElement>('.chat-entry.user')
    anchorNextUserRef.current = users?.item(users.length - 1) ?? null
    if (!onSend(trimmed)) {
      anchorNextUserRef.current = undefined
      return
    }
    view.remember({ anchorLatestTurn: true })
    setText('')
  }

  return (
    <div className="chat-dock" aria-label="Chat conversation">
      {!gatewayOnline && (
        <span className="chat-status recipe-status" data-tone="muted" role="status">
          Offline
        </span>
      )}
      <div className="chat-log-frame">
        <div
          ref={logRef}
          className="chat-log"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-relevant="additions text"
          onScroll={() => updateScroll(false)}
        >
          {hasOlder && (
            <Button
              className="recipe-control"
              type="button"
              disabled={loadingOlder}
              onClick={() => {
                const first = logRef.current?.querySelector<HTMLElement>('[data-chat-entry-id]')
                if (first?.dataset.chatEntryId) {
                  olderPageAnchor.current = {
                    id: first.dataset.chatEntryId,
                    top: first.getBoundingClientRect().top,
                  }
                }
                onLoadOlder()
              }}
            >
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </Button>
          )}
          {entries.map((entry, index) => {
            const timelineEntry = timelineEntries[index]
            const retried =
              timelineEntry?.kind === 'user' &&
              (timelineEntries.some((candidate) => candidate.retryOf === timelineEntry.turnId) ||
                queuedChat.some((candidate) => candidate.retryOf === timelineEntry.turnId))
            const visibleDecisions = (entry.pendingDecisions ?? []).filter(
              (decision) => decision.state !== 'pending' || !dismissedDecisionIds.has(decision.id),
            )
            return (
              <Card
                key={timelineEntry?.id ?? `${entry.role}-${index}`}
                className={`chat-entry ${entry.role}`}
                data-chat-entry-id={timelineEntry?.id}
                data-decision-feedback-id={entry.decisionFeedbackId}
                data-chat-state={timelineEntry?.kind === 'error' ? 'error' : undefined}
              >
                <strong>{entry.role === 'user' ? 'you' : 'veduta'}</strong>
                {entry.role === 'assistant' ? (
                  <div className="chat-message">{structuredMarkdown(entry.text)}</div>
                ) : (
                  <span className="chat-message">{entry.text}</span>
                )}
                {timelineEntry?.kind === 'user' && timelineEntry.turnState === 'interrupted' && (
                  <div>
                    <span className="recipe-status" data-tone="warning">
                      Interrupted. Completion is unknown.
                    </span>
                    <Button
                      className="recipe-control"
                      type="button"
                      disabled={Boolean(retried)}
                      onClick={() => onRetryInterrupted(timelineEntry.turnId)}
                    >
                      {retried ? 'Retry requested' : 'Retry'}
                    </Button>
                  </div>
                )}
                {timelineEntry?.kind === 'user' &&
                  (timelineEntry.turnState === 'accepted' ||
                    (timelineEntry.turnState === 'running' &&
                      !streamingEntries.some((turn) => turn.turnId === timelineEntry.turnId)) ||
                    timelineEntry.turnState === 'waiting_connection') && (
                    <small className="recipe-status" data-tone="pending">
                      {timelineEntry.turnState === 'accepted'
                        ? 'Queued'
                        : timelineEntry.turnState === 'waiting_connection'
                          ? 'Waiting for service connection'
                          : 'Running'}
                    </small>
                  )}
                {timelineEntry?.connectionAttemptId && (
                  <Link
                    to={`${clientPath.serviceConnections}?attempt=${encodeURIComponent(timelineEntry.connectionAttemptId)}`}
                    onClick={onOpenResult}
                  >
                    Review service connection
                  </Link>
                )}
                {entry.targets && entry.targets.length > 0 && (
                  <nav className="chat-result-links" aria-label="Results">
                    {entry.targets.map((target) => {
                      const label = `Open ${target.spaceName}${
                        target.surfaceTitle === undefined ? '' : ` · ${target.surfaceTitle}`
                      }`
                      const href =
                        target.surfaceId === undefined
                          ? clientPath.space(target.spaceSlug)
                          : clientPath.surface(target.spaceSlug, target.surfaceId)
                      return (
                        <Link
                          key={`${target.spaceId}:${target.surfaceId ?? ''}`}
                          to={href}
                          onClick={onOpenResult}
                        >
                          {label}
                        </Link>
                      )
                    })}
                  </nav>
                )}
                {visibleDecisions.length > 0 && (
                  <section className="chat-pending-decisions" aria-label="Pending decisions">
                    {visibleDecisions.map((decision) => {
                      const reviewPath = pendingDecisionReviewPaths.get(decision.id)
                      const status = pendingDecisionStatus(decision)
                      return (
                        <article key={decision.id} className="chat-pending-decision">
                          <span>{decision.summary}</span>
                          {decision.state === 'pending' ? (
                            <PendingDecisionControls
                              decision={decision}
                              {...(reviewPath === undefined ? {} : { reviewPath })}
                              resolving={resolvingDecisionIds.has(decision.id)}
                              onResolve={onResolvePendingDecision}
                              onDismiss={onDismissPendingDecision}
                              {...(onOpenResult === undefined ? {} : { onReview: onOpenResult })}
                            />
                          ) : (
                            <span
                              className="chat-pending-decision-outcome recipe-status"
                              data-tone={status.tone}
                            >
                              {status.label}
                            </span>
                          )}
                        </article>
                      )
                    })}
                  </section>
                )}
              </Card>
            )
          })}
          {queuedChat.map((queued) => (
            <Card key={queued.id} className="chat-entry user" aria-label="Chat submission waiting">
              <strong>you</strong>
              <span className="chat-message">{queued.text}</span>
              <small
                className="recipe-status"
                data-tone={queued.status === 'rejected' ? 'danger' : 'pending'}
              >
                {queued.status === 'rejected' ? 'Not accepted' : 'Waiting for Gateway'}
              </small>
              {queued.status === 'rejected' && (
                <Button
                  className="recipe-control"
                  type="button"
                  onClick={() => onRetryQueued(queued.id)}
                >
                  Retry submission
                </Button>
              )}
            </Card>
          ))}
          {streamingEntries.map((turn) => (
            <Card key={`streaming-${turn.turnId}`} className="chat-entry assistant streaming">
              <strong>veduta</strong>
              <div className="chat-message">
                {structuredMarkdown(turn.text)}
                <span className="chat-streaming-cursor" data-testid="chat-streaming-cursor" />
              </div>
            </Card>
          ))}
          <div ref={spacerRef} aria-hidden="true" className="chat-reading-space" />
        </div>
        {!isAtBottom && (
          <Button
            type="button"
            className="chat-scroll-to-bottom recipe-control"
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
            onClick={scrollToLatest}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
            </svg>
          </Button>
        )}
      </div>
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <InputGroup>
          <InputGroupTextarea
            ref={inputRef}
            aria-label={focusedSpace ? `Message Veduta in ${focusedSpace.name}` : 'Message Veduta'}
            placeholder={focusedSpace ? `Message ${focusedSpace.name}` : 'Message Veduta'}
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                (event.metaKey || event.ctrlKey || !usesTouchComposer())
              ) {
                event.preventDefault()
                send()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="submit"
              variant="outline"
              size="icon-sm"
              aria-label="Send message"
              title="Send message"
              disabled={!text.trim()}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M12 19V5m0 0-6 6m6-6 6 6" />
              </svg>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}

function usesTouchComposer(): boolean {
  return (
    (window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
    (window.matchMedia?.('(max-width: 959px)').matches ?? false)
  )
}

function isChatLogAtBottom(log: HTMLElement): boolean {
  // scrollTop can be fractional even though scrollHeight and clientHeight are rounded.
  return log.scrollHeight - log.clientHeight - log.scrollTop < 1
}

/** Size the current scope before restoring a position that may depend on this space. */
function resizeReadingSpace(log: HTMLElement, spacer: HTMLElement | null, active: boolean) {
  const users = log.querySelectorAll<HTMLElement>('.chat-entry.user')
  const latestUser = users.item(users.length - 1)
  if (spacer) {
    const contentAfterUser = latestUser
      ? spacer.getBoundingClientRect().top - latestUser.getBoundingClientRect().top
      : 0
    spacer.style.height = `${active && latestUser ? Math.max(0, log.clientHeight - contentAfterUser - 48) : 0}px`
  }
  return latestUser
}
