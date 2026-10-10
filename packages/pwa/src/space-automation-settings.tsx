import { Button } from '@veduta/catalog/ui/button'
import {
  AutomationRunHistory,
  AutomationScheduleDescription,
  type CatalogTheme,
} from '@veduta/catalog'
import { Input } from '@veduta/catalog/ui/input'
import { Textarea } from '@veduta/catalog/ui/textarea'
import {
  SYSTEM_SPACE_ID,
  type SettingsAutomation,
  type SpaceSettingsList,
  type AutomationSettingsChange,
} from '@veduta/protocol'
import { useState } from 'react'
import type { SaveSpaceSettings } from './space-memory-settings.tsx'

export function ReflectionSettingsForm({
  reflection,
  save,
  busy,
}: {
  reflection: SpaceSettingsList['reflection']
  save: (value: {
    enabled: boolean
    time: string
    expectedRevision: string
  }) => Promise<SpaceSettingsList | undefined>
  busy: boolean
}) {
  const [enabled, setEnabled] = useState(reflection.enabled)
  const [time, setTime] = useState(reflection.time)
  const [base, setBase] = useState(reflection)
  const [sourceRevision, setSourceRevision] = useState(reflection.revision)
  const dirty = enabled !== base.enabled || time !== base.time
  if (sourceRevision !== reflection.revision) {
    setSourceRevision(reflection.revision)
    if (!dirty) {
      setEnabled(reflection.enabled)
      setTime(reflection.time)
      setBase(reflection)
    }
  }
  return (
    <section className="space-reflection-settings">
      <h2>Nightly Reflection</h2>
      <p>
        Reviews recent events and maintains facts for all active Spaces. Times use{' '}
        {reflection.timezone}.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save({ enabled, time, expectedRevision: base.revision }).then((saved) => {
            if (!saved) return
            setEnabled(saved.reflection.enabled)
            setTime(saved.reflection.time)
            setBase(saved.reflection)
          })
        }}
      >
        <label className="space-settings-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={busy}
          />
          Enabled
        </label>
        <label>
          Daily time
          <Input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            required
            disabled={busy}
          />
        </label>
        <Button type="submit" disabled={busy || !dirty}>
          Save Reflection settings
        </Button>
      </form>
    </section>
  )
}

export function AutomationSettingsEditor({
  automation,
  spaceId,
  save,
  busy,
  theme,
}: {
  automation: SettingsAutomation
  spaceId: string
  save: SaveSpaceSettings
  busy: boolean
  theme?: CatalogTheme | undefined
}) {
  const [description, setDescription] = useState(automation.description)
  const [base, setBase] = useState({
    description: automation.description,
    revision: automation.revision,
  })
  const [repeat, setRepeat] = useState('keep')
  const [time, setTime] = useState('09:00')
  const [day, setDay] = useState('1')
  const [fireAt, setFireAt] = useState('')
  const [sourceRevision, setSourceRevision] = useState(automation.revision)
  const dirty = description !== base.description || repeat !== 'keep' || fireAt !== ''
  if (sourceRevision !== automation.revision) {
    setSourceRevision(automation.revision)
    if (!dirty) {
      setDescription(automation.description)
      setBase({ description: automation.description, revision: automation.revision })
    }
  }
  const canEdit =
    automation.status === 'armed' && !(automation.managed && spaceId === SYSTEM_SPACE_ID)
  function change(): AutomationSettingsChange {
    const result: AutomationSettingsChange = { expectedRevision: base.revision }
    if (!automation.managed && description !== base.description) result.description = description
    if (repeat !== 'keep') {
      const [hour, minute] = time.split(':')
      result.cron =
        repeat === 'hourly'
          ? '0 * * * *'
          : `${Number(minute)} ${Number(hour)} * * ${repeat === 'weekdays' ? '1-5' : repeat === 'weekly' ? day : '*'}`
    }
    if (fireAt) result.fireAt = new Date(fireAt).toISOString()
    return result
  }
  return (
    <article className="space-automation-setting">
      <div className="space-automation-heading">
        <h3>{automation.description}</h3>
        {automation.status === 'armed' ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void save({
                action: 'automation',
                automationId: automation.id,
                change: { expectedRevision: automation.revision, enabled: !automation.enabled },
              })
            }
          >
            {automation.enabled ? 'Disable' : 'Enable'}
          </Button>
        ) : (
          <span>{automation.status}</span>
        )}
      </div>
      <AutomationScheduleDescription
        schedule="Schedule unavailable"
        details={automation}
        enabled={automation.enabled}
      />
      <AutomationRunHistory history={automation.history} theme={theme} />
      {canEdit && (
        <details>
          <summary>Edit Automation</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save({
                action: 'automation',
                automationId: automation.id,
                change: change(),
              }).then((saved) => {
                const next = saved?.automations.find((item) => item.id === automation.id)
                if (!next) return
                setDescription(next.description)
                setBase({ description: next.description, revision: next.revision })
                setRepeat('keep')
                setFireAt('')
              })
            }}
          >
            {!automation.managed && (
              <label>
                Instructions
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            )}
            {automation.kind === 'job' ? (
              <>
                <label>
                  Schedule
                  <select
                    value={repeat}
                    onChange={(event) => setRepeat(event.target.value)}
                    disabled={busy}
                  >
                    <option value="keep">Keep current schedule</option>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Monday to Friday</option>
                    <option value="weekly">Every week</option>
                    <option value="hourly">Every hour</option>
                  </select>
                </label>
                {repeat !== 'keep' && repeat !== 'hourly' && (
                  <label>
                    Time ({automation.timezone})
                    <Input
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      required
                      disabled={busy}
                    />
                  </label>
                )}
                {repeat === 'weekly' && (
                  <label>
                    Day
                    <select value={day} onChange={(event) => setDay(event.target.value)}>
                      {[
                        'Sunday',
                        'Monday',
                        'Tuesday',
                        'Wednesday',
                        'Thursday',
                        'Friday',
                        'Saturday',
                      ].map((label, index) => (
                        <option key={label} value={index}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <label>
                New time (this device's timezone)
                <Input
                  type="datetime-local"
                  value={fireAt}
                  onChange={(event) => setFireAt(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            <Button type="submit" disabled={busy || !dirty}>
              Save Automation
            </Button>
          </form>
        </details>
      )}
    </article>
  )
}
