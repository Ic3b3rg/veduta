import type { OnboardingStatus } from '@veduta/protocol'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * Finish step: on the VPS and Local VPS profiles (issue 023) the daemon
 * exits and its supervisor — systemd on the VPS, the Local VPS runner loop
 * otherwise — restarts it with the new config — the wizard shell polls
 * `/api/auth/status` and shows a spinner while `restarting` is true. If the
 * daemon never comes back, `restartTimedOut` shows the exact command to
 * inspect why instead of silently stranding the user in Home — branched by
 * `profile` (`restartTimedOutGuidance` below), since the Local VPS profile
 * has no systemd unit to check. On loopback there is no restart;
 * `restartRequired` says the new config takes effect on the next daemon
 * start (`server.ts:499`, `model-routing.ts:241` — routing is
 * boot-time-immutable) instead of pretending it already applied, and
 * requires an explicit "Enter Home" tap rather than navigating away
 * underneath the user.
 */
export function WizardStepFinish({
  profile,
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
  profile: OnboardingStatus['profile']
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
  const timedOutGuidance = restartTimedOutGuidance(profile)
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
          {timedOutGuidance.message} <code>{timedOutGuidance.command}</code>
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

/**
 * The restart-timed-out diagnostic, branched by profile (issue 023,
 * `docs/adr/0009-local-vps-profile.md`): the VPS profile's supervisor is a
 * systemd unit, so `journalctl` is the right dead-end command. The Local
 * VPS profile has no systemd unit — it runs under `pnpm local-vps`
 * (`deploy/local-vps.sh`), whose runner loop restarts the daemon itself once
 * it exits cleanly — pointing at `journalctl` there would send the user
 * chasing a service that does not exist.
 */
export function restartTimedOutGuidance(profile: OnboardingStatus['profile']): {
  message: string
  command: string
} {
  if (profile === 'local-vps') {
    return {
      message:
        'The daemon did not come back after restarting. Check the terminal running the Local VPS runner — it restarts the daemon automatically once it exits cleanly:',
      command: 'pnpm local-vps',
    }
  }
  return {
    message: 'The daemon did not come back after restarting. Check its logs:',
    command: 'sudo journalctl -u veduta -n 50',
  }
}
