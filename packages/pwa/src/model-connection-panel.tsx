import type {
  AuthorizeModelConnectionRequest,
  CreateModelConnectionRequest,
  ModelConnection,
  ModelConnectionMethod,
  ModelConnectionsSnapshot,
  UpdateModelConnectionRequest,
} from '@veduta/protocol'
import { useEffect, useRef, useState } from 'react'
import {
  catalogOptions,
  challengeCountdownLabel,
  connectionSelectLabel,
  lifecycleCopy,
} from './model-connection-view.ts'

export interface ModelConnectionPanelProps {
  snapshot: ModelConnectionsSnapshot
  busy: boolean
  error: string | null
  /** Injectable clock for the device-code countdown; defaults to `() => new Date()`. */
  now?: () => Date
  onCreate: (body: CreateModelConnectionRequest) => void
  onAuthorize: (id: string, body: AuthorizeModelConnectionRequest) => void
  onVerify: (id: string, modelId: string) => void
  /** Resolves `false` when the daemon rejected the selection (issue #47) so `SelectionControls` can roll its local draft state back to the committed selection. */
  onApplySelection: (connectionId: string, modelId: string) => Promise<boolean>
  onUpdate: (id: string, patch: UpdateModelConnectionRequest) => void
  onRemove: (id: string) => void
  onSetMock: (enabled: boolean) => void
  onRefreshCatalog: (id: string) => void
}

/**
 * The shared Model connection panel (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md`): every method the
 * registry offers, the connections already created, and the one visible
 * routing control -- which connection, and which of its models. A
 * CONTROLLED, presentation-only component: it never calls `fetch` itself,
 * it only reports intent through its `on*` props, so the same panel can be
 * embedded in the onboarding wizard's Model connection step
 * (`wizard-step-model-connection.tsx`) and the standalone settings view
 * (`settings-model-connections.tsx`) without either caller duplicating the
 * network plumbing (`model-connection-controller.ts`'s
 * `useModelConnectionsController`). The mock-provider checkbox is gated on
 * `snapshot.mockControlAvailable` rather than a `profile` prop -- the
 * daemon already ties that flag to the Local VPS profile
 * (`model-connection-registry.ts`), so the panel needs no profile of its
 * own to reproduce the same gate. Follows the wizard step
 * components' form classNames (`wizard-step-form`, `wizard-actions`,
 * `wizard-help-note`, `.error`) so it reads as one visual family with the
 * rest of onboarding.
 */
export function ModelConnectionPanel({
  snapshot,
  busy,
  error,
  now,
  onCreate,
  onAuthorize,
  onVerify,
  onApplySelection,
  onUpdate,
  onRemove,
  onSetMock,
  onRefreshCatalog,
}: ModelConnectionPanelProps) {
  const clock = now ?? (() => new Date())

  return (
    <div className="model-connection-panel">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <MethodList methods={snapshot.methods} />
      <AddConnectionForm methods={snapshot.methods} busy={busy} onCreate={onCreate} />

      <div className="model-connection-list">
        {snapshot.connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            method={snapshot.methods.find((candidate) => candidate.id === connection.method)}
            busy={busy}
            now={clock}
            onAuthorize={onAuthorize}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRefreshCatalog={onRefreshCatalog}
          />
        ))}
      </div>

      <SelectionControls
        snapshot={snapshot}
        busy={busy}
        onVerify={onVerify}
        onApplySelection={onApplySelection}
      />

      {snapshot.mockControlAvailable && (
        <label className="model-connection-mock-toggle">
          <input
            type="checkbox"
            checked={snapshot.mockEnabled}
            disabled={busy}
            onChange={(e) => onSetMock(e.target.checked)}
          />
          {' Use the built-in mock provider (development only)'}
        </label>
      )}
    </div>
  )
}

