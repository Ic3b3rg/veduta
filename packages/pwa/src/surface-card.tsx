import { renderNode } from '@veduta/catalog'
import type { AtomNode, JsonValue, Surface } from '@veduta/protocol'
import {
  fastActionIdempotencyKey,
  freshnessLabel,
  invokeFastAction,
  invokeSurfaceAction,
  optimisticFastSurface,
} from './api.ts'
import type { QueuedFastAction } from './pwa-storage.ts'
import { useCatalogTheme } from './theme.ts'

export function SurfaceCard({
  surface,
  token,
  selected,
  canMoveUp,
  canMoveDown,
  onFocus,
  onMoveUp,
  onMoveDown,
  onPatched,
  onQueueFastAction,
  onError,
}: {
  surface: Surface
  token?: string | undefined
  selected: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onFocus: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onPatched: (s: Surface) => void
  onQueueFastAction: (action: QueuedFastAction) => void
  onError: (message: string) => void
}) {
  const theme = useCatalogTheme()
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
      onPatched(optimisticFastSurface(surface, node, actionName, value))
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
    <article className={selected ? 'surface-card selected' : 'surface-card'}>
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
      </div>
      {renderNode(surface.tree, { state: surface.state, dispatch, theme })}
      <div className="freshness">
        updated {freshnessLabel(surface.freshness.updatedAt)} by {surface.freshness.updatedBy}
      </div>
    </article>
  )
}
