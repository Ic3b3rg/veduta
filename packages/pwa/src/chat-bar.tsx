import type { ChatMessage, ChatTimelineEntry, PendingDecisionResolution } from '@veduta/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (focusOnRouteChange) inputRef.current?.focus()
  }, [focusOnRouteChange, focusToken])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log && followsLatestRef.current) log.scrollTop = log.scrollHeight
  }, [entries, streamingEntries])

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
          onScroll={(event) => {
            const log = event.currentTarget
            const nextIsAtBottom = log.scrollHeight - log.scrollTop <= log.clientHeight
            followsLatestRef.current = nextIsAtBottom
            setIsAtBottom(nextIsAtBottom)
          }}
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
                <span>{entry.text}</span>
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
                    timelineEntry.turnState === 'running' ||
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
              <span>{queued.text}</span>
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
              <span>
                {turn.text}
                <span className="chat-streaming-cursor" data-testid="chat-streaming-cursor" />
              </span>
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
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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

function sentenceCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('-', ' ')}`
}
