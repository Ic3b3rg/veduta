import { Button } from '@veduta/catalog/ui/button'
import { Checkbox } from '@veduta/catalog/ui/checkbox'
import { useEffect, useRef, useState } from 'react'
import {
  AddConnectionForm,
  ConnectionCard,
  MethodList,
  SelectionControls,
} from './model-connection-panel.tsx'
import { useModelConnectionsController } from './model-connection-controller.ts'
import {
  ConnectionDetail,
  ConnectionDetailBody,
  ConnectionDetailFooter,
  ConnectionListItem,
} from './connections-layout.tsx'

export function ConnectionsModels({ token }: { token?: string }) {
  const controller = useModelConnectionsController(token)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const beforeCreate = useRef<string[]>([])
  const opener = useRef<HTMLElement | null>(null)
  const snapshot = controller.snapshot
  const selected = snapshot?.connections.find((item) => item.id === selectedId)
  const open = (id: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSelectedId(id)
  }

  useEffect(() => {
    if (!creating) return
    const created = snapshot?.connections.find((item) => !beforeCreate.current.includes(item.id))
    if (created) {
      setSelectedId(created.id)
      setCreating(false)
    } else if (controller.error) setCreating(false)
  }, [snapshot, creating, controller.error])

  return (
    <>
      <header className="connections-heading">
        <div>
          <h1>Models</h1>
          <p>Accounts used for Chat and Agent work.</p>
        </div>
        <Button onClick={() => open('new')} disabled={!snapshot}>
          Add model
        </Button>
      </header>
      {controller.error && (
        <p role="alert" className="connections-alert">
          {controller.error}
        </p>
      )}
      {!snapshot && !controller.error && <p role="status">Loading Model connections…</p>}
      <div className="connections-workspace">
        <div className="connections-list">
          <div className="connections-grid">
            {snapshot?.connections.map((connection) => (
              <ConnectionListItem
                key={connection.id}
                title={connection.label}
                subtitle={
                  snapshot.methods.find((method) => method.id === connection.method)
                    ?.providerDisplayName ?? connection.method
                }
                state={connection.state}
                selected={selectedId === connection.id}
                returnFocusRef={opener}
                onClick={() => open(connection.id)}
              >
                {snapshot.selection?.connectionId === connection.id
                  ? 'Primary model'
                  : connection.enabledForFallback
                    ? 'Fallback enabled'
                    : 'Fallback disabled'}
              </ConnectionListItem>
            ))}
          </div>
          {snapshot?.connections.length === 0 && (
            <div className="connections-empty">
              <p>No Model connections yet.</p>
              <Button variant="outline" onClick={() => open('new')}>
                Connect a model provider
              </Button>
            </div>
          )}
          {snapshot && (
            <>
              <h2 className="connections-group-title">Default model</h2>
              <SelectionControls
                snapshot={snapshot}
                busy={controller.busy}
                onVerify={controller.onVerify}
                onApplySelection={controller.onApplySelection}
              />
            </>
          )}
          {snapshot?.mockControlAvailable && (
            <div className="connection-check">
              <Checkbox
                id="settings-mock-model"
                checked={snapshot.mockEnabled}
                disabled={controller.busy}
                onCheckedChange={(checked) => controller.onSetMock(checked === true)}
              />
              <label htmlFor="settings-mock-model">Use the built-in mock provider</label>
            </div>
          )}
        </div>
        {snapshot && (selectedId === 'new' || selected) && (
          <ConnectionDetail
            title={selected?.label ?? 'Add model'}
            description={
              selected
                ? 'Authorization, available models and fallback.'
                : 'Choose an available authorization method.'
            }
            opener={opener}
            onClose={() => setSelectedId(null)}
          >
            <ConnectionDetailBody>
              {controller.error && (
                <p role="alert" className="connections-alert">
                  {controller.error}
                </p>
              )}
              {selected ? (
                <ConnectionCard
                  key={selected.id}
                  connection={selected}
                  method={snapshot.methods.find((method) => method.id === selected.method)}
                  busy={controller.busy}
                  now={() => new Date()}
                  onAuthorize={controller.onAuthorize}
                  onUpdate={controller.onUpdate}
                  onRefreshCatalog={controller.onRefreshCatalog}
                  onRemove={(id) => {
                    if (
                      window.confirm('Remove this Model connection and its saved authorization?')
                    ) {
                      controller.onRemove(id)
                      setSelectedId(null)
                    }
                  }}
                />
              ) : (
                <>
                  <AddConnectionForm
                    methods={snapshot.methods}
                    busy={controller.busy}
                    onCreate={(body) => {
                      beforeCreate.current = snapshot.connections.map((item) => item.id)
                      setCreating(true)
                      controller.onCreate(body)
                    }}
                  />
                  <h3>Supported methods</h3>
                  <MethodList methods={snapshot.methods} />
                </>
              )}
            </ConnectionDetailBody>
            <ConnectionDetailFooter>
              <Button variant="outline" onClick={() => setSelectedId(null)}>
                Done
              </Button>
            </ConnectionDetailFooter>
          </ConnectionDetail>
        )}
      </div>
    </>
  )
}
