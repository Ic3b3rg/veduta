import type { ChatMessage, PendingDecisionResolution } from '@veduta/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SpaceWithSurfaces } from './api.ts'
import { clientPath } from './client-router.tsx'
import { PendingDecisionControls } from './pending-decision-notifications.tsx'

export function ChatBar({
  entries,
  streamingEntries,
  focusedSpace,
  focusToken,
  focusOnRouteChange,
  pendingDecisionReviewPaths,
  resolvingDecisionIds,
  onResolvePendingDecision,
  onSend,
}: {
  entries: ChatMessage[]
  /** In-flight `chat.turn-*` turns, keyed by turnId (issue 037). Always
   * rendered after `entries` -- a turn only lands in `entries` once
   * `chat.turn-end`/`chat.turn-error` closes it. */
  streamingEntries: { turnId: string; text: string }[]
  focusedSpace: SpaceWithSurfaces | undefined
  focusToken: string
  focusOnRouteChange: boolean
  pendingDecisionReviewPaths: ReadonlyMap<string, string>
  resolvingDecisionIds: ReadonlySet<string>
  onResolvePendingDecision: (
    decisionId: string,
    resolution: PendingDecisionResolution,
  ) => Promise<void> | void
  onSend: (text: string) => boolean
}) {
  const [text, setText] = useState('')
  const [isAtBottom, setIsAtBottom] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const followsLatestRef = useRef(true)

  useEffect(() => {
    if (focusOnRouteChange) inputRef.current?.focus()
  }, [focusOnRouteChange, focusToken])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log && followsLatestRef.current) log.scrollTop = log.scrollHeight
  }, [entries, streamingEntries])

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
    <footer className="chat-dock" aria-label="Global chat">
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
          {entries.map((entry, index) => (
            <div
              key={`${entry.role}-${index}`}
              className={`chat-entry ${entry.role}`}
              data-decision-feedback-id={entry.decisionFeedbackId}
            >
              <strong>{entry.role === 'user' ? 'you' : 'veduta'}</strong>
              <span>{entry.text}</span>
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
              {entry.decisionFeedbackId === undefined &&
                entry.pendingDecisions &&
                entry.pendingDecisions.length > 0 && (
                  <section className="chat-pending-decisions" aria-label="Pending decisions">
                    {entry.pendingDecisions.map((decision) => {
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
            </div>
          ))}
          {streamingEntries.map((turn) => (
            <div key={`streaming-${turn.turnId}`} className="chat-entry assistant streaming">
              <strong>veduta</strong>
              <span>
                {turn.text}
                <span className="chat-streaming-cursor" data-testid="chat-streaming-cursor" />
              </span>
            </div>
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
      <div className="chat-compose">
        <input
          ref={inputRef}
          aria-label={focusedSpace ? `Message Veduta in ${focusedSpace.name}` : 'Message Veduta'}
          placeholder={focusedSpace ? `Message ${focusedSpace.name}` : 'Message Veduta'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button type="button" onClick={send}>
          Send
        </button>
      </div>
    </footer>
  )
}

function sentenceCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('-', ' ')}`
}
