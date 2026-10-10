// Throwaway #228: two compact Chat layouts on the existing Space route, both expanding on mobile.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { structuredMarkdown } from '@veduta/catalog'
import { Button } from '@veduta/catalog/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@veduta/catalog/ui/sheet'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Maximize2 } from 'lucide-react'
import './chat-reading-prototype.css'

export interface PrototypeModelSelection {
  connection: string
  model: string
}

const longReply = `Here is a calmer plan for your week. The aim is to make the next useful step visible without filling every available hour.

## Start with the essentials

Keep **three priorities**: finish the installation guide, try the phone experience, and review the changes you want to publish. Put everything else in a later list so it stays available without competing for your attention.

### Monday and Tuesday

Read the installation instructions on a clean device. Follow one step at a time and record the first place where you hesitate. If a step needs an account setting, the guide should tell you why and take you directly to the right place.

- Open the private link on your computer.
- Link your phone from Devices.
- Reload on both devices to confirm that access is retained.

### Wednesday

Try the main tasks with one hand on your phone. Read a long reply, leave an unfinished draft, return to the Space, and open the conversation again. You should arrive where you stopped reading, with your draft intact.

## Review before applying

When I propose a change, you should be able to see **what will change** before accepting it. A short description is useful, but it does not replace the current and proposed values. The example below changes only the weekly review time.

You can leave the decision pending while you continue reading. Opening the review should preserve this reading position. Returning to the Space should also leave its content where you left it.

## Leave room for the unexpected

Keep Friday lighter. Review what worked, move unfinished tasks deliberately, and choose the next small improvement. A sustainable plan has room for interruptions; it does not need to account for every minute.

The proposed schedule is below. Nothing will be changed until you choose to accept it.`

