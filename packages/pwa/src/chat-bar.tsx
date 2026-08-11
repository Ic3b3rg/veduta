import type { ApprovalCard, ChatMessage } from '@veduta/protocol'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SpaceWithSurfaces } from './api.ts'
import { ApprovalCards } from './approval-cards.tsx'

export function ChatBar({
  entries,
  streamingEntries,
  approvalCards,
  focusedSpace,
  focusToken,
  onDismissApprovalCards,
  onSend,
}: {
  entries: ChatMessage[]
  /** In-flight `chat.turn-*` turns, keyed by turnId (issue 037). Always
   * rendered after `entries` -- a turn only lands in `entries` once
   * `chat.turn-end`/`chat.turn-error` closes it. */
  streamingEntries: { turnId: string; text: string }[]
  approvalCards: ApprovalCard[]
  focusedSpace: SpaceWithSurfaces | undefined
  focusToken: number
  onDismissApprovalCards: (cards: ApprovalCard[]) => void
  onSend: (text: string) => boolean
}) {
  const [text, setText] = useState('')
  const [isAtBottom, setIsAtBottom] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const followsLatestRef = useRef(true)

  useEffect(() => {
    inputRef.current?.focus()
  }, [focusToken])

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
          {approvalCards.length > 0 && (
            <ApprovalCards cards={approvalCards} compact onDismiss={onDismissApprovalCards} />
          )}
          {entries.map((entry, index) => (
            <div key={`${entry.role}-${index}`} className={`chat-entry ${entry.role}`}>
              <strong>{entry.role === 'user' ? 'you' : 'veduta'}</strong>
              <span>{entry.text}</span>
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
