import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SpaceSettingsSchema,
  SpaceSettingsListSchema,
  SurfaceSchema,
  SYSTEM_SPACE_ID,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from './server.ts'

const fixtures: { root: string; server: ReturnType<typeof buildServer> }[] = []
afterEach(async () => {
  for (const { root, server } of fixtures.splice(0)) {
    await server.app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-space-settings-'))
  const server = buildServer({ dataDir: root })
  fixtures.push({ root, server })
  return server
}
const path = '/api/settings/spaces/spc-health'
describe('Space settings through the authenticated product routes', () => {
  it('projects canonical management identities without hiding a user Surface with the same title', async () => {
    const { app, store } = setup()
    store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-my-facts',
        spaceId: 'spc-health',
        title: 'What I know about you here',
        tree: { id: 'root', type: 'Text', props: { text: 'My own content' } },
        state: {},
        management: 'memory',
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'user' },
      }),
      'user',
    )
    const settings = SpaceSettingsSchema.parse(
      (await app.inject({ method: 'GET', url: path })).json(),
    )
    expect(settings.surfaces.map((surface) => surface.management).sort()).toEqual([
      'automations',
      'memory',
      'reflection',
    ])
    expect(store.getSurface('srf-my-facts')?.management).toBeUndefined()
    const snapshot = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(snapshot.statusCode).toBe(200)
  })

  it('edits canonical facts/instructions, refuses stale instructions and preserves archival contents', async () => {
    const { app, store } = setup()
    const initial = SpaceSettingsSchema.parse(
      (await app.inject({ method: 'GET', url: path })).json(),
    )
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { action: 'fact', text: 'This Space tracks my health' },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: {
            action: 'instructions',
            text: 'Be concise',
            expectedText: initial.instructions,
          },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: {
            action: 'instructions',
            text: 'Stale edit',
            expectedText: initial.instructions,
          },
        })
      ).statusCode,
    ).toBe(409)
    expect(store.assembleSpaceContext('spc-health')).toContain('Be concise')
    expect(store.assembleSpaceContext('spc-health')).toContain('This Space tracks my health')
    expect(
      (await app.inject({ method: 'POST', url: path, payload: { action: 'archive' } })).statusCode,
    ).toBe(200)
    expect(store.listSpaces().some((space) => space.id === 'spc-health')).toBe(false)
    expect(
      (await app.inject({ method: 'POST', url: path, payload: { action: 'restore' } })).statusCode,
    ).toBe(200)
    expect(
      store
        .readFacts('spc-health')
        .active.some((fact) => fact.text === 'This Space tracks my health'),
    ).toBe(true)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/settings/spaces/${SYSTEM_SPACE_ID}`,
          payload: { action: 'archive' },
        })
      ).statusCode,
    ).toBe(409)
  })

  it('edits an Automation schedule with concurrency checks and persists Reflection configuration', async () => {
    const { app, scheduler } = setup()
    const job = scheduler.createJob({
      spaceId: 'spc-health',
      briefing: 'Review habits',
      cron: '0 9 * * *',
    })
    const settings = SpaceSettingsSchema.parse(
      (await app.inject({ method: 'GET', url: path })).json(),
    )
    const revision = settings.automations.find((item) => item.id === job.id)!.revision
    const command = {
      action: 'automation',
      automationId: job.id,
      change: { expectedRevision: revision, cron: '30 10 * * 1-5', enabled: false },
    }
    expect((await app.inject({ method: 'POST', url: path, payload: command })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: path, payload: command })).statusCode).toBe(409)
    expect(
      scheduler.listAutomations('spc-health').find((item) => item.id === job.id),
    ).toMatchObject({ cron: '30 10 * * 1-5', enabled: false })
    const listed = SpaceSettingsListSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/settings/spaces' })).json(),
    )
    const changed = await app.inject({
      method: 'POST',
      url: '/api/settings/reflection',
      payload: { enabled: false, time: '03:45', expectedRevision: listed.reflection.revision },
    })
    expect(changed.statusCode).toBe(200)
    expect(SpaceSettingsListSchema.parse(changed.json()).reflection).toMatchObject({
      enabled: false,
      time: '03:45',
    })
    expect(
      scheduler
        .listAutomations(SYSTEM_SPACE_ID)
        .filter((item) => item.handler === 'reflection')
        .every((item) => item.status === 'cancelled'),
    ).toBe(true)
  })
})
