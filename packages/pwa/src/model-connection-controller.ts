import type {
  AuthorizeModelConnectionRequest,
  CreateModelConnectionRequest,
  ModelConnectionsSnapshot,
  UpdateModelConnectionRequest,
} from '@veduta/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  applyModelSelection,
  authorizeModelConnection,
  createModelConnection,
  deleteModelConnection,
  fetchModelConnection,
  fetchModelConnections,
  refreshModelConnectionCatalog,
  setMockProvider,
  updateModelConnection,
  verifyModelConnection,
} from './api.ts'

const POLL_INTERVAL_MS = 2000

/**
 * The fetch+poll+action orchestration `ModelConnectionPanel` needs (issue
 * #47): fetches the snapshot on mount, polls every `waiting-for-user`
 * connection through its per-item endpoint every 2s (the collection
 * endpoint is snapshot-only; the per-item read runs the adapter refresh),
 * and wraps every mutating call so the panel's `busy`/`error` props always
 * reflect the most recent action. Extracted out of
 * `wizard-step-model-connection.tsx` so the onboarding step and the
 * standalone Model connections settings view
 * (`settings-model-connections.tsx`) share one implementation instead of two
 * copies drifting apart.
 */
export interface ModelConnectionsController {
  snapshot: ModelConnectionsSnapshot | undefined
  busy: boolean
  error: string | null
  refresh: () => Promise<void>
  onCreate: (body: CreateModelConnectionRequest) => void
  onAuthorize: (id: string, body: AuthorizeModelConnectionRequest) => void
  onVerify: (id: string, modelId: string) => void
  /**
   * Resolves `true` once the selection actually committed, `false` when the
   * daemon rejected it: a rejected selection must roll the panel's local
   * draft state back to what is actually applied, not just show an error
   * banner over stale selects (issue #47).
   */
  onApplySelection: (connectionId: string, modelId: string) => Promise<boolean>
  onUpdate: (id: string, patch: UpdateModelConnectionRequest) => void
  onRemove: (id: string) => void
  onSetMock: (enabled: boolean) => void
  onRefreshCatalog: (id: string) => void
}

export function useModelConnectionsController(token?: string): ModelConnectionsController {
  const [snapshot, setSnapshot] = useState<ModelConnectionsSnapshot | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchModelConnections(token)
      setSnapshot(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load Model connections')
    }
  }, [token])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const waitingIds =
      snapshot?.connections
        .filter((connection) => connection.state === 'waiting-for-user')
        .map((connection) => connection.id) ?? []
    if (waitingIds.length === 0) return

    const poll = async () => {
      try {
        const refreshed = await Promise.all(waitingIds.map((id) => fetchModelConnection(id, token)))
        const byId = new Map(refreshed.map((connection) => [connection.id, connection]))
        setSnapshot((current) =>
          current === undefined
            ? current
            : {
                ...current,
                connections: current.connections.map(
                  (connection) => byId.get(connection.id) ?? connection,
                ),
              },
        )
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load Model connections')
      }
    }

    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [snapshot, token])

  // The result-returning variant `onApplySelection` needs (issue #47):
  // every other action stays fire-and-forget void, since only a rejected
  // selection change has local draft state (the panel's Connection/Model
  // selects) that must snap back to the committed value on failure.
  const runActionForResult = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await refresh()
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : 'request failed'
        // Refetch BEFORE resolving `false` (issue #47): the snapshot this
        // call started with may already be stale by the time the daemon
        // rejects it (e.g. another client committed a different selection
        // while this one's probe was running), so the caller's rollback
        // must read the CURRENT committed selection, not the one that was
        // current before this request began. `refresh()` may itself clear
        // or replace `error` on success/failure — this call's own message
        // is restored unconditionally afterward so the banner still
        // explains what was actually rejected.
        await refresh()
        setError(message)
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      await runActionForResult(fn)
    },
    [runActionForResult],
  )

  return {
    snapshot,
    busy,
    error,
    refresh,
    onCreate: (body) => void runAction(() => createModelConnection(body, token)),
    onAuthorize: (id, body) => void runAction(() => authorizeModelConnection(id, body, token)),
    onVerify: (id, modelId) =>
      void runAction(async () => {
        const result = await verifyModelConnection(id, modelId, token)
        if (result.result === 'failed') throw new Error(result.reason)
      }),
    onApplySelection: (connectionId, modelId) =>
      runActionForResult(() => applyModelSelection({ connectionId, modelId }, token)),
    onUpdate: (id, patch) => void runAction(() => updateModelConnection(id, patch, token)),
    onRemove: (id) => void runAction(() => deleteModelConnection(id, token)),
    onSetMock: (enabled) => void runAction(() => setMockProvider(enabled, token)),
    onRefreshCatalog: (id) => void runAction(() => refreshModelConnectionCatalog(id, token)),
  }
}