/** Every method the registry knows about; an unavailable one is a disabled row with its exact reason and, when the daemon supplied one, a docs link -- never a login button, since there is nothing to authorize yet. */
function MethodList({ methods }: { methods: ModelConnectionMethod[] }) {
  return (
    <ul className="model-connection-method-list">
      {methods.map((method) => (
        <li
          key={method.id}
          className={
            method.available
              ? 'model-connection-method available'
              : 'model-connection-method unavailable'
          }
          aria-disabled={!method.available}
        >
          <span className="model-connection-method-name">
            {method.providerDisplayName} · {method.methodDisplayName}
          </span>
          {!method.available && (
            <p className="wizard-help-note">
              {method.unavailableReason}
              {method.docsUrl !== undefined && (
                <>
                  {' '}
                  <a href={method.docsUrl} target="_blank" rel="noreferrer">
                    Learn more
                  </a>
                </>
              )}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Create a new connection for an available method: a password input for an api-key method, or a single "Start authorization" button for a device-code one -- the parent creates the record and then drives the device-code flow itself (`onCreate` here, `onAuthorize` on the resulting card). */
function AddConnectionForm({
  methods,
  busy,
  onCreate,
}: {
  methods: ModelConnectionMethod[]
  busy: boolean
  onCreate: (body: CreateModelConnectionRequest) => void
}) {
  const availableMethods = methods.filter((method) => method.available)
  const [methodId, setMethodId] = useState<ModelConnectionMethod['id'] | ''>(
    availableMethods[0]?.id ?? '',
  )
  const [apiKey, setApiKey] = useState('')

  if (availableMethods.length === 0) return null

  const selectedMethod = availableMethods.find((method) => method.id === methodId)
  const isApiKey = selectedMethod?.capabilities.authorization === 'api-key'
  const trimmedKey = apiKey.trim()

  const submit = () => {
    if (methodId === '') return
    if (isApiKey) {
      if (trimmedKey === '') return
      onCreate({ method: methodId, apiKey: trimmedKey })
      setApiKey('')
    } else {
      onCreate({ method: methodId })
    }
  }

  return (
    <div className="wizard-step-form model-connection-add-form">
      <label htmlFor="model-connection-method">Method</label>
      <select
        id="model-connection-method"
        value={methodId}
        onChange={(e) => {
          setMethodId(e.target.value as ModelConnectionMethod['id'])
          setApiKey('')
        }}
      >
        {availableMethods.map((method) => (
          <option key={method.id} value={method.id}>
            {method.providerDisplayName} · {method.methodDisplayName}
          </option>
        ))}
      </select>

      {isApiKey && (
        <>
          <label htmlFor="model-connection-api-key">API key</label>
          <input
            id="model-connection-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </>
      )}

      <div className="wizard-actions">
        <button type="button" disabled={busy || (isApiKey && trimmedKey === '')} onClick={submit}>
          {isApiKey ? 'Add connection' : 'Start authorization'}
        </button>
      </div>
    </div>
  )
}

/** One stored connection: its editable label, lifecycle copy and action, fallback toggle, Remove, the text-only note for a `vedutaTools: false` method, and (while `waiting-for-user`) the device-code block. */
function ConnectionCard({
  connection,
  method,
  busy,
  now,
  onAuthorize,
  onUpdate,
  onRemove,
  onRefreshCatalog,
}: {
  connection: ModelConnection
  method: ModelConnectionMethod | undefined
  busy: boolean
  now: () => Date
  onAuthorize: (id: string, body: AuthorizeModelConnectionRequest) => void
  onUpdate: (id: string, patch: UpdateModelConnectionRequest) => void
  onRemove: (id: string) => void
  onRefreshCatalog: (id: string) => void
}) {
  const [reauthKey, setReauthKey] = useState('')
  const copy = lifecycleCopy(connection)
  const isApiKeyMethod = method?.capabilities.authorization === 'api-key'
  const challenge = connection.challenge

  const runAction = () => {
    if (isApiKeyMethod) {
      const trimmed = reauthKey.trim()
      if (trimmed === '') return
      onAuthorize(connection.id, { apiKey: trimmed })
      setReauthKey('')
    } else {
      onAuthorize(connection.id, {})
    }
  }

  return (
    <div className="model-connection-card">
      <input
        aria-label={`label for ${connection.label}`}
        value={connection.label}
        disabled={busy}
        onChange={(e) => onUpdate(connection.id, { label: e.target.value })}
      />

      <p className="model-connection-lifecycle">
        <strong>{copy.title}</strong>
        {' — '}
        {copy.detail}
      </p>

      {copy.action !== 'none' && (
        <div className="wizard-actions">
          {isApiKeyMethod && (
            <input
              aria-label={`replacement key for ${connection.label}`}
              type="password"
              autoComplete="off"
              value={reauthKey}
              onChange={(e) => setReauthKey(e.target.value)}
            />
          )}
          <button
            type="button"
            disabled={busy || (isApiKeyMethod && reauthKey.trim() === '')}
            onClick={runAction}
          >
            {connectionActionLabel(copy.action)}
          </button>
        </div>
      )}

      {connection.state === 'connected' && (
        <div className="wizard-actions">
          <button type="button" disabled={busy} onClick={() => onRefreshCatalog(connection.id)}>
            Refresh models
          </button>
        </div>
      )}

      <label>
        <input
          type="checkbox"
          checked={connection.enabledForFallback}
          disabled={busy}
          onChange={(e) => onUpdate(connection.id, { enabledForFallback: e.target.checked })}
        />
        {' Allow as fallback'}
      </label>

      {method?.capabilities.vedutaTools === false && (
        <p className="wizard-help-note">
          Answers in text only — Veduta tools such as memory search are not available through this
          connection.
        </p>
      )}

      {challenge !== undefined && (
        <div className="model-connection-device-code">
          <a href={challenge.verificationUrl} target="_blank" rel="noreferrer">
            {challenge.verificationUrl}
          </a>
          <code>{challenge.userCode}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(challenge.userCode)}
          >
            Copy
          </button>
          <p>Waiting for you to finish signing in…</p>
          <p>{challengeCountdownLabel(challenge, now())}</p>
        </div>
      )}

      <div className="wizard-actions">
        <button type="button" disabled={busy} onClick={() => onRemove(connection.id)}>
          Remove
        </button>
      </div>
    </div>
  )
}

function connectionActionLabel(action: 'authorize' | 'reconnect' | 'retry'): string {
  if (action === 'authorize') return 'Authorize'
  if (action === 'reconnect') return 'Reconnect'
  return 'Retry'
}

/** The one visible routing control: which connection, and which model from that connection's own catalog -- `catalogOptions` is only ever computed for the currently selected connection, so switching the Connection select always narrows the Model select to that connection's own models. */
function SelectionControls({
  snapshot,
  busy,
  onVerify,
  onApplySelection,
}: {
  snapshot: ModelConnectionsSnapshot
  busy: boolean
  onVerify: (id: string, modelId: string) => void
  onApplySelection: (connectionId: string, modelId: string) => Promise<boolean>
}) {
  const connectedConnections = snapshot.connections.filter(
    (connection) => connection.state === 'connected',
  )
  const [draftConnectionId, setDraftConnectionId] = useState(
    snapshot.selection?.connectionId ?? connectedConnections[0]?.id ?? '',
  )
  const [modelId, setModelId] = useState(snapshot.selection?.modelId ?? '')

  // A rejected apply's rollback (below) must read the CURRENT committed
  // selection, not the one that was current when the click that triggered
  // it happened (issue #47): the `onClick` closure below captures `snapshot`
  // as of THAT render, and a plain re-render never rewrites an
  // already-created closure. `latestSnapshot.current` is kept in sync with
  // every render's `snapshot` prop by this effect instead, so the callback —
  // which only dereferences it once `onApplySelection`'s promise actually
  // settles, after the controller has refetched — reads whatever render most
  // recently committed, not the one at click time. An effect (not a
  // during-render assignment) because refs must not be written while
  // rendering.
  const latestSnapshot = useRef(snapshot)
  useEffect(() => {
    latestSnapshot.current = snapshot
  }, [snapshot])

  // A device-code connection can become connected while this component
  // stays mounted. React preserves the empty draft initialized during the
  // waiting state, so fall back to the committed connection or the first
  // newly connected one whenever that draft names no connected record.
  const selectedConnection =
    connectedConnections.find((connection) => connection.id === draftConnectionId) ??
    connectedConnections.find((connection) => connection.id === snapshot.selection?.connectionId) ??
    connectedConnections[0]
  const connectionId = selectedConnection?.id ?? ''
  const modelOptions = selectedConnection ? catalogOptions(selectedConnection) : []
  const canAct = connectionId !== '' && modelId !== ''

  return (
    <div className="wizard-step-form model-connection-selection">
      <label htmlFor="model-connection-select">Connection</label>
      <select
        id="model-connection-select"
        value={connectionId}
        onChange={(e) => {
          setDraftConnectionId(e.target.value)
          setModelId('')
        }}
      >
        {connectedConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connectionSelectLabel(connection, snapshot.connections, snapshot.methods)}
          </option>
        ))}
      </select>

      <label htmlFor="model-select">Model</label>
      <select id="model-select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
        <option value="" disabled>
          Choose a model
        </option>
        {modelOptions.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.note !== undefined ? `${option.label} (${option.note})` : option.label}
          </option>
        ))}
      </select>

      <div className="wizard-actions">
        <button
          type="button"
          disabled={busy || !canAct}
          onClick={() => onVerify(connectionId, modelId)}
        >
          Test model
        </button>
        <button
          type="button"
          disabled={busy || !canAct}
          onClick={() => {
            // A rejection (verify-then-commit: nothing was applied
            // server-side) must snap both drafts back to the selection that
            // is actually committed, not just leave the error banner over
            // stale selects (issue #47). Reads `latestSnapshot.current`,
            // not `snapshot` directly — see that ref's own comment above.
            void onApplySelection(connectionId, modelId).then((committed) => {
              if (committed) return
              setDraftConnectionId(latestSnapshot.current.selection?.connectionId ?? '')
              setModelId(latestSnapshot.current.selection?.modelId ?? '')
            })
          }}
        >
          Use this model
        </button>
      </div>
    </div>
  )
}
