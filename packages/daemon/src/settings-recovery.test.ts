import { mkdirSync, mkdtempSync, renameSync, rmSync, writeSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SpaceSettingsListSchema, SYSTEM_SPACE_ID } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpacesEngine } from './spaces-engine.ts'
import { Store } from './store.ts'
import { Scheduler } from './scheduler.ts'
import { buildServer } from './server.ts'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return { ...fs, writeSync: vi.fn(fs.writeSync), renameSync: vi.fn(fs.renameSync) }
})

const roots: string[] = []
const schedulers: Scheduler[] = []
const stores: Store[] = []
const servers: ReturnType<typeof buildServer>[] = []
const now = () => new Date('2030-07-08T10:00:00.000Z')
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close()
  for (const scheduler of schedulers.splice(0)) scheduler.stop()
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-settings-recovery-'))
  roots.push(rootDir)
  const engine = new SpacesEngine({ rootDir, now })
  const space = engine.createSpace({ name: 'Health' })
  return { rootDir, engine, space }
}

function blockLog(rootDir: string, slug: string): () => void {
  const path = join(rootDir, 'spaces', slug, 'log', '2030-07-08.jsonl')
  renameSync(path, `${path}.saved`)
  mkdirSync(path)
  return () => {
    rmSync(path, { recursive: true })
    renameSync(`${path}.saved`, path)
  }
}

