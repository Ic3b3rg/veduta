import type { ApprovalCard } from '@veduta/protocol'
import { expiresInLabel } from './api.ts'

/** Clears any chip whose card Surface was archived (D9/D13): the decision
 * UI lives on that Surface, so once it's gone the notification is stale. */
export function dismissCardsForSurface(cards: ApprovalCard[], surfaceId: string): ApprovalCard[] {
  return cards.filter((card) => card.surfaceId !== surfaceId)
}

// The chip is a pure notification (D13): title, level, expiry, Dismiss.
// The decision (Approve/Reject) lives on the card Surface itself, rendered
// in Home — there is no Approve affordance here.
export function ApprovalCards({
  cards,
  compact = false,
  onDismiss,
}: {
  cards: ApprovalCard[]
  compact?: boolean
  onDismiss: (cards: ApprovalCard[]) => void
}) {
  return (
    <div className={compact ? 'approval-stack compact' : 'approval-stack'}>
      {cards.map((card) => (
        <article key={card.id} className="approval-card">
          <div>
            <span className="approval-level">{card.level}</span>
            <h3>{card.title}</h3>
            <p>{expiresInLabel(card.expiresAt)}</p>
          </div>
          <div className="approval-actions">
            <button
              type="button"
              onClick={() => onDismiss(cards.filter((candidate) => candidate.id !== card.id))}
            >
              Dismiss
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}
