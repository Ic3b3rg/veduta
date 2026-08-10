import type { ModelConnectionsSnapshot } from '@veduta/protocol'
import { useEffect, useState } from 'react'
import { applyModelSelection, fetchModelConnections } from './api.ts'
import { catalogOptions, connectionSelectLabel } from './model-connection-view.ts'

/**
 * The topbar's compact "which model am I talking to" control (issue #47,
 * ADR-0014 amendment): the same Connection + Model selects
 * `ModelConnectionPanel` renders, but SELF-CONTAINED (fetches its own
 * snapshot) and stripped down to exactly the one visible routing control --
 * no add/authorize/revoke, ever. Changing either select applies immediately
 * through the same verify-then-commit route the settings view and the
 * onboarding step use (`applyModelSelection`): nothing here bypasses the
 * probe. A rejection never leaves the selects showing a value that was
 * never actually applied -- this component never optimistically updates its
 * own state before the request resolves, so a failure simply leaves the
 * selects rendering the snapshot they already had.
 *
 * Renders nothing on a pure-mock install (no connections at all, e.g. a
 * fresh Loopback profile): there is nothing to pick between yet. Reaching
 * the settings view (to add a connection, or for anything beyond this one
 * routing control) is the topbar's own unconditional "Model connections"
 * button's job (`app.tsx`), not this component's -- that button must stay
 * reachable even when this component renders nothing.
 */
export function ChatModelSelects({ token }: { token?: string | undefined }) {
  const [snapshot, setSnapshot] = useState<ModelConnectionsSnapshot | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchModelConnections(token)
      .then((next) => {
        if (!cancelled) setSnapshot(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [token])

  if (snapshot === undefined || snapshot.connections.length === 0) return null

  const connectedConnections = snapshot.connections.filter(
    (connection) => connection.state === 'connected',
  )
  const connectionId = snapshot.selection?.connectionId ?? ''
  const modelId = snapshot.selection?.modelId ?? ''
  const selectedConnection = connectedConnections.find(
    (connection) => connection.id === connectionId,
  )
  const modelOptions = selectedConnection ? catalogOptions(selectedConnection) : []

  const applySelection = async (nextConnectionId: string, nextModelId: string) => {
    if (nextConnectionId === '' || nextModelId === '') return
    setBusy(true)
    setError(null)
    try {
      const next = await applyModelSelection(
        { connectionId: nextConnectionId, modelId: nextModelId },
        token,
      )
      setSnapshot(next)
    } catch (e) {
      // Nothing was committed (verify-then-commit) -- leaving `snapshot`
      // untouched is exactly "restore the previous selection": the selects
      // below are controlled by `snapshot.selection`, which never changed.
      setError(e instanceof Error ? e.message : 'failed to change the model')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat-model-selects">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <select
        aria-label="Connection"
        value={connectionId}
        disabled={busy}
        onChange={(e) => {
          const nextConnectionId = e.target.value
          const nextConnection = connectedConnections.find(
            (connection) => connection.id === nextConnectionId,
          )
          const firstModel = nextConnection ? catalogOptions(nextConnection)[0]?.value : undefined
          if (firstModel !== undefined) void applySelection(nextConnectionId, firstModel)
        }}
      >
        {connectionId === '' && <option value="">No connection selected</option>}
        {connectedConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connectionSelectLabel(connection, snapshot.connections, snapshot.methods)}
          </option>
        ))}
      </select>

      <select
        aria-label="Model"
        value={modelId}
        disabled={busy || selectedConnection === undefined}
        onChange={(e) => void applySelection(connectionId, e.target.value)}
      >
        {modelId === '' && <option value="">No model selected</option>}
        {modelOptions.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
