import type { OnboardingStatus } from '@veduta/protocol'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * Domain step: read-mostly — the domain and TLS state
 * were already detected/handled by the installer. Changing the domain later
 * is a systemd drop-in edit, not something this form can do, so the exact
 * commands are shown as help text (Hermes discipline: dead ends print the
 * exact next command).
 */
export function WizardStepDomain({
  status,
  busy,
  onConfirm,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onConfirm: () => void
  error?: string | undefined
}) {
  const { domain } = status.domain

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.domain.description}</p>
      <p>
        Domain: <strong>{domain ?? 'no public domain — loopback profile'}</strong>{' '}
        <span className={status.domain.tlsActive ? 'status-pill online' : 'status-pill pending'}>
          {status.domain.tlsActive ? 'TLS active' : 'no TLS'}
        </span>
      </p>
      <details className="wizard-help">
        <summary>Change the domain later</summary>
        <p>
          <code>sudo systemctl edit veduta</code>
        </p>
        <p>Override VEDUTA_PUBLIC_DOMAIN in the drop-in, then:</p>
        <p>
          <code>sudo systemctl restart veduta</code>
        </p>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="wizard-actions">
        <button type="button" disabled={busy} onClick={onConfirm}>
          Continue
        </button>
      </div>
    </div>
  )
}