export function ChatReadingPrototype({
  spaceName,
  expanded,
  onExpandedChange,
  modelSelection,
  onModelSelectionChange,
}: {
  spaceName: string
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  modelSelection: PrototypeModelSelection
  onModelSelectionChange: (selection: PrototypeModelSelection) => void
}) {
  const [params, setParams] = useSearchParams()
  const variant = params.get('variant') === 'B' ? 'B' : 'A'
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const [decision, setDecision] = useState<'pending' | 'accepted' | 'rejected'>('pending')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(false)
  const [readingOffset, setReadingOffset] = useState(0)
  const readingPosition = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)

  const switchVariant = () => {
    setParams(
      (previous) => {
        previous.set('variant', variant === 'A' ? 'B' : 'A')
        return previous
      },
      { replace: true },
    )
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('input,textarea,select,[contenteditable]'))
        return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      setParams(
        (previous) => {
          previous.set('variant', previous.get('variant') === 'B' ? 'A' : 'B')
          return previous
        },
        { replace: true },
      )
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setParams])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log && expanded) log.scrollTop = readingPosition.current
    if (expanded) backRef.current?.focus({ preventScroll: true })
  }, [expanded])

  const collapse = () => {
    if (logRef.current) readingPosition.current = logRef.current.scrollTop
    onExpandedChange(false)
    requestAnimationFrame(() => expandRef.current?.focus({ preventScroll: true }))
  }

  const scrollLatest = () => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }

  const send = () => {
    if (!draft.trim()) return
    setMessages((previous) => [...previous, draft.trim()])
    setDraft('')
    requestAnimationFrame(scrollLatest)
  }

  return (
    <>
      <section className="chat-reading-prototype" aria-label={`Chat in ${spaceName}`}>
        <header className="prototype-chat-heading">
          {expanded ? (
            <Button ref={backRef} className="recipe-control" onClick={collapse}>
              <ArrowLeft aria-hidden="true" /> {spaceName}
            </Button>
          ) : (
            <strong>Chat · {spaceName}</strong>
          )}
          {expanded ? (
            <PrototypeModelPicker selection={modelSelection} onChange={onModelSelectionChange} />
          ) : (
            <Button
              ref={expandRef}
              className="recipe-control"
              onClick={() => onExpandedChange(true)}
            >
              <Maximize2 aria-hidden="true" /> {variant === 'A' ? 'Expand Chat' : 'Open Chat'}
            </Button>
          )}
        </header>
        <p className="prototype-chat-preview">Your weekly plan is ready. Read the full reply.</p>
        <div className="prototype-decision-access">
          <span>
            {decision === 'pending' ? '1 change needs your review' : `Schedule change ${decision}`}
          </span>
          <Button className="recipe-control" onClick={() => setReviewOpen(true)}>
            {decision === 'pending' ? 'Review change' : 'View change'}
          </Button>
        </div>
        <div
          className="prototype-conversation"
          role="log"
          aria-label="Prototype conversation"
          ref={logRef}
          onScroll={(event) => {
            const log = event.currentTarget
            if (expanded) {
              readingPosition.current = log.scrollTop
              setReadingOffset(Math.round(log.scrollTop))
            }
            setAtBottom(log.scrollHeight - log.clientHeight - log.scrollTop < 2)
          }}
        >
          <article className="prototype-message user">
            <strong>You</strong>
            <p>Help me plan the week, and move the weekly review to Friday afternoon.</p>
          </article>
          <article className="prototype-message">
            <strong>Veduta</strong>
            <div>{structuredMarkdown(longReply)}</div>
          </article>
          {messages.map((message, index) => (
            <article className="prototype-message user" key={index}>
              <strong>You</strong>
              <p>{message}</p>
              <small>Prototype draft submitted locally</small>
            </article>
          ))}
        </div>
        <div className="prototype-compose-area">
          {expanded && !atBottom && (
            <Button className="recipe-control prototype-latest" onClick={scrollLatest}>
              <ArrowDown aria-hidden="true" /> Latest message
            </Button>
          )}
          <form
            className="prototype-composer"
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <textarea
              className="recipe-input"
              rows={2}
              aria-label="Prototype message"
              placeholder={`Message ${spaceName}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              className="recipe-control"
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send prototype message"
              title="Send prototype message"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </form>
        </div>
      </section>

      <Sheet open={reviewOpen} onOpenChange={setReviewOpen}>
        <SheetContent className="recipe-overlay prototype-review" side="bottom">
          <SheetTitle>Move the weekly review</SheetTitle>
          <SheetDescription>Example decision · only this schedule would change.</SheetDescription>
          <div className="prototype-change-comparison">
            <div>
              <small>Current</small>
              <p>Sunday at 18:00</p>
            </div>
            <div>
              <small>Proposed</small>
              <p>Friday at 16:00</p>
            </div>
          </div>
          <p>Weekly review · {spaceName} · Europe/Rome</p>
          {decision === 'pending' ? (
            <div className="prototype-review-actions">
              <Button
                className="recipe-control"
                data-variant="primary"
                onClick={() => {
                  setDecision('accepted')
                  setReviewOpen(false)
                }}
              >
                Accept schedule change
              </Button>
              <Button
                className="recipe-control"
                onClick={() => {
                  setDecision('rejected')
                  setReviewOpen(false)
                }}
              >
                Keep current schedule
              </Button>
            </div>
          ) : (
            <p role="status">Change {decision}. This prototype has not changed your Space.</p>
          )}
        </SheetContent>
      </Sheet>

      <aside className="chat-prototype-switcher" aria-label="Prototype variants">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Previous prototype variant"
          title="Previous prototype variant"
          onClick={switchVariant}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div>
          <strong>
            {variant} · {variant === 'A' ? 'Preview + desktop rail' : 'Space first'}
          </strong>
          <small>
            Prototype · local only · {expanded ? 'expanded' : 'compact'} · draft {draft.length} ·
            reading {readingOffset}px · {decision}
          </small>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Next prototype variant"
          title="Next prototype variant"
          onClick={switchVariant}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </aside>
    </>
  )
}

export function PrototypeModelPicker({
  selection,
  onChange,
}: {
  selection: PrototypeModelSelection
  onChange: (selection: PrototypeModelSelection) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="recipe-control">Model · {selection.model}</Button>
      </SheetTrigger>
      <SheetContent className="recipe-overlay prototype-review" side="bottom">
        <SheetTitle>Choose a model</SheetTitle>
        <SheetDescription>
          Prototype choices. No connection or paid request is made.
        </SheetDescription>
        <label>
          Connection
          <select
            className="recipe-input"
            value={selection.connection}
            onChange={(event) => onChange({ ...selection, connection: event.target.value })}
          >
            <option>ChatGPT subscription</option>
            <option>API key</option>
          </select>
        </label>
        <label>
          Model
          <select
            className="recipe-input"
            value={selection.model}
            onChange={(event) => onChange({ ...selection, model: event.target.value })}
          >
            <option>Reasoning model</option>
            <option>Quick model</option>
          </select>
        </label>
        <Button className="recipe-control" onClick={() => setOpen(false)}>
          Done
        </Button>
      </SheetContent>
    </Sheet>
  )
}
