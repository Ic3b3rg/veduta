import { renderNode } from '@veduta/catalog'
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeStatusesSchema,
  surfaceRelativeTimeStatus,
  type AtomNode,
  type AutomationOutcomeStatus,
  type JsonValue,
  type Surface,
  type SurfaceRelativeTimeStatus,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { freshnessLabel } from './api.ts'
import type { SurfaceUpdateFeedback } from './surface-motion.ts'
import { useCatalogTheme } from './theme.ts'
import { usePwaRuntime } from './use-live-state.ts'

export function SurfaceCard({
  surface,
  selected,
  revealFeedbackKey,
  updateFeedback,
  canMoveUp,
  canMoveDown,
  onFocus,
  onMoveUp,
  onMoveDown,
  onTogglePin,
  onRevealFeedbackShown,
}: {
  surface: Surface
  selected: boolean
  revealFeedbackKey?: string | undefined
  updateFeedback?: SurfaceUpdateFeedback | undefined
  canMoveUp: boolean
  canMoveDown: boolean
  onFocus: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onTogglePin: (pinned: boolean) => void
  onRevealFeedbackShown: (feedbackKey: string) => void
}) {
  const theme = useCatalogTheme()
  const runtime = usePwaRuntime()
  const cardRef = useRef<HTMLElement>(null)
  const handledRevealFeedbackRef = useRef<string | undefined>(undefined)
  const revealedWhileSelectedRef = useRef(false)
  const [revealHighlighted, setRevealHighlighted] = useState(false)
  const relativeTime = useRelativeTimeStatus(surface)
  const automationOutcomes = AutomationOutcomeStatusesSchema.safeParse(
    surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
  )

  useEffect(() => {
    if (!selected) {
      revealedWhileSelectedRef.current = false
      return
    }
    if (revealFeedbackKey !== undefined || revealedWhileSelectedRef.current) return
    const card = cardRef.current
    if (!card) return

    scrollSurfaceCardIntoView(card)
  }, [revealFeedbackKey, selected])

  useEffect(() => {
    if (revealFeedbackKey === undefined || handledRevealFeedbackRef.current === revealFeedbackKey) {
      return
    }
    const card = cardRef.current
    if (!card) return

    handledRevealFeedbackRef.current = revealFeedbackKey
    if (selected) revealedWhileSelectedRef.current = true
    scrollSurfaceCardIntoView(card)
    setRevealHighlighted(true)
    onRevealFeedbackShown(revealFeedbackKey)
  }, [onRevealFeedbackShown, revealFeedbackKey, selected])

  useEffect(() => {
    if (!revealHighlighted) return
    const timeout = window.setTimeout(() => setRevealHighlighted(false), 2_000)
    return () => window.clearTimeout(timeout)
  }, [revealHighlighted])
  const dispatch = useCallback(
    (node: AtomNode, actionName: string, value?: JsonValue) => {
      if (!runtime) return Promise.reject(new Error('Surface actions are unavailable'))
      return runtime.dispatchSurfaceAction(surface.id, node.id, actionName, value)
    },
    [runtime, surface.id],
  )

  return (
    <article
      ref={cardRef}
      className={[
        'surface-card',
        surface.presentation === 'full' ? 'surface-presentation-full' : '',
        selected ? 'selected' : '',
        surface.pinned ? 'pinned' : '',
        revealHighlighted ? 'surface-reveal-highlight' : '',
        relativeTime?.status === 'expired' ? 'relative-time-expired' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-presentation={surface.presentation}
    >
      <div className="surface-toolbar">
        <button
          type="button"
          className="surface-focus"
          onClick={onFocus}
          aria-label={`Focus ${surface.title}`}
          aria-pressed={selected}
        >
          Focus
        </button>
        <div className="surface-order">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`Move ${surface.title} up`}
          >
            Up
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`Move ${surface.title} down`}
          >
            Down
          </button>
        </div>
        {surface.pinnable && (
          <button
            type="button"
            className="surface-pin"
            onClick={() => onTogglePin(!surface.pinned)}
            aria-pressed={surface.pinned}
            aria-label={`${surface.pinned ? 'Pinned' : 'Pin'} ${surface.title}`}
          >
            {surface.pinned ? 'Pinned' : 'Pin'}
          </button>
        )}
      </div>
      {relativeTime?.status === 'expired' && (
        <div className="relative-time-notice expired" role="status">
          This relative-time view expired. Values below are preserved but are not current.
        </div>
      )}
      {relativeTime?.caveat && (
        <div className="relative-time-notice caveat" role="note">
          {relativeTime.caveat}
        </div>
      )}
      {automationOutcomes.success &&
        Object.values(automationOutcomes.data)
          .sort((left, right) => left.automationId - right.automationId)
          .map((status) => (
            <AutomationOutcomeStatusPanel key={status.automationId} status={status} />
          ))}
      <div className="surface-content">
        {renderNode(surface.tree, {
          state: surface.state,
          dispatch,
          theme,
          ...(updateFeedback ? { motion: { update: updateFeedback } } : {}),
        })}
      </div>
      <div className="freshness">
        updated {freshnessLabel(surface.freshness.updatedAt)} by {surface.freshness.updatedBy}
      </div>
    </article>
  )
}

