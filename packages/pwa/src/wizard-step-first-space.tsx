import type { FirstSpaceRequest, OnboardingStatus } from '@veduta/protocol'
import { useState } from 'react'
import { WIZARD_STEP_META } from './onboarding-state.ts'

/**
 * First-Space step (`tasks/plan.md` §3-4): name prefilled with the daemon's
 * suggested name; the daemon reconciles by slug, so an existing Space of
 * the same name is reused rather than duplicated (surfaced here so a resume
 * isn't surprising).
 */
export function WizardStepFirstSpace({
  status,
  busy,
  onApply,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onApply: (request: FirstSpaceRequest) => void
  error?: string | undefined
}) {
  const [name, setName] = useState(status.firstSpace.suggestedName)

  const canCreate = name.trim().length > 0

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META['first-space'].description}</p>

      <label htmlFor="first-space-name">Name</label>
      <input id="first-space-name" value={name} onChange={(e) => setName(e.target.value)} />

      {status.firstSpace.existingSpaces.length > 0 && (
        <div className="wizard-help">
          <p>A Space with the same name will be reused, not duplicated. Existing Spaces:</p>
          <ul>
            {status.firstSpace.existingSpaces.map((space) => (
              <li key={space.id}>{space.name}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        <button
          type="button"
          disabled={busy || !canCreate}
          onClick={() => onApply({ name: name.trim() })}
        >
          Create
        </button>
      </div>
    </div>
  )
}
