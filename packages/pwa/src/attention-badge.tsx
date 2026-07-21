// The Space attention count (issue #18, plan v2 decision 12): shared by the
// space rail (app.tsx) and the Space section heading (space-section.tsx) so
// the two never drift. Renders nothing while `count` is 0 — an unseen-count
// badge that could show "0" would contradict its own name.
export function AttentionBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="attention-badge" data-attention={count} aria-label={`${count} updates`}>
      {count}
    </span>
  )
}
