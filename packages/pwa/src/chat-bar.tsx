import type { ChatMessage, ChatTimelineEntry, PendingDecisionResolution } from '@veduta/protocol'
import { structuredMarkdown } from '@veduta/catalog'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@veduta/catalog/ui/card'
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

export function ChatBar({
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
}: {
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
}) {
  const [text, setText] = useState('')
  const [isAtBottom, setIsAtBottom] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLElement>(null)
  const followsLatestRef = useRef(true)
  const logGeometryRef = useRef({ scrollHeight: 0, clientHeight: 0, clientWidth: 0, scrollTop: 0 })

  const updateScroll = useCallback((preserveFollowing: boolean) => {
    const log = logRef.current
    if (!log) return
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
    followsLatestRef.current = atBottom
    setIsAtBottom(atBottom)
  }, [])

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

  useEffect(() => {
    const dock = dockRef.current
    const shell = dock?.closest<HTMLElement>('.app-shell')
    if (!dock || !shell || typeof ResizeObserver === 'undefined') return

    const updateSpacing = () => {
      shell.style.setProperty(
        '--chat-dock-height',
        `${Math.ceil(dock.getBoundingClientRect().height)}px`,
      )
    }
    const observer = new ResizeObserver(updateSpacing)
    observer.observe(dock)
    updateSpacing()

    return () => {
      observer.disconnect()
      shell.style.removeProperty('--chat-dock-height')
    }
  }, [])

  const scrollToLatest = () => {
    const log = logRef.current
    if (!log) return
    followsLatestRef.current = true
    setIsAtBottom(true)
    log.scrollTop = log.scrollHeight
  }

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || !onSend(trimmed)) return
    setText('')
  }

  return (
    <footer ref={dockRef} className="chat-dock" aria-label="Global chat">
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
            <button type="button" disabled={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
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
              >
                <strong>{entry.role === 'user' ? 'you' : 'veduta'}</strong>
                {entry.role === 'assistant' ? (
                  <div className="chat-message">{structuredMarkdown(entry.text)}</div>
                ) : (
                  <span className="chat-message">{entry.text}</span>
                )}
                {timelineEntry?.kind === 'user' && timelineEntry.turnState === 'interrupted' && (
                  <div>
                    <span>Interrupted. Completion is unknown.</span>
                    <button
                      type="button"
                      disabled={Boolean(retried)}
                      onClick={() => onRetryInterrupted(timelineEntry.turnId)}
                    >
                      {retried ? 'Retry requested' : 'Retry'}
                    </button>
                  </div>
                )}
                {timelineEntry?.kind === 'user' &&
                  (timelineEntry.turnState === 'accepted' ||
                    (timelineEntry.turnState === 'running' &&
                      !streamingEntries.some((turn) => turn.turnId === timelineEntry.turnId)) ||
                    timelineEntry.turnState === 'waiting_connection') && (
                    <small>
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
                        <Link key={`${target.spaceId}:${target.surfaceId ?? ''}`} to={href}>
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
                            />
                          ) : (
                            <span className="chat-pending-decision-outcome">
                              {decision.state === 'resolving'
                                ? 'Resolving…'
                                : sentenceCase(decision.outcome ?? 'resolved')}
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
              <small>{queued.status === 'rejected' ? 'Not accepted' : 'Waiting for Gateway'}</small>
              {queued.status === 'rejected' && (
                <button type="button" onClick={() => onRetryQueued(queued.id)}>
                  Retry submission
                </button>
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
        </div>
        {!isAtBottom && (
          <button
            type="button"
            className="chat-scroll-to-bottom"
            aria-label="Scroll to latest message"
            onClick={scrollToLatest}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
            </svg>
          </button>
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
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !usesTouchComposer()
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
              disabled={!text.trim()}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M12 19V5m0 0-6 6m6-6 6 6" />
              </svg>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </footer>
  )
}

function usesTouchComposer(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false
}

function isChatLogAtBottom(log: HTMLElement): boolean {
  // scrollTop can be fractional even though scrollHeight and clientHeight are rounded.
  return log.scrollHeight - log.clientHeight - log.scrollTop < 1
}

function sentenceCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('-', ' ')}`
}
