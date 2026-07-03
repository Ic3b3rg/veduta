import type { ApprovalCard } from '@veduta/protocol'

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
            <p>{card.body}</p>
          </div>
          <div className="approval-actions">
            <button type="button" disabled>
              {card.actionLabel}
            </button>
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
