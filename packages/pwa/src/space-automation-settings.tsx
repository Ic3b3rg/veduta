import { Button } from '@veduta/catalog/ui/button'
import { AutomationScheduleDescription } from '@veduta/catalog'
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
  save: (value: { enabled: boolean; time: string; expectedRevision: string }) => Promise<void>
  busy: boolean
}) {
  const [enabled, setEnabled] = useState(reflection.enabled)
  const [time, setTime] = useState(reflection.time)
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
          void save({ enabled, time, expectedRevision: reflection.revision })
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
        <Button
          type="submit"
          disabled={busy || (enabled === reflection.enabled && time === reflection.time)}
        >
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
}: {
  automation: SettingsAutomation
  spaceId: string
  save: SaveSpaceSettings
  busy: boolean
}) {
  const [description, setDescription] = useState(automation.description)
  const [repeat, setRepeat] = useState('keep')
  const [time, setTime] = useState('09:00')
  const [day, setDay] = useState('1')
  const [fireAt, setFireAt] = useState('')
  const canEdit =
    automation.status === 'armed' && !(automation.managed && spaceId === SYSTEM_SPACE_ID)
  function change(): AutomationSettingsChange {
    const result: AutomationSettingsChange = { expectedRevision: automation.revision }
    if (!automation.managed && description !== automation.description)
      result.description = description
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
      {canEdit && (
        <details>
          <summary>Edit Automation</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save({ action: 'automation', automationId: automation.id, change: change() })
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
            <Button
              type="submit"
              disabled={
                busy || (repeat === 'keep' && !fireAt && description === automation.description)
              }
            >
              Save Automation
            </Button>
          </form>
        </details>
      )}
    </article>
  )
}
