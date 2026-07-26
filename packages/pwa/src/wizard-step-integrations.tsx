import type {
  CalendarIntegrationRequest,
  GmailIntegrationRequest,
  IntegrationsApplyRequest,
  OnboardingStatus,
} from '@veduta/protocol'
import { useState } from 'react'
import { WIZARD_STEP_META } from './onboarding-state.ts'

interface GmailForm {
  enabled: boolean
  clientId: string
  clientSecret: string
  refreshToken: string
  topicName: string
  subscription: string
}

interface CalendarForm {
  enabled: boolean
  clientId: string
  clientSecret: string
  refreshToken: string
  calendarId: string
}

/**
 * Non-secret resume defaults (issue 019 review fix): pre-fills whatever the
 * daemon already has on file for this section, and pre-checks/opens a
 * section that is already `configured` — the same Hermes discipline as the
 * rest of the wizard, never re-asking for a value already known. Secret
 * fields are never pre-filled; they keep the existing "keep stored"
 * placeholder semantics via `hasCredentials` instead.
 */
function initialGmail(status: OnboardingStatus): GmailForm {
  const { gmail } = status.integrations
  return {
    enabled: gmail.configured,
    clientId: gmail.clientId ?? '',
    clientSecret: '',
    refreshToken: '',
    topicName: gmail.topicName ?? '',
    subscription: gmail.subscription ?? '',
  }
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
 * Integrations step (`tasks/plan.md` §4/§8): gmail and calendar are each
 * optional and independently enabled. Secrets left blank on an already
 * `hasCredentials` section mean "keep the existing stored value" — they are
 * omitted from the request rather than sent empty. One-tap Skip is always
 * available; sources activate only after the finish-step restart.
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
  const [gmail, setGmail] = useState<GmailForm>(() => initialGmail(status))
  const [calendar, setCalendar] = useState<CalendarForm>(() => initialCalendar(status))

  const gmailValid =
    !gmail.enabled ||
    (gmail.clientId.trim() !== '' &&
      gmail.topicName.trim() !== '' &&
      gmail.subscription.trim() !== '')
  const calendarValid = !calendar.enabled || calendar.clientId.trim() !== ''
  const canSave = (gmail.enabled || calendar.enabled) && gmailValid && calendarValid

  const buildGmail = (): GmailIntegrationRequest => ({
    clientId: gmail.clientId.trim(),
    topicName: gmail.topicName.trim(),
    subscription: gmail.subscription.trim(),
    ...(gmail.clientSecret.trim() === '' ? {} : { clientSecret: gmail.clientSecret.trim() }),
    ...(gmail.refreshToken.trim() === '' ? {} : { refreshToken: gmail.refreshToken.trim() }),
  })

  const buildCalendar = (): CalendarIntegrationRequest => ({
    clientId: calendar.clientId.trim(),
    calendarId: calendar.calendarId.trim() === '' ? 'primary' : calendar.calendarId.trim(),
    ...(calendar.clientSecret.trim() === '' ? {} : { clientSecret: calendar.clientSecret.trim() }),
    ...(calendar.refreshToken.trim() === '' ? {} : { refreshToken: calendar.refreshToken.trim() }),
  })

  const save = () => {
    onApply({
      ...(gmail.enabled ? { gmail: buildGmail() } : {}),
      ...(calendar.enabled ? { calendar: buildCalendar() } : {}),
    })
  }

  return (
    <div className="wizard-step-form">
      <p>{WIZARD_STEP_META.integrations.description}</p>

      <details className="wizard-integration" open={gmail.enabled}>
        <summary>
          <label>
            <input
              type="checkbox"
              checked={gmail.enabled}
              onChange={(e) => setGmail({ ...gmail, enabled: e.target.checked })}
            />
            {' Gmail'}
          </label>
          {status.integrations.gmail.configured && (
            <span className="status-pill online">configured</span>
          )}
        </summary>
        <div className="wizard-integration-fields">
          <label htmlFor="gmail-client-id">Client ID</label>
          <input
            id="gmail-client-id"
            value={gmail.clientId}
            onChange={(e) => setGmail({ ...gmail, clientId: e.target.value })}
          />
          <label htmlFor="gmail-client-secret">Client secret</label>
          <input
            id="gmail-client-secret"
            type="password"
            autoComplete="off"
            placeholder={status.integrations.gmail.hasCredentials ? 'keep stored' : ''}
            value={gmail.clientSecret}
            onChange={(e) => setGmail({ ...gmail, clientSecret: e.target.value })}
          />
          <label htmlFor="gmail-refresh-token">Refresh token</label>
          <input
            id="gmail-refresh-token"
            type="password"
            autoComplete="off"
            placeholder={status.integrations.gmail.hasCredentials ? 'keep stored' : ''}
            value={gmail.refreshToken}
            onChange={(e) => setGmail({ ...gmail, refreshToken: e.target.value })}
          />
          <label htmlFor="gmail-topic-name">Pub/Sub topic name</label>
          <input
            id="gmail-topic-name"
            value={gmail.topicName}
            onChange={(e) => setGmail({ ...gmail, topicName: e.target.value })}
          />
          <label htmlFor="gmail-subscription">Pub/Sub subscription</label>
          <input
            id="gmail-subscription"
            value={gmail.subscription}
            onChange={(e) => setGmail({ ...gmail, subscription: e.target.value })}
          />
        </div>
      </details>

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