function AutomationOutcomeStatusPanel({ status }: { status: AutomationOutcomeStatus }) {
  return (
    <section
      className={`automation-outcome-status ${status.latest?.kind ?? 'fresh'}`}
      aria-label={`Automation ${status.automationId} status`}
    >
      {status.latest && (
        <div className="automation-outcome-status-latest">
          <strong>
            Automation #{status.automationId} · {automationOutcomeKindLabel(status.latest.kind)}
          </strong>
          <span>{status.latest.summary}</span>
        </div>
      )}
      <dl>
        <div>
          <dt>Last checked</dt>
          <dd>
            <time dateTime={status.lastCheckedAt}>
              {automationOutcomeTimeLabel(status.lastCheckedAt)}
            </time>
          </dd>
        </div>
        {status.lastSuccessfulAt && (
          <div>
            <dt>Last successful</dt>
            <dd>
              <time dateTime={status.lastSuccessfulAt}>
                {automationOutcomeTimeLabel(status.lastSuccessfulAt)}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {status.currentError && (
        <p className="automation-outcome-status-error">{status.currentError.message}</p>
      )}
    </section>
  )
}

function automationOutcomeKindLabel(
  kind: NonNullable<AutomationOutcomeStatus['latest']>['kind'],
): string {
  if (kind === 'decision-required') return 'Decision required'
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`
}

function automationOutcomeTimeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}

function scrollSurfaceCardIntoView(card: HTMLElement): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
}

const MAX_TIMEOUT_MS = 2_147_483_647

/** Re-evaluates a cached Surface at its next validity boundary, even if no Gateway event arrives. */
function useRelativeTimeStatus(surface: Surface): SurfaceRelativeTimeStatus | undefined {
  const startsAt = surface.validity?.startsAt
  const expiresAt = surface.validity?.expiresAt
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startsAt === undefined || expiresAt === undefined) return
    const startsAtMs = Date.parse(startsAt)
    const expiresAtMs = Date.parse(expiresAt)
    let timeout: number | undefined

    const refreshAtBoundary = () => {
      const current = Date.now()
      setNow(current)
      const nextBoundary =
        current < startsAtMs ? startsAtMs : current < expiresAtMs ? expiresAtMs : 0
      if (nextBoundary === 0) return
      timeout = window.setTimeout(
        refreshAtBoundary,
        Math.min(nextBoundary - current, MAX_TIMEOUT_MS),
      )
    }

    refreshAtBoundary()
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [expiresAt, startsAt])

  return surfaceRelativeTimeStatus(surface, new Date(now))
}
