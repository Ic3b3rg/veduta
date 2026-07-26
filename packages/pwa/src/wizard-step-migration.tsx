import type { MigrationChoiceRequest, OnboardingStatus } from '@veduta/protocol'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * Migration step (`tasks/plan.md` §3-4): only rendered when the installer's
 * legacy-detect stage found an OpenClaw/Hermes install. Honest deferral —
 * `migrate-later` records the choice for the (future, issue 020) importer,
 * it does not run anything itself. Copy comes from `WIZARD_STEP_META`.
 */
export function WizardStepMigration({
  status,
  busy,
  onChoice,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onChoice: (choice: MigrationChoiceRequest['choice']) => void
  error?: string | undefined
}) {
  const { legacy } = status
  const found = [legacy.openclaw ? 'OpenClaw' : null, legacy.hermes ? 'Hermes' : null].filter(
    (name): name is string => name !== null,
  )

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.migration.description}</p>
      <p>
        Detected: <strong>{found.length > 0 ? found.join(' and ') : 'an existing install'}</strong>
        {legacy.sourceHome && (
          <>
            {' '}
            at <code>{legacy.sourceHome}</code>
          </>
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="wizard-actions">
        <button type="button" disabled={busy} onClick={() => onChoice('migrate-later')}>
          Record migration choice / migrate later
        </button>
        <button type="button" disabled={busy} onClick={() => onChoice('manual')}>
          Configure manually
        </button>
      </div>
    </div>
  )
}