describe('evented Settings recovery', () => {
  it('repairs a failed presentation Event before retry succeeds or Agent reasoning resumes', () => {
    const { rootDir, engine, space } = setup()
    const restoreLog = blockLog(rootDir, space.slug)
    expect(() => engine.setSpacePresentation(space.id, 'two-columns')).toThrow(
      'pending Event recovery',
    )
    expect(() => engine.assembleContext(space.id)).toThrow('pending Event recovery')
    restoreLog()
    engine.setSpacePresentation(space.id, 'two-columns')
    expect(engine.getSpace(space.id)?.presentation).toBe('two-columns')
    expect(
      engine.readRecent(space.id).filter((event) => event.type === 'space.presentation'),
    ).toHaveLength(1)
    expect(engine.assembleContext(space.id)).toContain('Space presentation set to two-columns')
  })

  it.each(['instructions', 'archive', 'restore'] as const)(
    'recovers a %s edit and its single Event after restart',
    (kind) => {
      const { rootDir, engine, space } = setup()
      if (kind === 'restore') engine.archiveSpace(space.id)
      const restoreLog = blockLog(rootDir, space.slug)
      const edit = () => {
        if (kind === 'instructions')
          engine.updateInstructions(space.id, 'Be concise', engine.readInstructions(space.id))
        else if (kind === 'archive') engine.archiveSpace(space.id)
        else engine.restoreSpace(space.id)
      }
      expect(edit).toThrow('pending Event recovery')
      restoreLog()
      const reopened = new SpacesEngine({ rootDir, now })
      if (kind === 'instructions') {
        expect(reopened.readInstructions(space.id)).toBe('Be concise')
        expect(
          reopened.readRecent(space.id).filter((event) => event.type === 'space.instructions'),
        ).toHaveLength(1)
      } else {
        expect(reopened.getSpace(space.id)?.archived).toBe(kind === 'archive')
        expect(
          reopened
            .readRecent(space.id)
            .filter(
              (event) =>
                event.type === 'lifecycle' &&
                event.text === (kind === 'archive' ? 'Archived Space' : 'Restored Space'),
            ),
        ).toHaveLength(1)
      }
    },
  )

  it('does not append a duplicate after the original Event was written but delivery failed', async () => {
    const { rootDir, engine, space } = setup()
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(writeSync).mockImplementationOnce((...args) => {
      fs.writeSync(...args)
      throw new Error('Event durability interrupted')
    })
    expect(() => engine.setSpacePresentation(space.id, 'two-columns')).toThrow(
      'pending Event recovery',
    )
    const reopened = new SpacesEngine({ rootDir, now })
    expect(reopened.getSpace(space.id)?.presentation).toBe('two-columns')
    expect(
      reopened.readRecent(space.id).filter((event) => event.type === 'space.presentation'),
    ).toHaveLength(1)
  })

  it('records no ghost Event when the state replacement fails, then recovers the approved change', async () => {
    const { rootDir, engine, space } = setup()
    const path = join(rootDir, 'spaces', space.slug, 'INSTRUCTIONS.md')
    const expected = engine.readInstructions(space.id)
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === path) throw new Error('Instructions replacement interrupted')
      return fs.renameSync(source, destination)
    })
    // Reading the old document and writing the intent succeed; replacing the document fails.
    expect(() => engine.updateInstructions(space.id, 'Be concise', expected)).toThrow(
      'pending Event recovery',
    )
    expect(engine.readInstructions(space.id)).toBe(expected)
    expect(
      engine.readRecent(space.id).filter((event) => event.type === 'space.instructions'),
    ).toHaveLength(0)
    vi.mocked(renameSync).mockImplementation(fs.renameSync)
    const reopened = new SpacesEngine({ rootDir, now })
    reopened.updateInstructions(space.id, 'Be concise', expected)
    expect(reopened.readInstructions(space.id)).toBe('Be concise')
    expect(
      reopened.readRecent(space.id).filter((event) => event.type === 'space.instructions'),
    ).toHaveLength(1)
  })

  it.each(['retry', 'reload', 'restart'] as const)(
    'recognizes only the recovered instructions request after %s',
    (recovery) => {
      const fixture = setup()
      let engine = fixture.engine
      const { rootDir, space } = fixture
      const expected = engine.readInstructions(space.id)
      const restoreLog = blockLog(rootDir, space.slug)
      expect(() => engine.updateInstructions(space.id, 'Be concise', expected)).toThrow(
        'pending Event recovery',
      )
      restoreLog()
      if (recovery === 'restart') engine = new SpacesEngine({ rootDir, now })
      if (recovery === 'reload') engine.reconcileSettings(space.id)
      engine.updateInstructions(space.id, 'Be concise', expected)
      expect(
        engine.readRecent(space.id).filter((event) => event.type === 'space.instructions'),
      ).toHaveLength(1)
      expect(() => engine.updateInstructions(space.id, 'Unrelated stale edit', expected)).toThrow(
        'Instructions changed',
      )
      engine.updateInstructions(space.id, 'Ask before acting', 'Be concise')
      expect(() => engine.updateInstructions(space.id, 'Be concise', expected)).toThrow(
        'Instructions changed',
      )
    },
  )

  it('recovers a failed Scheduler write before claiming the former due schedule', async () => {
    const { rootDir, space } = setup()
    let instant = '2030-07-08T10:00:00.000Z'
    const clock = () => new Date(instant)
    const store = new Store({ rootDir, now: clock })
    stores.push(store)
    const scheduler = new Scheduler({ rootDir, store, now: clock })
    schedulers.push(scheduler)
    const job = scheduler.createJob({
      spaceId: space.id,
      cron: '0 11 * * *',
      briefing: 'Review habits',
    })
    const database = new DatabaseSync(join(rootDir, 'scheduler.sqlite'))
    try {
      database.exec(`create trigger interrupt_settings_write before update of cron on automations
        begin select raise(fail, 'Scheduler state write interrupted'); end`)
      expect(() =>
        scheduler.updateAutomation(space.id, job.id, {
          expectedRevision: scheduler.automationSettingsRevision(job),
          cron: '0 12 * * *',
        }),
      ).toThrow('pending Event recovery')
      expect(scheduler.listAutomations(space.id).find((item) => item.id === job.id)?.cron).toBe(
        '0 11 * * *',
      )
      expect(
        store.eventLog(space.id).filter((event) => event.type === 'automation.edit'),
      ).toHaveLength(0)
      database.exec('drop trigger interrupt_settings_write')
      instant = '2030-07-08T11:00:00.000Z'
      await scheduler.runDue()
      expect(scheduler.automationHistory(space.id, job.id)).toHaveLength(0)
      expect(
        scheduler.listAutomations(space.id).find((item) => item.id === job.id)?.nextRunAt,
      ).toBe('2030-07-08T12:00:00.000Z')
      expect(
        store.eventLog(space.id).filter((event) => event.type === 'automation.edit'),
      ).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('keeps running another Space while an Automation Event is pending recovery', async () => {
    const { rootDir, space } = setup()
    let instant = '2030-07-08T10:00:00.000Z'
    const clock = () => new Date(instant)
    const store = new Store({ rootDir, now: clock })
    stores.push(store)
    const other = store.spacesEngine.createSpace({ name: 'Work' })
    const scheduler = new Scheduler({ rootDir, store, now: clock })
    schedulers.push(scheduler)
    const blocked = scheduler.createJob({
      spaceId: space.id,
      cron: '0 11 * * *',
      briefing: 'Review habits',
    })
    const ready = scheduler.createJob({
      spaceId: other.id,
      cron: '0 11 * * *',
      briefing: 'Review work',
    })
    const restoreLog = blockLog(rootDir, space.slug)
    expect(() =>
      scheduler.updateAutomation(space.id, blocked.id, {
        expectedRevision: scheduler.automationSettingsRevision(blocked),
        enabled: false,
      }),
    ).toThrow('pending Event recovery')
    instant = '2030-07-08T11:00:00.000Z'
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await scheduler.runDue()
    expect(errors).toHaveBeenCalledWith(
      'Automation waiting for Settings recovery',
      expect.any(Error),
    )
    expect(scheduler.automationHistory(other.id, ready.id)).toHaveLength(1)
    expect(
      scheduler.listAutomations(space.id).find((item) => item.id === blocked.id)?.nextRunAt,
    ).toBe('2030-07-08T11:00:00.000Z')
    restoreLog()
    expect(scheduler.automationHistory(space.id, blocked.id)).toHaveLength(0)
  })

  it('preserves an Automation description origin when Settings changes only its enabled state', () => {
    const { rootDir } = setup()
    const store = new Store({ rootDir, now })
    stores.push(store)
    const scheduler = new Scheduler({ rootDir, store, now })
    schedulers.push(scheduler)
    const job = scheduler.createJob(
      { spaceId: 'spc-health', cron: '0 9 * * *', briefing: 'Email-derived task' },
      'untrusted:gmail',
    )
    scheduler.updateAutomation('spc-health', job.id, {
      expectedRevision: scheduler.automationSettingsRevision(job),
      enabled: false,
    })
    expect(
      store.eventLog('spc-health').find((event) => event.type === 'automation.edit')?.origin,
    ).toBe('untrusted:gmail')
  })

  it.each(['retry', 'reload', 'restart'] as const)(
    'recovers an Automation edit through %s',
    (recovery) => {
      const { rootDir, space } = setup()
      let store = new Store({ rootDir, now })
      stores.push(store)
      let scheduler = new Scheduler({ rootDir, store, now })
      schedulers.push(scheduler)
      const job = scheduler.createJob({
        spaceId: space.id,
        cron: '0 9 * * *',
        briefing: 'Review habits',
      })
      const change = {
        expectedRevision: scheduler.automationSettingsRevision(job),
        cron: '30 10 * * *',
        enabled: false,
      }
      const restoreLog = blockLog(rootDir, space.slug)
      expect(() => scheduler.updateAutomation(space.id, job.id, change)).toThrow(
        'pending Event recovery',
      )
      expect(() => store.assembleSpaceContext(space.id)).toThrow('pending Event recovery')
      restoreLog()
      if (recovery === 'restart') {
        scheduler.stop()
        store = new Store({ rootDir, now })
        stores.push(store)
        scheduler = new Scheduler({ rootDir, store, now })
        schedulers.push(scheduler)
      }
      if (recovery === 'reload') store.spacesEngine.reconcileSettings(space.id)
      scheduler.updateAutomation(space.id, job.id, change)
      expect(scheduler.listAutomations(space.id).find((item) => item.id === job.id)).toMatchObject({
        cron: '30 10 * * *',
        enabled: false,
      })
      expect(
        store.eventLog(space.id).filter((event) => event.type === 'automation.edit'),
      ).toHaveLength(1)
      expect(() =>
        scheduler.updateAutomation(space.id, job.id, { ...change, cron: '0 8 * * *' }),
      ).toThrow('Automation changed')
      scheduler.setEnabled(space.id, job.id, true, 'surface')
      expect(() => scheduler.updateAutomation(space.id, job.id, change)).toThrow(
        'Automation changed',
      )
    },
  )

  it.each(['reload', 'restart'] as const)(
    'recovers Reflection configuration, schedule and Event through %s',
    async (recovery) => {
      const { rootDir } = setup()
      let server = buildServer({ dataDir: rootDir, now })
      servers.push(server)
      const listPath = '/api/settings/spaces'
      const original = SpaceSettingsListSchema.parse(
        (await server.app.inject({ method: 'GET', url: listPath })).json(),
      )
      const change = {
        expectedRevision: original.reflection.revision,
        enabled: false,
        time: '03:45',
      }
      const system = server.store.getSpace(SYSTEM_SPACE_ID)!
      const restoreLog = blockLog(rootDir, system.slug)
      const failed = await server.app.inject({
        method: 'POST',
        url: '/api/settings/reflection',
        payload: change,
      })
      expect(failed.statusCode).toBe(503)
      expect(failed.json()).toMatchObject({
        error: expect.stringContaining('pending Event recovery'),
      })
      expect((await server.app.inject({ method: 'GET', url: listPath })).statusCode).toBe(503)
      restoreLog()
      expect(
        server.store.eventLog(system.id).filter((event) => event.type === 'reflection.settings'),
      ).toHaveLength(0)
      if (recovery === 'restart') {
        await server.app.close()
        servers.pop()
        server = buildServer({ dataDir: rootDir, now })
        servers.push(server)
      }
      const reloaded = await server.app.inject({ method: 'GET', url: listPath })
      expect(reloaded.statusCode).toBe(200)
      expect(SpaceSettingsListSchema.parse(reloaded.json()).reflection).toMatchObject({
        enabled: false,
        time: '03:45',
      })
      expect(
        server.scheduler
          .listAutomations(system.id)
          .filter((job) => job.handler === 'reflection')
          .every((job) => job.status === 'cancelled'),
      ).toBe(true)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/settings/reflection',
            payload: change,
          })
        ).statusCode,
      ).toBe(200)
      expect(
        server.store.eventLog(system.id).filter((event) => event.type === 'reflection.settings'),
      ).toHaveLength(1)
      expect(server.store.assembleSpaceContext(system.id)).toContain(
        'Nightly Reflection disabled at 03:45',
      )
    },
  )
})
