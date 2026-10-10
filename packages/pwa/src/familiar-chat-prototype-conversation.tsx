import { structuredMarkdown } from '@veduta/catalog'
import { Button } from '@veduta/catalog/ui/button'
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Copy, FileText, Square } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PrototypeMessage } from './familiar-chat-prototype-data.ts'

export function PrototypeConversation({
  messages,
  draft,
  onDraft,
  onSend,
  generating,
  onStop,
  readingPositionRef,
  decision,
  onReview,
  onSurface,
}: {
  messages: PrototypeMessage[]
  draft: string
  onDraft: (value: string) => void
  onSend: (text: string) => void
  generating: boolean
  onStop: () => void
  readingPositionRef: MutableRefObject<number>
  decision: 'none' | 'pending' | 'accepted' | 'declined'
  onReview: () => void
  onSurface: () => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const latestUser = messages.filter((message) => message.role === 'user').at(-1)?.id
  const previousUser = useRef(latestUser)
  const following = useRef(false)
  const [away, setAway] = useState(false)
  const [copied, setCopied] = useState<number | undefined>()
  const [copyError, setCopyError] = useState('')

  useLayoutEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = readingPositionRef.current
  }, [readingPositionRef])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (latestUser !== previousUser.current) {
      const message = node.querySelector<HTMLElement>(`[data-message-id="${latestUser}"]`)
      if (message)
        node.scrollTop +=
          message.getBoundingClientRect().top - node.getBoundingClientRect().top - 24
      previousUser.current = latestUser
      following.current = false
    } else if (following.current) {
      node.scrollTop = node.scrollHeight
    }
    setAway(node.scrollHeight - node.scrollTop - node.clientHeight > 64)
    readingPositionRef.current = node.scrollTop
  }, [messages, latestUser, readingPositionRef])

  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`
  }, [draft])

  return (
    <>
      {decision === 'pending' && (
        <button className="familiar-pending-access" onClick={onReview}>
          <span>
            <strong>1 change to review</strong>
            <small>Friday’s walk → Saturday morning</small>
          </span>
          <ArrowUpRight aria-hidden="true" />
        </button>
      )}
      <div className="familiar-reading-region">
        <div
          className="familiar-messages"
          data-has-new-turn={messages.length > 2}
          ref={scroller}
          role="region"
          aria-label="Conversation"
          tabIndex={0}
          onWheel={() => {
            following.current = false
          }}
          onTouchStart={() => {
            following.current = false
          }}
          onScroll={(event) => {
            const node = event.currentTarget
            readingPositionRef.current = node.scrollTop
            setAway(node.scrollHeight - node.scrollTop - node.clientHeight > 64)
          }}
        >
          <p className="familiar-date">Today</p>
          {messages.map((message) => (
            <article
              className={`familiar-message ${message.role}`}
              key={message.id}
              data-message-id={message.id}
            >
              <span className="familiar-author">
                {message.role === 'assistant' ? 'Veduta' : 'You'}
              </span>
              <div className="familiar-markdown">{structuredMarkdown(message.text)}</div>
              {message.id === 2 && (
                <>
                  <button className="familiar-surface-link" onClick={onSurface}>
                    <FileText aria-hidden="true" />
                    Weekly plan
                    <ArrowUpRight aria-hidden="true" />
                  </button>
                  {messages.length === 2 && (
                    <div className="familiar-suggestions">
                      <Button
                        className="recipe-control"
                        onClick={() => onSend('Talk me through the plan in detail.')}
                      >
                        <span>Explain the plan</span>
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                      <Button
                        className="recipe-control"
                        onClick={() => onSend('Move Friday’s walk to Saturday morning.')}
                      >
                        <span>Move Friday’s walk</span>
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </>
              )}
              {message.proposal && (
                <div className="familiar-proposal">
                  <div className="familiar-proposal-heading">
                    <FileText aria-hidden="true" />
                    <strong>Weekly plan</strong>
                  </div>
                  <p>Move one 40-minute walk</p>
                  <div className="familiar-inline-change">
                    <span>Friday · 18:30</span>
                    <ArrowDown aria-hidden="true" />
                    <strong>Saturday · 10:00</strong>
                  </div>
                  {!message.resolution && decision === 'pending' ? (
                    <Button className="recipe-control" data-variant="primary" onClick={onReview}>
                      Review change
                      <ArrowUpRight aria-hidden="true" />
                    </Button>
                  ) : (
                    <p className="familiar-outcome">
                      <Check aria-hidden="true" />
                      {message.resolution === 'accepted'
                        ? 'Accepted · Weekly plan updated'
                        : 'Declined · Weekly plan unchanged'}
                    </p>
                  )}
                </div>
              )}
              {message.role === 'assistant' &&
                message.text &&
                !(generating && message === messages.at(-1)) && (
                  <div className="familiar-message-actions">
                    <button
                      aria-label="Copy reply"
                      title="Copy reply"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(message.text)
                          .then(() => {
                            setCopied(message.id)
                            setCopyError('')
                            window.setTimeout(() => setCopied(undefined), 2000)
                          })
                          .catch(() =>
                            setCopyError('Could not copy. You can select the reply text instead.'),
                          )
                      }}
                    >
                      {copied === message.id ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                    </button>
                    {copied === message.id && <span role="status">Copied</span>}
                  </div>
                )}
            </article>
          ))}
          {generating && (
            <p className="familiar-thinking" role="status">
              <span />
              Veduta is writing…
            </p>
          )}
          {copyError && <p role="alert">{copyError}</p>}
        </div>
        {away && (
          <Button
            className="recipe-control familiar-latest"
            aria-label="Go to latest message"
            title="Go to latest message"
            onClick={() => {
              const node = scroller.current
              if (node) node.scrollTop = node.scrollHeight
              following.current = true
              setAway(false)
            }}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="familiar-compose-area">
        <form
          className="familiar-composer"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() && !generating) onSend(draft)
          }}
        >
          <textarea
            ref={input}
            aria-label="Message Veduta"
            placeholder="Ask about Health…"
            rows={1}
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                if (draft.trim() && !generating) onSend(draft)
              }
            }}
          />
          {generating ? (
            <button
              type="button"
              className="familiar-send"
              onClick={onStop}
              aria-label="Stop response"
              title="Stop response"
            >
              <span>
                <Square aria-hidden="true" />
              </span>
            </button>
          ) : (
            <button
              type="submit"
              className="familiar-send"
              aria-label="Send message"
              title="Send message"
              disabled={!draft.trim()}
            >
              <span>
                <ArrowUp aria-hidden="true" />
              </span>
            </button>
          )}
        </form>
        <p className="familiar-demo-note">Local demo · preset replies · nothing is saved</p>
      </div>
    </>
  )
}
