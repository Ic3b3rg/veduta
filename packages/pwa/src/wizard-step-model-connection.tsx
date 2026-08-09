import type { ModelConnectionStepRequest, OnboardingStatus } from '@veduta/protocol'
import { canContinue } from './model-connection-view.ts'
import { useModelConnectionsController } from './model-connection-controller.ts'
import { ModelConnectionPanel } from './model-connection-panel.tsx'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * The `model-connection` onboarding step (issue #47, replacing the separate
 * `byok`/`models` steps): wraps the shared `ModelConnectionPanel` in wizard
 * chrome. Data fetching, polling and the connect/authorize/verify/select
 * actions are `useModelConnectionsController`'s job (shared with the
 * standalone settings view, `settings-model-connections.tsx`), independent
 * of the wizard shell's own `run()` (which only ever drives
 * `POST /api/onboarding/*`).
 *
 * There is deliberately NO Skip button anywhere on this step (issue #47:
 * "no free skip, only an honest built-in-mock statement on loopback"). Once
 * `canContinue` is satisfied the only actions are `Continue` (advances the
 * wizard step) and `Add another connection` (focuses the panel's own add
 * form -- every method still lives in the panel, this never duplicates it).
 */
export function WizardStepModelConnection({
  status,
  token,
  busy,
  error,
  onContinue,
}: {
  status: OnboardingStatus
  token?: string | undefined
  busy: boolean
  error?: string | undefined
  onContinue: (request: ModelConnectionStepRequest) => void
}) {
  const profile = status.profile
  const controller = useModelConnectionsController(token)
  const { snapshot } = controller

  const focusAddForm = () => {
    document.getElementById('model-connection-method')?.focus()
  }

  const handleContinue = () => {
    const useMock = profile === 'local-vps' && snapshot?.mockEnabled === true
    onContinue(useMock ? { useMock: true } : {})
  }

  const canProceed = snapshot !== undefined && canContinue(snapshot, profile)

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META['model-connection'].description}</p>

      {profile === 'loopback' && (
        <p className="wizard-help-note">
          This install uses the built-in mock provider; add a real Model connection any time from
          Model connections.
        </p>
      )}

      {snapshot && (
        <ModelConnectionPanel
          snapshot={snapshot}
          busy={busy || controller.busy}
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

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        <button
          type="button"
          disabled={busy || controller.busy || !canProceed}
          onClick={handleContinue}
        >
          Continue
        </button>
        <button type="button" className="wizard-secondary" onClick={focusAddForm}>
          Add another connection
        </button>
      </div>
    </div>
  )
}
