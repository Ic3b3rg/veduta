import type {
  ByokApplyRequest,
  ByokProvider,
  ByokTestResponse,
  OnboardingStatus,
} from '@veduta/protocol'
import { useState } from 'react'
import { byokKeepExistingAvailable, WIZARD_STEP_META } from './onboarding-state.ts'

type TestState = 'idle' | 'testing' | 'valid' | 'invalid' | 'unreachable'

/**
 * BYOK step: provider + key, "Test key" runs the
 * daemon's deterministic key check before Save is allowed, or the
 * keep-existing sentinel (empty key input when a key is already stored)
 * skips the test entirely. Changing either input invalidates a prior test
 * result — the test must match the exact provider+key currently entered.
 */
export function WizardStepByok({
  status,
  busy,
  onTest,
  onApply,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onTest: (provider: ByokProvider, key?: string) => Promise<ByokTestResponse>
  onApply: (request: ByokApplyRequest) => void
  error?: string | undefined
}) {
  const providers = status.byok.providers
  const [provider, setProvider] = useState<ByokProvider>(providers[0]?.provider ?? 'anthropic')
  const [key, setKey] = useState('')
  const [testState, setTestState] = useState<TestState>('idle')
  const [testedFor, setTestedFor] = useState<{ provider: ByokProvider; key: string } | null>(null)

  const trimmedKey = key.trim()
  const keepExisting = trimmedKey === '' && byokKeepExistingAvailable(status, provider)
  const testMatchesCurrent =
    testedFor !== null && testedFor.provider === provider && testedFor.key === trimmedKey
  const canSave = keepExisting || (testState === 'valid' && testMatchesCurrent)

  const resetTest = () => {
    setTestState('idle')
    setTestedFor(null)
  }

  const runTest = async () => {
    setTestState('testing')
    try {
      const response = await onTest(provider, trimmedKey === '' ? undefined : trimmedKey)
      setTestState(response.result)
      setTestedFor({ provider, key: trimmedKey })
    } catch {
      setTestState('unreachable')
      setTestedFor({ provider, key: trimmedKey })
    }
  }

  const save = () => {
    if (trimmedKey === '') onApply({ provider })
    else onApply({ provider, key: trimmedKey })
  }

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.byok.description}</p>

      <label htmlFor="byok-provider">Provider</label>
      <select
        id="byok-provider"
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value as ByokProvider)
          resetTest()
        }}
      >
        {providers.map((entry) => (
          <option key={entry.provider} value={entry.provider}>
            {entry.provider}
            {entry.hasKey ? ' (key stored)' : ''}
          </option>
        ))}
      </select>

      <label htmlFor="byok-key">API key</label>
      <input
        id="byok-key"
        type="password"
        autoComplete="off"
        placeholder={byokKeepExistingAvailable(status, provider) ? 'keep stored key' : ''}
        value={key}
        onChange={(e) => {
          setKey(e.target.value)
          resetTest()
        }}
      />

      <div className="wizard-actions">
        <button
          type="button"
          disabled={busy || testState === 'testing'}
          onClick={() => void runTest()}
        >
          Test key
        </button>
      </div>

      {testState !== 'idle' && testState !== 'testing' && (
        <p className={`wizard-test-result ${testState}`}>
          {testState === 'valid' && 'Key is valid'}
          {testState === 'invalid' && 'Key was rejected by the provider'}
          {testState === 'unreachable' && 'Provider unreachable — try again'}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="wizard-actions">
        <button type="button" disabled={busy || !canSave} onClick={save}>
          Save &amp; continue
        </button>
        <button
          type="button"
          className="wizard-skip"
          disabled={busy}
          onClick={() => onApply({ skip: true })}
        >
          Skip
        </button>
      </div>
    </div>
  )
}
