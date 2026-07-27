import type {
  ImportAction,
  ImportSourceKind,
  MigrationChoiceRequest,
  OnboardingStatus,
} from '@veduta/protocol'
import {
  groupImportItems,
  isApplyOffered,
  showsOverwriteToggle,
  type MigrationPreviewState,
} from './import-preview-state.ts'
import { WIZARD_STEP_META } from './onboarding-state.ts'

const SOURCE_LABELS: Record<ImportSourceKind, string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
}

const GROUP_ORDER: ImportAction[] = ['import', 'overwrite', 'skip']

const GROUP_LABELS: Record<ImportAction, string> = {
  import: 'Import',
  overwrite: 'Overwrite',
  skip: 'Skip',
}

/**
 * Migration step (issue 020, `tasks/plan.md` T8): one card per detected
 * source (`legacy.openclaw`/`legacy.hermes`, either or both can be true),
 * each previewed independently since the wire API takes exactly one source
 * per request (design decision 7). All fetch orchestration lives in the
 * shell (`onboarding-wizard.tsx`) -- this component only renders `preview`
 * and calls back into the handlers it is given, the same shape as
 * `WizardStepByok`'s `onTest`/`onApply`. "Migrate later" / "configure
 * manually" stay available at any point up to and including a preview --
 * a user can defer after previewing, before Apply -- but not once a
 * successful result is on screen awaiting Continue (see below): recording
 * either deferral choice there would silently overwrite the
 * `migrationChoice: 'imported'` the apply just persisted.
 *
 * Once `preview.plan` exists, `plan.items` is grouped into three labelled
 * sections (Import/Overwrite/Skip) via the pure `groupImportItems` helper --
 * an empty group renders an explicit "None." rather than disappearing, so a
 * user cannot mistake "nothing to show" for "the group was never computed."
 * `plan.warnings` (design decisions 2/3: the SOUL-adaptation and
 * untrusted-memory notices live here) get their own visibly distinct block,
 * separate from the purely informational `notMigrated` list. When
 * `plan.soulPreview` is present, the mitigation the warning describes is
 * rendered right below it inside a `<details>` -- collapsed by default so it
 * does not swamp the step, but the full adapted text is one click away, in a
 * scrolling `<pre>` rather than something that could blow out the layout.
 *
 * `Overwrite` only renders when `plan.requiresOverwrite` is true, defaults to
 * unchecked, and toggling it immediately re-previews (`onOverwriteChange`
 * clears the stale plan and fetches a fresh one in the shell) -- Apply stays
 * disabled until a plan matching the current toggle state comes back
 * (`isApplyOffered`), so a stale plan can never be what gets applied.
 *
 * The exact CLI command for a secrets import or an unreadable-source dead end
 * is never composed here: the daemon's 409/400 body already carries the
 * precise, correctly quoted command for this installation
 * (`onboarding-step-migration.ts`'s `cliImportCommand`), and it reaches this
 * step verbatim through `error` (`api.ts`'s `errorMessageFromBody`) -- see the
 * `role="alert"` block below. Composing a second copy here would drift from
 * the daemon's flag order/quoting exactly as the pre-fix version did, so the
 * secrets note below only states the rule in prose and points at
 * `deploy/README.md`.
 *
 * After a successful import the plan/groups are replaced by the result
 * summary and a "Continue" action, and the "migrate later" / "configure
 * manually" deferral buttons are hidden until Continue is taken: they call
 * `onChoice`, which persists `migrationChoice: 'migrate-later' | 'manual'` --
 * a stray click on either after Apply has already set `migrationChoice:
 * 'imported'` would silently overwrite that choice with a deferral, even
 * though the import already ran. Calling `onStatus` immediately (as every
 * other step does) would advance `currentStep` past `migration` in the very
 * same render that sets the result, so the summary would never actually be
 * visible -- `onContinue` defers that until the user has read it, matching
 * the finish step's "Enter Home" gate (`wizard-step-finish.tsx`).
 */
