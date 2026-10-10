import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpaceSettings, SpaceSettingsList } from '@veduta/protocol'
import * as api from './api.ts'
import * as settingsApi from './space-settings-api.ts'
import type { GatewayHandlers } from './gateway-client.ts'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

const settings = (instructions = 'Original instructions'): SpaceSettings =>
  fromPartial<SpaceSettings>({
    space: { id: 'spc-health', name: 'Health', slug: 'health', archived: false },
    instructions,
    facts: [],
    automations: [],
    surfaces: [],
  })
const list = (): SpaceSettingsList => ({
  spaces: [settings().space],
  reflection: { enabled: true, time: '03:00', timezone: 'UTC', revision: 'reflection-1' },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup() {
  const connections: GatewayHandlers[] = []
  const fetchSpaceSettings = vi.fn(settingsApi.fetchSpaceSettings).mockResolvedValue(settings())
  const fetchSpaceSettingsList = vi.fn(settingsApi.fetchSpaceSettingsList).mockResolvedValue(list())
  const changeSpaceSettings = vi.fn(settingsApi.changeSpaceSettings)
  const changeReflectionSettings = vi.fn(settingsApi.changeReflectionSettings)
  const runtime = createPwaLiveStateRuntime({
    storage: fromPartial<Storage>({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }),
    api: {
      ...api,
      ...settingsApi,
      fetchAuthStatus: async () => ({
        mode: 'dev',
        bootstrapRequired: false,
        passkeyRegistered: false,
      }),
      fetchSpaces: async () => ({ spaces: [], surfaceCursor: 0 }),
      fetchChatTimeline: async () => ({ entries: [] }),
      fetchPendingDecisions: async () => ({ revision: 0, decisions: [] }),
      fetchSpaceSettings,
      fetchSpaceSettingsList,
      changeSpaceSettings,
      changeReflectionSettings,
      connectGateway: (handlers) => {
        connections.push(handlers)
        return fromPartial<api.GatewayConnection>({ close: () => {} })
      },
    },
  })
  return {
    runtime,
    connections,
    fetchSpaceSettings,
    fetchSpaceSettingsList,
    changeSpaceSettings,
    changeReflectionSettings,
  }
}

afterEach(() => vi.useRealTimers())

it('owns Settings snapshots and repeats an invalidated read when a newer Space write arrives', async () => {
  const { runtime, connections, fetchSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettingsList()
  await runtime.loadSpaceSettings('spc-health')
  expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
    'Original instructions',
  )
  const older = deferred<SpaceSettings>()
  fetchSpaceSettings
    .mockReturnValueOnce(older.promise)
    .mockResolvedValue(settings('Latest instructions'))
  connections[0]!.onSpaceFactsChanged?.({ type: 'space.facts-changed', spaceId: 'spc-health' })
  connections[0]!.onSpaceChanged?.({ type: 'space.changed', spaceId: 'spc-health' })
  older.resolve(settings('Older instructions'))
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
      'Latest instructions',
    ),
  )
  expect(Object.isFrozen(runtime.getSnapshot().spaceSettings.details['spc-health'])).toBe(true)
  runtime.stop()
})

it('refreshes loaded Automation details from Surface events', async () => {
  const { runtime, connections, fetchSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettings('spc-health')
  fetchSpaceSettings.mockResolvedValue({
    ...settings(),
    automations: [fromPartial({ id: 1, enabled: false, revision: 'automation-2' })],
  })
  connections[0]!.onSurfacePatch({
    cursor: 1,
    spaceId: 'spc-health',
    at: '2026-10-10T10:00:00.000Z',
    freshness: { updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'user' },
    patch: {
      surfaceId: 'srf-automations',
      operations: [{ target: 'state', op: 'replace', path: '/enabled', value: false }],
    },
  })
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.automations[0]?.enabled).toBe(
      false,
    ),
  )
  runtime.stop()
})

it('repairs Settings on reconnect and ignores an obsolete connection read', async () => {
  vi.useFakeTimers()
  const { runtime, connections, fetchSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettingsList()
  await runtime.loadSpaceSettings('spc-health')
  const disconnected = deferred<SpaceSettings>()
  fetchSpaceSettings.mockReturnValueOnce(disconnected.promise)
  const pending = runtime.loadSpaceSettings('spc-health')
  connections[0]!.onClose?.()
  fetchSpaceSettings.mockResolvedValue(settings('Saved on another device while offline'))
  await vi.advanceTimersByTimeAsync(1000)
  connections[1]!.onHello(0, 'reconnected')
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
    'Saved on another device while offline',
  )
  disconnected.resolve(settings('Obsolete response'))
  await pending
  expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
    'Saved on another device while offline',
  )
  runtime.stop()
})

