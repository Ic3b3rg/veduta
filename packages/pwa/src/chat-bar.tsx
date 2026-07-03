import type { ApprovalCard, ChatMessage } from '@veduta/protocol'
import { useEffect, useRef, useState } from 'react'
import type { SpaceWithSurfaces } from './api.ts'
import { ApprovalCards } from './approval-cards.tsx'

export function ChatBar({
  entries,
  approvalCards,
  focusedSpace,
  focusToken,
  onDismissApprovalCards,
  onSend,
}: {
  entries: ChatMessage[]
  approvalCards: ApprovalCard[]
  focusedSpace: SpaceWithSurfaces | undefined
  focusToken: number
  onDismissApprovalCards: (cards: ApprovalCard[]) => void
  onSend: (text: string) => boolean
}) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [focusToken])

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || !onSend(trimmed)) return
    setText('')
  }

  return (
    <footer className="chat-dock" aria-label="Global chat">
      <div className="chat-log" aria-live="polite">
        {approvalCards.length > 0 && (
          <ApprovalCards cards={approvalCards} compact onDismiss={onDismissApprovalCards} />
        )}
        {entries.map((entry, index) => (
          <div key={`${entry.role}-${index}`} className={`chat-entry ${entry.role}`}>
            <strong>{entry.role === 'user' ? 'you' : 'veduta'}</strong>
            <span>{entry.text}</span>
          </div>
        ))}
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
