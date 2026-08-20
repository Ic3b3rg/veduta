import { renderNode } from '@veduta/catalog'
import type { AtomNode, JsonValue, Surface } from '@veduta/protocol'
import { useEffect, useRef, useState } from 'react'
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
  creationFeedbackKey,
  updateFeedback,
  canMoveUp,
  canMoveDown,
  onFocus,
  onMoveUp,
  onMoveDown,
  onPatched,
  onQueueFastAction,
  onTogglePin,
  onCreationFeedbackShown,
  onError,
}: {
  surface: Surface
  token?: string | undefined
  selected: boolean
  creationFeedbackKey?: string | undefined
  updateFeedback?: SurfaceUpdateFeedback | undefined
  canMoveUp: boolean
  canMoveDown: boolean
  onFocus: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onPatched: (surface: Surface, affectedAtomIds?: readonly string[]) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onTogglePin: (pinned: boolean) => void
  onCreationFeedbackShown: (feedbackKey: string) => void
  onError: (message: string) => void
}) {
  const theme = useCatalogTheme()
  const cardRef = useRef<HTMLElement>(null)
  const handledCreationFeedbackRef = useRef<string | undefined>(undefined)
  const [creationHighlighted, setCreationHighlighted] = useState(false)

  useEffect(() => {
    if (
      creationFeedbackKey === undefined ||
      handledCreationFeedbackRef.current === creationFeedbackKey
    ) {
      return
    }
    const card = cardRef.current
    if (!card) return

    handledCreationFeedbackRef.current = creationFeedbackKey
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
    setCreationHighlighted(true)
    onCreationFeedbackShown(creationFeedbackKey)
  }, [creationFeedbackKey, onCreationFeedbackShown])

  useEffect(() => {
    if (!creationHighlighted) return
    const timeout = window.setTimeout(() => setCreationHighlighted(false), 2_000)
    return () => window.clearTimeout(timeout)
  }, [creationHighlighted])
  const dispatch = (node: AtomNode, actionName: string, value?: JsonValue) => {
    const action = node.actions?.find((a) => a.name === actionName)
    if (!action) {
      onError(`"${surface.title}" update failed: undeclared action "${actionName}"`)
      return
    }

    if (action.path === 'fast') {
      if (value === undefined) {
        onError(
          `"${surface.title}" update failed: fast action "${actionName}" did not provide a value`,
        )
        return
      }
      const idempotencyKey = fastActionIdempotencyKey({
        surfaceId: surface.id,
        surfaceUpdatedAt: surface.freshness.updatedAt,
        nodeId: node.id,
        actionName,
        value,
      })
      const optimistic = optimisticFastSurface(surface, node, actionName, value)
      onPatched(
        optimistic,
        action.stateKey === undefined
          ? [node.id]
          : affectedAtomIdsForStateKey(optimistic.tree, action.stateKey),
      )
      invokeFastAction(surface.id, node.id, actionName, value, token, idempotencyKey)
        .then(onPatched)
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
  }

  return (
    <article
      ref={cardRef}
      className={[
        'surface-card',
        selected ? 'selected' : '',
        creationHighlighted ? 'creation-highlight' : '',
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
      {renderNode(surface.tree, {
        state: surface.state,
        dispatch,
        theme,
        ...(updateFeedback ? { motion: { update: updateFeedback } } : {}),
      })}
      <div className="freshness">
        updated {freshnessLabel(surface.freshness.updatedAt)} by {surface.freshness.updatedBy}
      </div>
    </article>
  )
}
