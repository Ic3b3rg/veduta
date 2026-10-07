import type {
  CalendarIntegrationRequest,
  IntegrationsApplyRequest,
  OnboardingStatus,
} from '@veduta/protocol'
import { useState } from 'react'
import { WIZARD_STEP_META } from './onboarding-state.ts'

interface CalendarForm {
  enabled: boolean
  clientId: string
  clientSecret: string
  refreshToken: string
  calendarId: string
}

function initialCalendar(status: OnboardingStatus): CalendarForm {
  const { calendar } = status.integrations
  return {
    enabled: calendar.configured,
    clientId: calendar.clientId ?? '',
    clientSecret: '',
    refreshToken: '',
    calendarId: calendar.calendarId ?? 'primary',
  }
}

/**
 * Calendar Watch setup remains available. A saved Gmail source is shown only
 * as inert migration input until a passive Mailbox connection flow exists.
 */
export function WizardStepIntegrations({
  status,
  busy,
  onApply,
  error,
}: {
  status: OnboardingStatus
  busy: boolean
  onApply: (request: IntegrationsApplyRequest) => void
  error?: string | undefined
}) {
  const [calendar, setCalendar] = useState<CalendarForm>(() => initialCalendar(status))
  const privateAccess = status.domain.accessMode === 'tunnel'

  const calendarValid = !calendar.enabled || calendar.clientId.trim() !== ''
  const canSave = !privateAccess && calendar.enabled && calendarValid

  const buildCalendar = (): CalendarIntegrationRequest => ({
    clientId: calendar.clientId.trim(),
    calendarId: calendar.calendarId.trim() === '' ? 'primary' : calendar.calendarId.trim(),
    ...(calendar.clientSecret.trim() === '' ? {} : { clientSecret: calendar.clientSecret.trim() }),
    ...(calendar.refreshToken.trim() === '' ? {} : { refreshToken: calendar.refreshToken.trim() }),
  })

  const save = () => {
    onApply({
      ...(calendar.enabled ? { calendar: buildCalendar() } : {}),
    })
  }

  return (
    <div className="wizard-step-form">
      <p>
        {privateAccess
          ? 'Calendar push updates need a public address. Skip this optional step to keep Veduta private. Saved connection details are retained.'
          : WIZARD_STEP_META.integrations.description}
      </p>

      {status.integrations.gmail.configured && (
        <p>Saved Gmail connection details are retained. Mail access is inactive.</p>
      )}

      {!privateAccess && (
        <details className="wizard-integration" open={calendar.enabled}>
          <summary>
            <label>
              <input
                type="checkbox"
                checked={calendar.enabled}
                onChange={(e) => setCalendar({ ...calendar, enabled: e.target.checked })}
              />
              {' Calendar'}
            </label>
            {status.integrations.calendar.configured && (
              <span className="status-pill online">configured</span>
            )}
          </summary>
          <div className="wizard-integration-fields">
            <label htmlFor="calendar-client-id">Client ID</label>
            <input
              id="calendar-client-id"
              value={calendar.clientId}
              onChange={(e) => setCalendar({ ...calendar, clientId: e.target.value })}
            />
            <label htmlFor="calendar-client-secret">Client secret</label>
            <input
              id="calendar-client-secret"
              type="password"
              autoComplete="off"
              placeholder={status.integrations.calendar.hasCredentials ? 'keep stored' : ''}
              value={calendar.clientSecret}
              onChange={(e) => setCalendar({ ...calendar, clientSecret: e.target.value })}
            />
            <label htmlFor="calendar-refresh-token">Refresh token</label>
            <input
              id="calendar-refresh-token"
              type="password"
              autoComplete="off"
              placeholder={status.integrations.calendar.hasCredentials ? 'keep stored' : ''}
              value={calendar.refreshToken}
              onChange={(e) => setCalendar({ ...calendar, refreshToken: e.target.value })}
            />
            <label htmlFor="calendar-id">Calendar ID</label>
            <input
              id="calendar-id"
              value={calendar.calendarId}
              onChange={(e) => setCalendar({ ...calendar, calendarId: e.target.value })}
            />
          </div>
        </details>
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
