import { renderNode } from '@veduta/catalog'
import { Button } from '@veduta/catalog/ui/button'
import {
  SYSTEM_SPACE_ID,
  type SpaceSettings,
  type SpaceSettingsCommand,
  type SpaceSettingsList,
  type SpacePresentation,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionsSection } from './connections-section.tsx'
import {
  ConnectionDetail,
  ConnectionDetailBody,
  ConnectionListItem,
} from './connections-layout.tsx'
import {
  fetchSpaceSettingsList,
  fetchSpaceSettings,
  changeSpaceSettings,
  changeReflectionSettings,
} from './space-settings-api.ts'
import { SpaceMemorySettings } from './space-memory-settings.tsx'
import { AutomationSettingsEditor, ReflectionSettingsForm } from './space-automation-settings.tsx'
import { useCatalogTheme } from './theme.ts'

export function ConnectionsSpaces({
  section,
  token,
}: {
  section: 'spaces' | 'automations'
  token?: string | undefined
}) {
  const [list, setList] = useState<SpaceSettingsList>()
  const [detail, setDetail] = useState<SpaceSettings>()
  const [loadRevision, setLoadRevision] = useState(0)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  const generation = useRef(0)
  const theme = useCatalogTheme()
  const refresh = useCallback(async () => {
    try {
      setList(await fetchSpaceSettingsList(token))
      setError(undefined)
    } catch (error) {
      setError(errorText(error))
    }
  }, [token])
  useEffect(() => {
    let active = true
    void fetchSpaceSettingsList(token)
      .then((value) => {
        if (active) setList(value)
      })
      .catch((error: unknown) => {
        if (active) setError(errorText(error))
      })
    return () => {
      active = false
      generation.current += 1
    }
  }, [token])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  async function open(spaceId: string) {
    if (busy) return
    const request = ++generation.current
    setBusy(true)
    setError(undefined)
    setConfirmArchive(false)
    try {
      const next = await fetchSpaceSettings(spaceId, token)
      if (request === generation.current) {
        setDetail(next)
        setLoadRevision((value) => value + 1)
      }
    } catch (error) {
      if (request === generation.current) setError(errorText(error))
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  async function save(command: SpaceSettingsCommand): Promise<boolean> {
    if (!detail) return false
    setBusy(true)
    setError(undefined)
    try {
      setDetail(await changeSpaceSettings(detail.space.id, command, token))
      setList(await fetchSpaceSettingsList(token))
      setConfirmArchive(false)
      setNotice('Saved')
      return true
    } catch (error) {
      setError(errorText(error))
      return false
    } finally {
      setBusy(false)
    }
  }
  const spaces = list?.spaces.filter((space) => section === 'spaces' || !space.archived)
  return (
    <ConnectionsSection
      title={section === 'spaces' ? 'Spaces & memory' : 'Automations'}
      description={
        section === 'spaces'
          ? 'Manage each Space, its facts and instructions.'
          : 'Manage recurring work and reminders without crowding your Spaces.'
      }
      actions={
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void refresh()
            if (detail) void open(detail.space.id)
          }}
        >
          Reload settings
        </Button>
      }
    >
      {error && !detail && (
        <p role="alert" className="connections-alert">
          {error}
        </p>
      )}
      {notice && !detail && <p role="status">{notice}</p>}
      {!list && <p role="status">Loading settings…</p>}
      {section === 'automations' && list && (
        <ReflectionSettingsForm
          key={list.reflection.revision}
          reflection={list.reflection}
          busy={busy}
          save={async (change) => {
            setBusy(true)
            setError(undefined)
            try {
              setList(await changeReflectionSettings(change, token))
              if (detail) setDetail(await fetchSpaceSettings(detail.space.id, token))
              setNotice('Reflection settings saved')
            } catch (error) {
              setError(errorText(error))
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      <div className="connections-workspace">
        <div className="connections-list space-settings-list" aria-label="Spaces">
          {spaces?.map((space) => (
            <ConnectionListItem
              key={space.id}
              title={space.name}
              subtitle={
                space.archived
                  ? 'Content is preserved. Restore to use this Space again.'
                  : section === 'spaces'
                    ? space.id === SYSTEM_SPACE_ID
                      ? 'Surface arrangement'
                      : 'Facts, instructions and presentation'
                    : 'Schedules, controls and Reflection report'
              }
              state={space.archived ? 'archived' : 'active'}
              selected={detail?.space.id === space.id}
              disabled={busy}
              returnFocusRef={opener}
              onClick={() => void open(space.id)}
            />
          ))}
          {spaces?.length === 0 && <p>No Spaces yet. Create one from Chat.</p>}
        </div>
        {detail && (
          <ConnectionDetail
            title={detail.space.name}
            description={
              section === 'spaces' ? 'Space settings and memory' : 'Automations owned by this Space'
            }
            opener={opener}
            busy={busy}
            onClose={() => {
              generation.current += 1
              setDetail(undefined)
              setBusy(false)
              setError(undefined)
            }}
          >
            <ConnectionDetailBody>
              {error && (
                <p role="alert" className="connections-alert">
                  {error}
                </p>
              )}
              {notice && <p role="status">{notice}</p>}
              {detail.space.archived ? (
                <div>
                  <p>
                    This Space is archived. Its memory, Surfaces and Chat history are preserved.
                  </p>
                  <Button disabled={busy} onClick={() => void save({ action: 'restore' })}>
                    Restore Space
                  </Button>
                </div>
              ) : section === 'spaces' ? (
                <>
                  <section className="space-settings-presentation">
                    <h3>Surface arrangement</h3>
                    <label>
                      Columns
                      <select
                        value={detail.space.presentation ?? 'auto'}
                        disabled={busy}
                        onChange={(event) =>
                          void save({
                            action: 'presentation',
                            presentation: event.target.value as SpacePresentation,
                          })
                        }
                      >
                        <option value="auto">Automatic</option>
                        <option value="one-column">One column</option>
                        <option value="two-columns">Two columns</option>
                      </select>
                    </label>
                    <p>
                      Narrow screens use one column. Full-presentation Surfaces span the available
                      row.
                    </p>
                  </section>
                  {detail.space.id !== SYSTEM_SPACE_ID && (
                    <>
                      <SpaceMemorySettings
                        key={`${detail.space.id}:${loadRevision}`}
                        settings={detail}
                        save={save}
                        busy={busy}
                      />
                      <section className="space-archive-settings">
                        <h3>Archive Space</h3>
                        <p>Remove this Space from Home. You can restore its content here.</p>
                        {confirmArchive ? (
                          <div className="space-settings-actions">
                            <Button
                              disabled={busy}
                              onClick={() => void save({ action: 'archive' })}
                            >
                              Confirm archive
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setConfirmArchive(false)}
                            >
                              Keep Space
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setConfirmArchive(true)}
                          >
                            Archive Space
                          </Button>
                        )}
                      </section>
                    </>
                  )}
                </>
              ) : (
                <>
                  {detail.automations.length === 0 && (
                    <p>No Automations in this Space. You can create one from Chat.</p>
                  )}
                  {detail.automations.map((automation) => (
                    <AutomationSettingsEditor
                      key={`${automation.id}:${automation.revision}`}
                      automation={automation}
                      spaceId={detail.space.id}
                      save={save}
                      busy={busy}
                    />
                  ))}
                  {detail.surfaces
                    .filter((surface) => surface.management === 'reflection')
                    .map((surface) => (
                      <details key={surface.id}>
                        <summary>Last Nightly Reflection report</summary>
                        {renderNode(surface.tree, {
                          state: surface.state,
                          theme,
                          dispatch: () => undefined,
                        })}
                      </details>
                    ))}
                </>
              )}
            </ConnectionDetailBody>
          </ConnectionDetail>
        )}
      </div>
    </ConnectionsSection>
  )
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Settings could not load'
}
