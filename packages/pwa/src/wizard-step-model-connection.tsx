import type {
  AuthorizeModelConnectionRequest,
  CreateModelConnectionRequest,
  ModelConnectionStepRequest,
  ModelConnectionsSnapshot,
  OnboardingStatus,
  UpdateModelConnectionRequest,
} from '@veduta/protocol'
import { useCallback, useEffect, useState } from 'react'
import {
  applyModelSelection,
  authorizeModelConnection,
  createModelConnection,
  deleteModelConnection,
  fetchModelConnections,
  refreshModelConnectionCatalog,
  setMockProvider,
  updateModelConnection,
  verifyModelConnection,
} from './api.ts'
import { canContinue } from './model-connection-view.ts'
import { ModelConnectionPanel } from './model-connection-panel.tsx'
import { WIZARD_STEP_META } from './onboarding-state.ts'

const POLL_INTERVAL_MS = 2000

/**
 * The `model-connection` onboarding step (issue #47, replacing the separate
 * `byok`/`models` steps): wraps the shared `ModelConnectionPanel` in wizard
 * chrome and OWNS its own data fetching -- every connect/authorize/verify/
 * select action goes straight to `/api/model-connections/*` through this
 * component, independent of the wizard shell's own `run()` (which only ever
 * drives `POST /api/onboarding/*`). Polls every 2s while any connection is
 * `waiting-for-user`, so a device-code login completed in another tab is
 * picked up without the user having to act here at all.
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
  const [snapshot, setSnapshot] = useState<ModelConnectionsSnapshot | undefined>(undefined)
  const [panelBusy, setPanelBusy] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchModelConnections(token)
      setSnapshot(next)
      setPanelError(null)
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : 'failed to load Model connections')
    }
  }, [token])

  useEffect(() => {
    const load = async () => {
      await refresh()
    }
    void load()
  }, [refresh])

  useEffect(() => {
    const waiting =
      snapshot?.connections.some((connection) => connection.state === 'waiting-for-user') ?? false
    if (!waiting) return
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [snapshot, refresh])

  const runAction = async (fn: () => Promise<unknown>) => {
    setPanelBusy(true)
    setPanelError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : 'request failed')
    } finally {
      setPanelBusy(false)
    }
  }

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
          profile={profile}
          busy={busy || panelBusy}
          error={panelError}
          onCreate={(body: CreateModelConnectionRequest) =>
            void runAction(() => createModelConnection(body, token))
          }
          onAuthorize={(id: string, body: AuthorizeModelConnectionRequest) =>
            void runAction(() => authorizeModelConnection(id, body, token))
          }
          onVerify={(id: string, modelId: string) =>
            void runAction(async () => {
              const result = await verifyModelConnection(id, modelId, token)
              if (result.result === 'failed') throw new Error(result.reason)
            })
          }
          onApplySelection={(connectionId: string, modelId: string) =>
            void runAction(() => applyModelSelection({ connectionId, modelId }, token))
          }
          onUpdate={(id: string, patch: UpdateModelConnectionRequest) =>
            void runAction(() => updateModelConnection(id, patch, token))
          }
          onRemove={(id: string) => void runAction(() => deleteModelConnection(id, token))}
          onSetMock={(enabled: boolean) => void runAction(() => setMockProvider(enabled, token))}
          onRefreshCatalog={(id: string) =>
            void runAction(() => refreshModelConnectionCatalog(id, token))
          }
        />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        <button type="button" disabled={busy || panelBusy || !canProceed} onClick={handleContinue}>
          Continue
        </button>
        <button type="button" className="wizard-secondary" onClick={focusAddForm}>
          Add another connection
        </button>
      </div>
    </div>
  )
}
