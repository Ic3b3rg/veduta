import { useModelConnectionsController } from './model-connection-controller.ts'
import { ModelConnectionPanel } from './model-connection-panel.tsx'

/**
 * The standalone Model connections settings view (issue #47, ADR-0014
 * amendment): the same `ModelConnectionPanel` the onboarding wizard's
 * `model-connection` step renders, reachable any time afterwards from the
 * topbar's `ChatModelSelects` "Model connections" button -- add another
 * connection, reconnect an expired one, or change the fallback set, none of
 * which the compact chat selects offer. Shares `useModelConnectionsController`
 * with the wizard step rather than duplicating the fetch+poll+action
 * plumbing.
 */
export function SettingsModelConnections({
  token,
  onBack,
}: {
  token?: string | undefined
  onBack: () => void
}) {
  const controller = useModelConnectionsController(token)

  return (
    <main className="model-connections-settings">
      <header className="model-connections-settings-header">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <h2>Model connections</h2>
      </header>

      {controller.snapshot && (
        <ModelConnectionPanel
          snapshot={controller.snapshot}
          busy={controller.busy}
          error={controller.error}
          onCreate={controller.onCreate}
          onAuthorize={controller.onAuthorize}
          onVerify={controller.onVerify}
          onApplySelection={controller.onApplySelection}
          onUpdate={controller.onUpdate}
          onRemove={controller.onRemove}
          onSetMock={controller.onSetMock}
          onRefreshCatalog={controller.onRefreshCatalog}
        />
      )}
    </main>
  )
}