it('returns the canonical save despite later refresh failure and prevents an older read undoing it', async () => {
  const { runtime, fetchSpaceSettings, fetchSpaceSettingsList, changeSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettingsList()
  await runtime.loadSpaceSettings('spc-health')
  const older = deferred<SpaceSettings>()
  fetchSpaceSettings
    .mockReturnValueOnce(older.promise)
    .mockResolvedValue(settings('Normalized instructions'))
  const pending = runtime.loadSpaceSettings('spc-health')
  changeSpaceSettings.mockResolvedValue(settings('Normalized instructions'))
  fetchSpaceSettingsList.mockRejectedValue(new Error('List refresh offline'))
  const command = {
    action: 'instructions' as const,
    text: '  Normalized instructions  ',
    expectedText: 'Original instructions',
  }
  const saved = await runtime.changeSpaceSettings('spc-health', command)
  expect(saved.instructions).toBe('Normalized instructions')
  expect(changeSpaceSettings).toHaveBeenCalledWith('spc-health', command, undefined)
  older.resolve(settings('Original instructions'))
  await pending
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.errors.list).toBe('List refresh offline'),
  )
  expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
    'Normalized instructions',
  )
  runtime.stop()
})

it('preserves mutation confirmation during reconnect and never retries a rejected command', async () => {
  const { runtime, connections, changeSpaceSettings, fetchSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettings('spc-health')
  const receipt = deferred<SpaceSettings>()
  changeSpaceSettings.mockReturnValueOnce(receipt.promise)
  const saving = runtime.changeSpaceSettings('spc-health', {
    action: 'instructions',
    text: 'New instructions',
    expectedText: 'Original instructions',
  })
  connections[0]!.onClose?.()
  receipt.resolve(settings('New instructions'))
  expect((await saving).instructions).toBe('New instructions')
  changeSpaceSettings.mockRejectedValueOnce(
    new Error('Instructions changed. Reload before editing.'),
  )
  fetchSpaceSettings.mockResolvedValue(settings('Another device won'))
  await expect(
    runtime.changeSpaceSettings('spc-health', {
      action: 'instructions',
      text: 'Stale edit',
      expectedText: 'Original instructions',
    }),
  ).rejects.toThrow('Instructions changed')
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
      'Another device won',
    ),
  )
  expect(changeSpaceSettings).toHaveBeenCalledTimes(2)
  runtime.stop()
})

it('clears Settings on authentication change and rejects a late mutation receipt from the old session', async () => {
  const { runtime, changeSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettings('spc-health')
  const receipt = deferred<SpaceSettings>()
  changeSpaceSettings.mockReturnValueOnce(receipt.promise)
  const saving = runtime.changeSpaceSettings('spc-health', {
    action: 'instructions',
    text: 'Private edit',
    expectedText: 'Original instructions',
  })
  runtime.authenticate('new-session')
  expect(runtime.getSnapshot().spaceSettings.details).toEqual({})
  receipt.resolve(settings('Private edit'))
  await expect(saving).rejects.toThrow('Settings session changed')
  expect(runtime.getSnapshot().spaceSettings.details).toEqual({})
  runtime.stop()
})

it('keeps a Reflection receipt successful if refreshing a loaded Space fails', async () => {
  const { runtime, changeReflectionSettings, fetchSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettingsList()
  await runtime.loadSpaceSettings('spc-health')
  const saved = {
    ...list(),
    reflection: { ...list().reflection, enabled: false, revision: 'reflection-2' },
  }
  changeReflectionSettings.mockResolvedValue(saved)
  fetchSpaceSettings.mockRejectedValue(new Error('Space refresh offline'))
  const command = { enabled: false, time: '03:00', expectedRevision: 'reflection-1' }
  expect(await runtime.changeReflectionSettings(command)).toEqual(saved)
  expect(changeReflectionSettings).toHaveBeenCalledWith(command, undefined)
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.errors['space:spc-health']).toBe(
      'Space refresh offline',
    ),
  )
  expect(runtime.getSnapshot().spaceSettings.list?.reflection.enabled).toBe(false)
  runtime.stop()
})

it('reconciles a delayed save receipt after a later write was already observed', async () => {
  const { runtime, connections, fetchSpaceSettings, changeSpaceSettings } = setup()
  await runtime.start()
  await runtime.loadSpaceSettings('spc-health')
  const receipt = deferred<SpaceSettings>()
  changeSpaceSettings.mockReturnValueOnce(receipt.promise)
  const saving = runtime.changeSpaceSettings('spc-health', {
    action: 'instructions',
    text: 'My saved instructions',
    expectedText: 'Original instructions',
  })
  fetchSpaceSettings.mockResolvedValue(settings('A later write on another device'))
  connections[0]!.onSpaceChanged?.({ type: 'space.changed', spaceId: 'spc-health' })
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
      'A later write on another device',
    ),
  )
  receipt.resolve(settings('My saved instructions'))
  expect((await saving).instructions).toBe('My saved instructions')
  await vi.waitFor(() =>
    expect(runtime.getSnapshot().spaceSettings.details['spc-health']?.instructions).toBe(
      'A later write on another device',
    ),
  )
  runtime.stop()
})
