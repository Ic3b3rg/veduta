import type { OnboardingStatus } from '@veduta/protocol'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/** Confirm the installed browser access; changes use the transactional setup command. */
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
  const { profile } = status

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.domain.description}</p>
      <p>
        Address: <strong>{status.domain.origin ?? domain ?? 'this computer'}</strong>{' '}
        <span className="status-pill online">
          {status.domain.accessMode === 'tailnet'
            ? 'Private · Tailscale'
            : status.domain.accessMode === 'tunnel'
              ? 'Private · SSH'
              : status.domain.tlsActive
                ? 'HTTPS active'
                : 'Local access'}
        </span>
      </p>
      {status.domain.accessMode === 'tailnet' && (
        <p>
          Open this same address on your computer and phone with Tailscale connected to your private
          network. Approve each device in Tailscale first, then sign in with your Veduta passkey.
        </p>
      )}
      {status.domain.accessMode === 'tunnel' && (
        <p>
          Open Veduta on your computer while the SSH connection is running. No public domain is
          needed.
        </p>
      )}
      {profile === 'local-vps' ? (
        <p>
          The Local VPS profile runs on this computer. There is no server configuration to change
          here.
        </p>
      ) : profile === 'vps' ? (
        <details className="wizard-help">
          <summary>Change how you access Veduta</summary>
          <p>
            On your server, run <code>sudo veduta access</code>. A new address requires a new
            passkey. Setup restores the previous access if the change fails.
          </p>
        </details>
      ) : null}
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
