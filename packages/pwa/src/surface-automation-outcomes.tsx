import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  AutomationOutcomeStatusesSchema,
  type AutomationOutcomeStatus,
  type RenderableSurface,
} from '@veduta/protocol'

export function SurfaceAutomationOutcomes({ surface }: { surface: RenderableSurface }) {
  const outcomes = AutomationOutcomeStatusesSchema.safeParse(
    surface.state[AUTOMATION_OUTCOMES_STATE_KEY],
  )
  if (!outcomes.success) return null
  return (
    <>
      {Object.values(outcomes.data)
        .sort((left, right) => left.automationId - right.automationId)
        .map((status) => (
          <AutomationOutcomeStatusPanel key={status.automationId} status={status} />
        ))}
    </>
  )
}

function AutomationOutcomeStatusPanel({ status }: { status: AutomationOutcomeStatus }) {
  return (
    <section
      className={`automation-outcome-status ${status.latest?.kind ?? 'fresh'}`}
      aria-label={`Automation ${status.automationId} status`}
    >
      {status.latest && (
        <div className="automation-outcome-status-latest">
          <strong>
            Automation #{status.automationId} · {automationOutcomeKindLabel(status.latest.kind)}
          </strong>
          <span>{status.latest.summary}</span>
        </div>
      )}
      <dl>
        <div>
          <dt>Last checked</dt>
          <dd>
            <time dateTime={status.lastCheckedAt}>
              {automationOutcomeTimeLabel(status.lastCheckedAt)}
            </time>
          </dd>
        </div>
        {status.lastSuccessfulAt && (
          <div>
            <dt>Last successful</dt>
            <dd>
              <time dateTime={status.lastSuccessfulAt}>
                {automationOutcomeTimeLabel(status.lastSuccessfulAt)}
              </time>
            </dd>
          </div>
        )}
      </dl>
      {status.currentError && (
        <p className="automation-outcome-status-error">{status.currentError.message}</p>
      )}
    </section>
  )
}

function automationOutcomeKindLabel(
  kind: NonNullable<AutomationOutcomeStatus['latest']>['kind'],
): string {
  if (kind === 'decision-required') return 'Decision required'
  return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`
}

function automationOutcomeTimeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}
