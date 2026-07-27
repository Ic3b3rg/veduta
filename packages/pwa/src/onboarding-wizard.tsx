import type { ByokProvider, ImportSourceKind, OnboardingStatus } from '@veduta/protocol'
import { useState } from 'react'
import {
  applyByokStep,
  applyFirstSpaceStep,
  applyIntegrationsStep,
  applyModelsStep,
  confirmDomainStep,
  fetchAuthStatus,
  finishOnboarding,
  previewLegacyImport,
  runLegacyImport,
  submitMigrationChoice,
  testByokKey,
} from './api.ts'
import { startMigrationPreview, type MigrationPreviewState } from './import-preview-state.ts'
import {
  currentStep,
  isStepDone,
  stepIndicator,
  visibleSteps,
  WIZARD_STEP_META,
} from './onboarding-state.ts'
import { WizardStepByok } from './wizard-step-byok.tsx'
import { WizardStepDomain } from './wizard-step-domain.tsx'
import { WizardStepFinish } from './wizard-step-finish.tsx'
import { WizardStepFirstSpace } from './wizard-step-first-space.tsx'
import { WizardStepIntegrations } from './wizard-step-integrations.tsx'
import { WizardStepMigration } from './wizard-step-migration.tsx'
import { WizardStepModels } from './wizard-step-models.tsx'

interface FinishState {
  submitted: boolean
  restarting: boolean
  restartRequired: boolean
  restartTimedOut: boolean
}

/**
 * Onboarding wizard shell (issue 019, `tasks/plan.md` §1/§13): bespoke
 * full-screen React flow gated at App level like `AuthGate`. The daemon's
 * `OnboardingStatus` is the single source of truth — every step submit
 * re-fetches it via the matching `api.ts` helper and hands the fresh status
 * back to `onStatus`, so resume (first incomplete step) comes for free from
 * `onboarding-state.ts` on the next render. No local step-order state here.
 */
