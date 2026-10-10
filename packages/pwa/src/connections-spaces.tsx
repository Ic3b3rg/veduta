import { renderNode } from '@veduta/catalog'
import { Button } from '@veduta/catalog/ui/button'
import {
  SYSTEM_SPACE_ID,
  type SpaceSettingsCommand,
  type SpacePresentation,
} from '@veduta/protocol'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ConnectionsSection } from './connections-section.tsx'
import {
  ConnectionDetail,
  ConnectionDetailBody,
  ConnectionListItem,
} from './connections-layout.tsx'
import { SpaceMemorySettings, type SaveSpaceSettings } from './space-memory-settings.tsx'
import { AutomationSettingsEditor, ReflectionSettingsForm } from './space-automation-settings.tsx'
import { useCatalogTheme } from './theme.ts'
import { usePwaRuntime } from './use-live-state.ts'
import { SurfaceAutomationOutcomes } from './surface-automation-outcomes.tsx'

const noSubscription = () => () => {}

export function ConnectionsSpaces({
  section,
  initialSpaceId,
}: {
  section: 'spaces' | 'automations'
  token?: string | undefined
  initialSpaceId?: string | undefined
}) {
  const runtime = usePwaRuntime()
  const readSettings = () => runtime?.getSnapshot().spaceSettings
  const settings = useSyncExternalStore(
    runtime?.subscribe ?? noSubscription,
    readSettings,
    readSettings,
  )
  const [selection, setSelection] = useState({ initialSpaceId, spaceId: initialSpaceId })
  if (selection.initialSpaceId !== initialSpaceId)
    setSelection({ initialSpaceId, spaceId: initialSpaceId })
  const selectedSpaceId = selection.spaceId
  const setSelectedSpaceId = (spaceId: string | undefined) =>
    setSelection({ initialSpaceId, spaceId })
  const list = settings?.list
  const detail = selectedSpaceId === undefined ? undefined : settings?.details[selectedSpaceId]
  const [loadRevision, setLoadRevision] = useState(0)
  const [commandError, setError] = useState<string>()
  const error =
    commandError ??
    (selectedSpaceId && settings?.errors[`space:${selectedSpaceId}`]) ??
    settings?.errors.list
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const opener = useRef<HTMLElement | null>(null)
  const theme = useCatalogTheme()
  useEffect(() => {
    void runtime?.loadSpaceSettingsList()
  }, [runtime])
  useEffect(() => {
    if (selectedSpaceId) void runtime?.loadSpaceSettings(selectedSpaceId)
  }, [runtime, selectedSpaceId])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  function open(spaceId: string) {
    if (busy) return
    setSelectedSpaceId(spaceId)
    setError(undefined)
    setConfirmArchive(false)
  }
  const save: SaveSpaceSettings = async (command: SpaceSettingsCommand) => {
    if (!detail || !runtime) return undefined
    setBusy(true)
    setError(undefined)
    try {
      const saved = await runtime.changeSpaceSettings(detail.space.id, command)
      setConfirmArchive(false)
      setNotice('Saved')
      return saved
    } catch (error) {
      setError(errorText(error))
      return undefined
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
          onClick={async () => {
            setBusy(true)
            setError(undefined)
            await Promise.all([
              runtime?.loadSpaceSettingsList(),
              selectedSpaceId ? runtime?.loadSpaceSettings(selectedSpaceId) : undefined,
            ])
            setLoadRevision((value) => value + 1)
            setBusy(false)
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
      {selectedSpaceId && !detail && settings?.loading.includes(`space:${selectedSpaceId}`) && (
        <p role="status">Loading Space settings…</p>
      )}
      {section === 'automations' && list && (
        <ReflectionSettingsForm
          key={loadRevision}
          reflection={list.reflection}
          busy={busy}
          save={async (change) => {
            setBusy(true)
            setError(undefined)
            try {
              const saved = await runtime?.changeReflectionSettings(change)
              setNotice('Reflection settings saved')
              return saved
            } catch (error) {
              setError(errorText(error))
              return undefined
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
              selected={selectedSpaceId === space.id}
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
              setSelectedSpaceId(undefined)
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
                  {detail.surfaces
                    .filter((surface) => surface.management === 'automations')
                    .map((surface) => (
                      <SurfaceAutomationOutcomes key={surface.id} surface={surface} />
                    ))}
                  {detail.automations.length === 0 && (
                    <p>No Automations in this Space. You can create one from Chat.</p>
                  )}
                  {detail.automations.map((automation) => (
                    <AutomationSettingsEditor
                      key={`${detail.space.id}:${automation.id}:${loadRevision}`}
                      automation={automation}
                      theme={theme}
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
