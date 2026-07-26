import type { OnboardingStatus, OnboardingTierModel, OnboardingTiers } from '@veduta/protocol'
import { useState } from 'react'
import { defaultTierSelections, WIZARD_STEP_META } from './onboarding-state.ts'

type TierId = keyof OnboardingTiers

const TIER_LABELS: Record<TierId, string> = {
  triage: 'Triage (cheap, fast — quick classification)',
  reasoning: 'Reasoning (stronger — chat turns, heartbeat reasoning)',
}

const EMPTY_ROW: OnboardingTierModel = { provider: 'anthropic', modelId: '' }

/**
 * Models step (`tasks/plan.md` §4): edit the current default tier chains
 * in place. Rows can be added/removed since `providerKeys` may not cover
 * every provider a default chain assumes; the client-side guard keeps at
 * least one model per tier before Save is allowed (the daemon re-validates
 * against `RoutingConfigSchema.tiers` regardless).
 */
export function WizardStepModels({
  status,
  busy,
  onApply,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onApply: (tiers: OnboardingTiers) => void
  error?: string | undefined
}) {
  const [tiers, setTiers] = useState<OnboardingTiers>(() => defaultTierSelections(status))

  const canSave = tiers.triage.length > 0 && tiers.reasoning.length > 0

  const updateRow = (tier: TierId, index: number, patch: Partial<OnboardingTierModel>) => {
    setTiers((prev) => ({
      ...prev,
      [tier]: prev[tier].map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    }))
  }

  const addRow = (tier: TierId) => {
    setTiers((prev) => ({ ...prev, [tier]: [...prev[tier], { ...EMPTY_ROW }] }))
  }

  const removeRow = (tier: TierId, index: number) => {
    setTiers((prev) => ({
      ...prev,
      [tier]: prev[tier].filter((_, rowIndex) => rowIndex !== index),
    }))
  }

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.models.description}</p>

      {(Object.keys(TIER_LABELS) as TierId[]).map((tier) => (
        <fieldset key={tier} className="wizard-tier">
          <legend>{TIER_LABELS[tier]}</legend>
          {tiers[tier].map((row, index) => (
            <div className="wizard-tier-row" key={`${tier}-${index}`}>
              <select
                aria-label={`${tier} model ${index + 1} provider`}
                value={row.provider}
                onChange={(e) => updateRow(tier, index, { provider: e.target.value })}
              >
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="openrouter">openrouter</option>
              </select>
              <input
                aria-label={`${tier} model ${index + 1} model id`}
                value={row.modelId}
                onChange={(e) => updateRow(tier, index, { modelId: e.target.value })}
              />
              <button
                type="button"
                aria-label={`remove ${tier} model ${index + 1}`}
                disabled={busy}
                onClick={() => removeRow(tier, index)}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" disabled={busy} onClick={() => addRow(tier)}>
            + Add model
          </button>
        </fieldset>
      ))}

      {!canSave && <p className="wizard-help-note">Each tier needs at least one model.</p>}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        <button type="button" disabled={busy || !canSave} onClick={() => onApply(tiers)}>
          Save &amp; continue
        </button>
      </div>
    </div>
  )
}
