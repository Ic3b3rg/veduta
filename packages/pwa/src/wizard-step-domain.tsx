import type { OnboardingStatus } from '@veduta/protocol'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * Domain step: read-mostly — the domain and TLS state
 * were already detected/handled by the installer. On the VPS profile,
 * changing the domain later is a systemd drop-in edit, so the exact
 * commands are shown as help text (Hermes discipline: dead ends print the
 * exact next command). The Local VPS profile (issue 023,
 * `docs/adr/0009-local-vps-profile.md`) has no public domain, no systemd
 * unit, and no `journalctl` — it runs at `http://localhost`, and the
 * browser's own treatment of localhost as a secure context stands in for
 * the TLS/ACME certificate a real VPS install gets, so that copy branch
 * says so instead of printing dead-end VPS commands.
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
  const { profile } = status

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.domain.description}</p>
      <p>
        Domain: <strong>{domain ?? noPublicDomainLabel}</strong>{' '}
        <span className={status.domain.tlsActive ? 'status-pill online' : 'status-pill pending'}>
          {status.domain.tlsActive ? 'TLS active' : 'no TLS'}
        </span>
      </p>
      {profile === 'local-vps' ? (
        <details className="wizard-help">
          <summary>About the Local VPS profile</summary>
          <p>
            This daemon runs at <code>http://localhost</code>, supervised by the Local VPS runner
            script instead of systemd. There is no public domain and nothing to change here — the
            browser treats <code>localhost</code> as a secure context, standing in for the TLS/ACME
            certificate a real VPS install gets from Let&apos;s Encrypt.
          </p>
        </details>
      ) : (
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
      )}
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

/**
 * The no-domain fallback label. Only the loopback profile ever reaches this:
 * `index.ts`'s Local VPS boot branch always passes `domain: 'localhost'`
 * (issue 023), so `status.domain.domain` is never undefined for the
 * `local-vps` profile, and the `vps` profile requires
 * `VEDUTA_PUBLIC_DOMAIN` to boot at all.
 */
const noPublicDomainLabel = 'no public domain — loopback profile'