export function OnboardingWizard({
  status,
  token,
  onCompleted,
  onStatus,
}: {
  status: OnboardingStatus
  token?: string | undefined
  onCompleted: () => void
  onStatus: (status: OnboardingStatus) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [finishState, setFinishState] = useState<FinishState>({
    submitted: false,
    restarting: false,
    restartRequired: false,
    restartTimedOut: false,
  })
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreviewState | undefined>(
    undefined,
  )
  // Held rather than fed to `onStatus` immediately after a successful import
  // (`tasks/plan.md` T8): see `onMigrationContinue` below for why.
  const [migrationPendingStatus, setMigrationPendingStatus] = useState<
    OnboardingStatus | undefined
  >(undefined)

  const run = async (fn: () => Promise<OnboardingStatus>) => {
    setBusy(true)
    setError(undefined)
    try {
      onStatus(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed')
    } finally {
      setBusy(false)
    }
  }

  /**
   * `POST /api/onboarding/migration/preview` (issue 020, `tasks/plan.md`
   * T8): a pure dry-run, so this never touches `onStatus` -- only local
   * preview state. Re-run on every "Preview" click (fresh source, overwrite
   * reset to false) and on every `overwrite` toggle (design decision 7: the
   * preview must always describe exactly what Apply would do), clearing any
   * previous plan/result first so a stale one is never shown as current.
   */
  const runMigrationPreview = async (source: ImportSourceKind, overwrite: boolean) => {
    setBusy(true)
    setError(undefined)
    setMigrationPreview(startMigrationPreview(source, overwrite))
    try {
      const plan = await previewLegacyImport({ source, overwrite, secrets: false }, token)
      setMigrationPreview({ source, overwrite, plan, result: undefined })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview failed')
      setMigrationPreview(undefined)
    } finally {
      setBusy(false)
    }
  }

  const onMigrationOverwriteChange = (overwrite: boolean) => {
    if (migrationPreview === undefined) return
    void runMigrationPreview(migrationPreview.source, overwrite)
  }

  /**
   * `POST /api/onboarding/migration/import`: recomputes and applies the plan
   * (the daemon never trusts the client-supplied preview -- decision 7), then
   * holds the returned `{result, status}` rather than calling `onStatus`
   * synchronously like `run()` does for every other step. Calling it here
   * would advance `currentStep` past `migration` in the same render that
   * sets the result (React batches both state updates together), so the
   * result summary would never actually render -- `onMigrationContinue`
   * applies the held status once the user has read it.
   */
  const onMigrationApply = async (source: ImportSourceKind, overwrite: boolean) => {
    setBusy(true)
    setError(undefined)
    try {
      const { result, status: nextStatus } = await runLegacyImport(
        { source, overwrite, secrets: false },
        token,
      )
      setMigrationPreview({ source, overwrite, plan: result.plan, result })
      setMigrationPendingStatus(nextStatus)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed')
    } finally {
      setBusy(false)
    }
  }

  const onMigrationContinue = () => {
    if (migrationPendingStatus === undefined) return
    onStatus(migrationPendingStatus)
    setMigrationPendingStatus(undefined)
    setMigrationPreview(undefined)
  }

  const onFinish = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await finishOnboarding(token)
      setFinishState({
        submitted: true,
        restarting: response.restarting,
        restartRequired: response.restartRequired,
        restartTimedOut: false,
      })
      if (response.restarting) {
        await pollForRestart()
        return
      }
      // Loopback/Local VPS: config takes effect on the next daemon start, so
      // there is nothing to wait for. Only enter Home immediately when there
      // is no restart pending at all — when one is pending the finish step
      // shows an explicit "Enter Home" confirmation instead (below).
      if (!response.restartRequired) onCompleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to finish onboarding')
    } finally {
      setBusy(false)
    }
  }

  // VPS profile only: `finish` replied and the daemon is restarting. If it
  // never comes back within the deadline, this must not silently strand the
  // user in Home with half-applied config — show the exact command to
  // inspect why on the finish step instead, with a Retry that re-polls.
  const pollForRestart = async () => {
    const restarted = await waitForDaemonRestart()
    if (restarted) {
      onCompleted()
      return
    }
    setFinishState((prev) => ({ ...prev, restartTimedOut: true }))
  }

  const onRetryRestart = async () => {
    setBusy(true)
    setError(undefined)
    setFinishState((prev) => ({ ...prev, restartTimedOut: false }))
    try {
      await pollForRestart()
    } finally {
      setBusy(false)
    }
  }

  const active = currentStep(status)
  const { index, total } = stepIndicator(status)

  return (
    <main className="wizard-shell">
      <div className="wizard-card">
        <header className="wizard-header">
          <h1>Set up Veduta</h1>
          {active !== null && (
            <p>
              Step {index} of {total}: {WIZARD_STEP_META[active].title}
            </p>
          )}
        </header>

        <ol className="wizard-progress">
          {visibleSteps(status).map((id) => {
            const done = isStepDone(status, id)
            const isCurrent = id === active
            return (
              <li
                key={id}
                className={
                  isCurrent
                    ? 'wizard-progress-item current'
                    : done
                      ? 'wizard-progress-item done'
                      : 'wizard-progress-item'
                }
              >
                <span
                  className={
                    done ? 'status-pill online' : isCurrent ? 'status-pill pending' : 'status-pill'
                  }
                >
                  {WIZARD_STEP_META[id].title}
                </span>
              </li>
            )
          })}
        </ol>

        {active === 'migration' && (
          <WizardStepMigration
            status={status}
            busy={busy}
            error={error}
            onChoice={(choice) => void run(() => submitMigrationChoice(choice, token))}
            preview={migrationPreview}
            onPreview={(source) => void runMigrationPreview(source, false)}
            onOverwriteChange={onMigrationOverwriteChange}
            onApply={(source, overwrite) => void onMigrationApply(source, overwrite)}
            onContinue={onMigrationContinue}
          />
        )}
        {active === 'domain' && (
          <WizardStepDomain
            status={status}
            busy={busy}
            error={error}
            onConfirm={() => void run(() => confirmDomainStep(token))}
          />
        )}
        {active === 'byok' && (
          <WizardStepByok
            status={status}
            busy={busy}
            error={error}
            onTest={(provider: ByokProvider, key?: string) =>
              testByokKey({ provider, ...(key === undefined ? {} : { key }) }, token)
            }
            onApply={(request) => void run(() => applyByokStep(request, token))}
          />
        )}
        {active === 'models' && (
          <WizardStepModels
            status={status}
            busy={busy}
            error={error}
            onApply={(tiers) => void run(() => applyModelsStep(tiers, token))}
          />
        )}
        {active === 'first-space' && (
          <WizardStepFirstSpace
            status={status}
            busy={busy}
            error={error}
            onApply={(request) => void run(() => applyFirstSpaceStep(request, token))}
          />
        )}
        {active === 'integrations' && (
          <WizardStepIntegrations
            status={status}
            busy={busy}
            error={error}
            onApply={(request) => void run(() => applyIntegrationsStep(request, token))}
          />
        )}
        {active === 'finish' && (
          <WizardStepFinish
            busy={busy}
            error={error}
            submitted={finishState.submitted}
            restarting={finishState.restarting}
            restartRequired={finishState.restartRequired}
            restartTimedOut={finishState.restartTimedOut}
            onFinish={() => void onFinish()}
            onEnterHome={onCompleted}
            onRetryRestart={() => void onRetryRestart()}
          />
        )}

        {status.installer && (
          <details className="wizard-installer-summary">
            <summary>Installer report</summary>
            <ul>
              {status.installer.stages.map((stage) => (
                <li key={stage.id}>
                  {stage.title}: {stage.status}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </main>
  )
}

/**
 * Polls the public, lightweight `/api/auth/status` every 2s (max ~90s) until
 * the daemon answers again — used only on the VPS profile, where `finish`
 * replies then exits gracefully so systemd (`Restart=always`) can reboot it
 * with the new boot-time-immutable config (`tasks/plan.md` §4). Returns
 * whether the daemon came back before the deadline; the caller must not
 * silently enter Home when it didn't.
 */
async function waitForDaemonRestart(maxMs = 90_000, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    try {
      await fetchAuthStatus()
      return true
    } catch {
      // still restarting — keep polling until the deadline.
    }
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
