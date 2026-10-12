import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from './auth-store.ts'
import { applyFirstSpace } from './onboarding-step-first-space.ts'
import { buildServer } from './server.ts'
import { Store } from './store.ts'

const roots: string[] = []
const servers: ReturnType<typeof buildServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function start(dataDir: string, profile: 'vps' | 'local-vps') {
  const server = buildServer({
    dataDir,
    profile,
    auth: {
      mode: 'production',
      store: new AuthStore({ mode: 'production', passkeys: fromPartial({}) }),
      allowedOrigins: ['https://veduta.test'],
    },
  })
  servers.push(server)
  return server
}

describe('owner-chosen first Space (issue #244)', () => {
  it('keeps Health empty when the owner explicitly chooses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-first-space-'))
    roots.push(root)
    const first = start(root, 'vps')
    applyFirstSpace({ rootDir: root, spacesEngine: first.store.spacesEngine }, { name: 'Health' })
    await first.app.close()
    servers.pop()

    const reopened = start(root, 'vps')
    expect(reopened.store.getSpace('spc-health')?.name).toBe('Health')
    expect(
      reopened.store.listSurfaces('spc-health').filter((surface) => !surface.management),
    ).toEqual([])
  })

  it('preserves existing Health content when a previously seeded installation restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-first-space-'))
    roots.push(root)
    const existing = new Store({ rootDir: root })
    existing.patchState(
      'srf-goal',
      [{ target: 'state', op: 'add', path: '/ownerNote', value: 'Keep my history' }],
      { updatedBy: 'user' },
    )
    const goal = existing.getStoredSurface('srf-goal')
    existing.close()

    const reopened = start(root, 'vps')
    expect(reopened.store.getSpace('spc-health')?.name).toBe('Health')
    expect(reopened.store.getStoredSurface('srf-goal')).toEqual(goal)
    expect(reopened.store.getStoredSurface('srf-meals')).toBeDefined()
    expect(reopened.store.getStoredSurface('srf-groceries')).toBeDefined()
  })

  it.each(['vps', 'local-vps'] as const)(
    '%s starts with only System and retains the chosen Space after restart',
    async (profile) => {
      const root = mkdtempSync(join(tmpdir(), 'veduta-first-space-'))
      roots.push(root)
      const first = start(root, profile)
      expect(first.store.listSpaces().map((space) => space.id)).toEqual([SYSTEM_SPACE_ID])

      const chosen = applyFirstSpace(
        { rootDir: root, spacesEngine: first.store.spacesEngine },
        { name: 'Home' },
      )
      expect(chosen).toMatchObject({ slug: 'home', created: true })
      await first.app.close()
      servers.pop()

      const reopened = start(root, profile)
      expect(
        reopened.store
          .listSpaces()
          .map((space) => space.id)
          .sort(),
      ).toEqual(['spc-home', SYSTEM_SPACE_ID])
      expect(reopened.store.getStoredSurface('srf-goal')).toBeUndefined()
      expect(reopened.store.getStoredSurface('srf-meals')).toBeUndefined()
      expect(reopened.store.getStoredSurface('srf-groceries')).toBeUndefined()
    },
  )
})
