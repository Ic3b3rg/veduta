import { renderNode } from '@veduta/catalog'
import {
  surfaceRelativeTimeStatus,
  type AtomNode,
  type JsonValue,
  type Surface,
  type SurfaceRelativeTimeStatus,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fastActionIdempotencyKey,
  freshnessLabel,
  invokeFastAction,
  invokeSurfaceAction,
  optimisticFastSurface,
} from './api.ts'
import type { QueuedFastAction } from './pwa-storage.ts'
import { affectedAtomIdsForStateKey, type SurfaceUpdateFeedback } from './surface-motion.ts'
import { useCatalogTheme } from './theme.ts'

export function SurfaceCard({
  surface,
  token,
  selected,
  revealFeedbackKey,
  updateFeedback,
  canMoveUp,
  canMoveDown,
  onFocus,
  onMoveUp,
  onMoveDown,
  onPatched,
  onQueueFastAction,
  onTogglePin,
  onRevealFeedbackShown,
  onError,
}: {
  surface: Surface
  token?: string | undefined
  selected: boolean
  revealFeedbackKey?: string | undefined
  updateFeedback?: SurfaceUpdateFeedback | undefined
  canMoveUp: boolean
  canMoveDown: boolean
  onFocus: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onPatched: (surface: Surface, affectedAtomIds?: readonly string[], surfaceCursor?: number) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (pinned: boolean) => void
  onRevealFeedbackShown: (feedbackKey: string) => void
  onError: (message: string) => void
}) {
  const theme = useCatalogTheme()
  const cardRef = useRef<HTMLElement>(null)
  const [formActionKeyFor, clearFormActionScope] = useFormActionRetryKeys()
  const handledRevealFeedbackRef = useRef<string | undefined>(undefined)
  const revealedWhileSelectedRef = useRef(false)
  const [revealHighlighted, setRevealHighlighted] = useState(false)
  const relativeTime = useRelativeTimeStatus(surface)

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
      const action = node.actions?.find((a) => a.name === actionName)
      if (!action) {
        onError(`"${surface.title}" update failed: undeclared action "${actionName}"`)
        return
      }

      if (action.path === 'fast') {
        if (value === undefined) {
          const error = new Error(`fast action "${actionName}" did not provide a value`)
          onError(`"${surface.title}" update failed: ${error.message}`)
          return action.stateKeys === undefined ? undefined : Promise.reject(error)
        }
        const idempotencyKey = fastActionIdempotencyKey({
          surfaceId: surface.id,
          surfaceUpdatedAt: surface.freshness.updatedAt,
          nodeId: node.id,
          actionName,
          value,
        })

        if (action.stateKeys !== undefined) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            const error = new Error(`Form action "${actionName}" did not provide text fields`)
            onError(`"${surface.title}" update failed: ${error.message}`)
            return Promise.reject(error)
          }

          const formActionScope = JSON.stringify({ nodeId: node.id, actionName })
          const formActionFingerprint = `${formActionScope}:${JSON.stringify(value)}`
          const retryKey = formActionKeyFor(formActionFingerprint, idempotencyKey)

          return invokeFastAction(surface.id, node.id, actionName, value, token, retryKey)
            .then(({ surface: updated, surfaceCursor }) => {
              clearFormActionScope(formActionScope)
              onPatched(
                updated,
                affectedAtomIdsForStateKeys(updated.tree, action.stateKeys ?? []),
                surfaceCursor,
              )
            })
            .catch((error: Error) => {
              onError(`"${surface.title}" update failed: ${error.message}`)
              throw error
            })
        }

        const optimistic = optimisticFastSurface(surface, node, actionName, value)
        onPatched(
          optimistic,
          action.stateKey === undefined
            ? [node.id]
            : affectedAtomIdsForStateKey(optimistic.tree, action.stateKey),
        )
        invokeFastAction(surface.id, node.id, actionName, value, token, idempotencyKey)
          .then(({ surface: updated, surfaceCursor }) =>
            onPatched(updated, undefined, surfaceCursor),
          )
          .catch((e: Error) => {
            onQueueFastAction({
              id: idempotencyKey,
              surfaceId: surface.id,
              nodeId: node.id,
              actionName,
              value,
              idempotencyKey,
              at: new Date().toISOString(),
            })
            onError(`"${surface.title}" update queued: ${e.message}`)
          })
        return
      }

      const payload = value === undefined ? action.payload : { ...action.payload, value }
      invokeSurfaceAction(surface.id, node.id, actionName, payload, token).catch((e: Error) =>
        onError(`"${surface.title}" action failed: ${e.message}`),
      )
    },
    [clearFormActionScope, formActionKeyFor, onError, onPatched, onQueueFastAction, surface, token],
  )

  return (
    <article
      ref={cardRef}
      className={[
        'surface-card',
        selected ? 'selected' : '',
        surface.pinned ? 'pinned' : '',
        revealHighlighted ? 'surface-reveal-highlight' : '',
        relativeTime?.status === 'expired' ? 'relative-time-expired' : '',
      ]
        .filter(Boolean)
        .join(' ')}
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

function affectedAtomIdsForStateKeys(tree: AtomNode, stateKeys: readonly string[]): string[] {
  return Array.from(
    new Set(stateKeys.flatMap((stateKey) => affectedAtomIdsForStateKey(tree, stateKey))),
  )
}

function useFormActionRetryKeys(): readonly [
  (fingerprint: string, fallback: string) => string,
  (scope: string) => void,
] {
  const keysRef = useRef(new Map<string, string>())
  const keyFor = useCallback((fingerprint: string, fallback: string) => {
    const retryKey = keysRef.current.get(fingerprint) ?? fallback
    keysRef.current.set(fingerprint, retryKey)
    trimFormActionKeys(keysRef.current)
    return retryKey
  }, [])
  const clearScope = useCallback((scope: string) => {
    clearFormActionKeysForScope(keysRef.current, scope)
  }, [])
  return [keyFor, clearScope]
}

function trimFormActionKeys(keys: Map<string, string>): void {
  const oldest = keys.size > 32 ? keys.keys().next().value : undefined
  if (oldest !== undefined) keys.delete(oldest)
}

function clearFormActionKeysForScope(keys: Map<string, string>, scope: string): void {
  const prefix = `${scope}:`
  for (const fingerprint of keys.keys()) {
    if (fingerprint.startsWith(prefix)) keys.delete(fingerprint)
  }
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