export function WizardStepMigration({
  status,
  busy,
  error,
  onChoice,
  preview,
  onPreview,
  onOverwriteChange,
  onApply,
  onContinue,
}: {
  status: OnboardingStatus
  busy: boolean
  error?: string | undefined
  onChoice: (choice: MigrationChoiceRequest['choice']) => void
  preview: MigrationPreviewState | undefined
  onPreview: (source: ImportSourceKind) => void
  onOverwriteChange: (overwrite: boolean) => void
  onApply: (source: ImportSourceKind, overwrite: boolean) => void
  onContinue: () => void
}) {
  const { legacy } = status
  const sources: ImportSourceKind[] = [
    ...(legacy.openclaw ? (['openclaw'] as const) : []),
    ...(legacy.hermes ? (['hermes'] as const) : []),
  ]
  const groups = preview?.plan ? groupImportItems(preview.plan.items) : undefined

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.migration.description}</p>
      {legacy.sourceHome && (
        <p>
          Detected at <code>{legacy.sourceHome}</code>
        </p>
      )}

      {sources.map((source) => (
        <div className="wizard-integration" key={source}>
          <div className="wizard-integration-fields">
            <p>
              <strong>{SOURCE_LABELS[source]}</strong>
              {preview?.source === source && preview.plan !== undefined && !preview.result
                ? ' -- previewed below'
                : null}
            </p>
            <div className="wizard-actions">
              <button type="button" disabled={busy} onClick={() => onPreview(source)}>
                Preview {SOURCE_LABELS[source]} import
              </button>
            </div>
          </div>
        </div>
      ))}

      {preview?.plan && groups && !preview.result && (
        <>
          <p>
            Preview for <strong>{SOURCE_LABELS[preview.source]}</strong>, source{' '}
            <code>{preview.plan.sourceDir}</code>
            {preview.plan.alreadyImported && (
              <>
                {' '}
                -- previously imported on <code>{preview.plan.alreadyImported.at}</code>
              </>
            )}
          </p>

          {GROUP_ORDER.map((action) => {
            const items = groups[action]
            return (
              <section className="wizard-import-group" key={action}>
                <h3>{GROUP_LABELS[action]}</h3>
                {items.length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul>
                    {items.map((item, index) => (
                      <li key={`${action}-${index}`}>
                        <code>{item.target}</code>: {item.detail}
                        {item.count !== undefined ? ` (${item.count})` : ''}
                        {item.reason !== undefined ? ` -- ${item.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}

          {preview.plan.warnings.length > 0 && (
            <div className="wizard-status-note notice">
              <p>
                <strong>Warnings</strong>
              </p>
              <ul>
                {preview.plan.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.plan.soulPreview !== undefined && (
            <details className="wizard-help">
              <summary>
                Read the adapted SOUL.md that will be written (
                {preview.plan.soulPreview.split('\n').length} lines)
              </summary>
              <pre className="wizard-soul-preview">{preview.plan.soulPreview}</pre>
            </details>
          )}

          {preview.plan.blocked.length > 0 && (
            <div className="error" role="alert">
              <p>
                <strong>Blocked</strong> -- Apply is disabled until these are resolved:
              </p>
              <ul>
                {preview.plan.blocked.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.plan.notMigrated.length > 0 && (
            <details className="wizard-help">
              <summary>Not migrated ({preview.plan.notMigrated.length})</summary>
              <ul>
                {preview.plan.notMigrated.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </details>
          )}

          {showsOverwriteToggle(preview.plan) && (
            <label htmlFor="migration-overwrite">
              <input
                id="migration-overwrite"
                type="checkbox"
                checked={preview.overwrite}
                disabled={busy}
                onChange={(e) => onOverwriteChange(e.target.checked)}
              />
              {' Overwrite conflicting SOUL.md / USER.md and reuse the existing Imported Space'}
            </label>
          )}

          <div className="wizard-help">
            <p>
              Provider API keys are never imported here: the installer never stages secrets, and the
              daemon must not race its own vault file with a second writer. Import secrets from the
              CLI instead -- see the "Migrating from OpenClaw or Hermes" section of{' '}
              <code>deploy/README.md</code> for the exact command for this installation.
            </p>
          </div>

          <div className="wizard-actions">
            <button
              type="button"
              disabled={busy || !isApplyOffered(preview.plan, preview.overwrite)}
              onClick={() => onApply(preview.source, preview.overwrite)}
            >
              Apply import
            </button>
          </div>
        </>
      )}

      {preview?.result && (
        <div className="wizard-status-note info">
          <p>
            <strong>{SOURCE_LABELS[preview.source]} import complete.</strong>
          </p>
          <ul>
            <li>
              Facts -- added: {preview.result.facts.added}, updated: {preview.result.facts.updated},
              superseded: {preview.result.facts.superseded}, noop: {preview.result.facts.noop},
              overflow: {preview.result.facts.overflow}
            </li>
            <li>Events appended: {preview.result.eventsAppended}</li>
            <li>
              Backup: <code>{preview.result.backupPath}</code>
            </li>
            <li>
              Archive: <code>{preview.result.archiveDir}</code>
            </li>
            <li>
              Notes: <code>{preview.result.notesPath}</code>
            </li>
          </ul>
          <div className="wizard-actions">
            <button type="button" disabled={busy} onClick={onContinue}>
              Continue
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!preview?.result && (
        <div className="wizard-actions">
          <button type="button" disabled={busy} onClick={() => onChoice('migrate-later')}>
            Record migration choice / migrate later
          </button>
          <button type="button" disabled={busy} onClick={() => onChoice('manual')}>
            Configure manually
          </button>
        </div>
      )}
    </div>
  )
}
