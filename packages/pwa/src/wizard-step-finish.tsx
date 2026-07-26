import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * Finish step (`tasks/plan.md` §4): on the VPS profile the daemon exits and
 * systemd restarts it with the new config — the wizard shell polls
 * `/api/auth/status` and shows a spinner while `restarting` is true. If the
 * daemon never comes back, `restartTimedOut` shows the exact command to
 * inspect why instead of silently stranding the user in Home. On
 * loopback/Local VPS there is no restart; `restartRequired` says the new
 * config takes effect on the next daemon start (`server.ts:499`,
 * `model-routing.ts:241` — routing is boot-time-immutable) instead of
 * pretending it already applied, and requires an explicit "Enter Home" tap
 * rather than navigating away underneath the user.
 */
export function WizardStepFinish({
  busy,
  submitted,
  restarting,
  restartRequired,
  restartTimedOut,
  onFinish,
  onEnterHome,
  onRetryRestart,
  error,
}: {
  busy: boolean
  submitted: boolean
  restarting: boolean
  restartRequired: boolean
  restartTimedOut: boolean
  onFinish: () => void
  onEnterHome: () => void
  onRetryRestart: () => void
  error?: string | undefined
}) {
  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.finish.description}</p>

      {submitted && restarting && !restartTimedOut && (
        <p className="wizard-status-note info" aria-live="polite">
          Applying configuration — the daemon is restarting…
        </p>
      )}

      {restartTimedOut && (
        <p className="error" role="alert">
          The daemon did not come back after restarting. Check its logs:{' '}
          <code>sudo journalctl -u veduta -n 50</code>
        </p>
      )}

      {submitted && restartRequired && !restarting && !restartTimedOut && (
        <p className="wizard-status-note notice">
          Setup complete. New model/integration configuration takes effect the next time the daemon
          starts.
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        {!submitted && (
          <button type="button" disabled={busy} onClick={onFinish}>
            Finish
          </button>
        )}
        {restartTimedOut && (
          <button type="button" disabled={busy} onClick={onRetryRestart}>
            Retry
          </button>
        )}
        {submitted && restartRequired && !restarting && !restartTimedOut && (
          <button type="button" onClick={onEnterHome}>
            Enter Home
          </button>
        )}
      </div>
    </div>
  )
}
