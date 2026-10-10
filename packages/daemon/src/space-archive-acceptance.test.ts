import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayServerMessageSchema,
  PendingDecisionResolveResultSchema,
  type GatewayClientMessage,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewaySocket } from './gateway.ts'
import { buildServer } from './server.ts'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

const roots: string[] = []
const apps = new Set<ReturnType<typeof buildServer>['app']>()
afterEach(async () => {
  for (const app of apps) await app.close()
  apps.clear()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class RecordingSocket implements GatewaySocket {
  readonly frames: GatewayServerMessage[] = []
  private message: ((raw: Buffer | string) => void) | undefined
  send(raw: string): void {
    this.frames.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }
  on(event: 'message' | 'close', listener: ((raw: Buffer | string) => void) | (() => void)): void {
    if (event === 'message') this.message = listener
  }
  receive(frame: GatewayClientMessage): void {
    this.message?.(JSON.stringify(frame))
  }
}

async function server(dataDir?: string, now?: () => Date) {
  const root = dataDir ?? mkdtempSync(join(tmpdir(), 'veduta-space-archive-acceptance-'))
  if (!dataDir) roots.push(root)
  const built = buildServer({ dataDir: root, ...(now ? { now } : {}) })
  apps.add(built.app)
  await built.app.ready()
  return { ...built, root }
}

async function requestArchive(built: Awaited<ReturnType<typeof server>>, focused = false) {
  const socket = new RecordingSocket()
  built.gateway.connect(socket)
  socket.receive({ type: 'hello', surfaceCursor: built.store.latestSurfaceCursor() })
  socket.receive({
    type: 'chat.send',
    text: focused ? 'Archive this Space' : 'Archive Health',
    ...(focused ? { spaceId: 'spc-health' } : {}),
  })
  await vi.waitFor(
    () => {
      expect(socket.frames.some((frame) => frame.type === 'chat.turn-end')).toBe(true)
    },
    { timeout: 10000 },
  )
  const pending = (await built.pendingDecisions.list()).decisions.find(
    (decision) => decision.kind === 'approval' && decision.state === 'pending',
  )
  if (!pending) throw new Error('Expected an archival approval')
  return { pending, socket }
}

async function resolve(
  built: Awaited<ReturnType<typeof server>>,
  id: string,
  resolution: 'approve' | 'reject',
) {
  const response = await built.app.inject({
    method: 'POST',
    url: `/api/pending-decisions/${encodeURIComponent(id)}/resolve`,
    payload: { resolution },
  })
  expect(response.statusCode).toBe(200)
  return PendingDecisionResolveResultSchema.parse(response.json())
}

describe('Space archival approval through the Gateway', () => {
  it('keeps the requested Space active until a real user approves', async () => {
    const built = await server()
    const other = built.store.spacesEngine.createSpace({ name: 'Work' })
    built.store.spacesEngine.writeFact('spc-health', 'Walk every morning')
    const { pending, socket } = await requestArchive(built)
    expect(built.store.getSpace('spc-health')?.archived).toBe(false)
    expect(pending).toMatchObject({ summary: 'Archive Space “Health”' })
    expect(socket.frames.find((frame) => frame.type === 'chat.turn-end')).toMatchObject({
      message: { pendingDecisions: [{ id: pending.id, state: 'pending' }] },
    })
    const approval = built.trust.listPending()[0]!
    expect(approval.card).toMatchObject({
      level: 'L2',
      editableFields: [],
      showAllowlistCheckbox: false,
    })
    expect(approval.card.summary).toContain('Nothing is permanently deleted')
    await expect(
      built.pendingDecisions.resolve(pending.id, 'approve', 'trusted:agent'),
    ).rejects.toThrow('trusted:user')
    expect(built.store.getSpace('spc-health')?.archived).toBe(false)
    expect(await resolve(built, pending.id, 'approve')).toMatchObject({
      decision: { outcome: 'executed' },
    })
    expect(built.store.getSpace('spc-health')?.archived).toBe(true)
    expect(built.store.getSpace(other.id)?.archived).toBe(false)
    built.store.restoreSpace('spc-health')
    expect(await resolve(built, pending.id, 'approve')).toMatchObject({ replayed: true })
    expect(built.store.getSpace('spc-health')?.archived).toBe(false)
    expect(
      built.store.readFacts('spc-health').active.some((fact) => fact.text === 'Walk every morning'),
    ).toBe(true)
    expect(built.store.getSurface('srf-groceries')).toBeDefined()
  })

  it('preserves a pending request across restart and rejection leaves the Space active', async () => {
    const first = await server()
    const { pending } = await requestArchive(first)
    await first.app.close()
    const reopened = await server(first.root)
    expect(await reopened.pendingDecisions.get(pending.id)).toMatchObject({ state: 'pending' })
    expect(reopened.store.getSpace('spc-health')?.archived).toBe(false)
    expect(await resolve(reopened, pending.id, 'reject')).toMatchObject({
      decision: { outcome: 'rejected' },
    })
    expect(await resolve(reopened, pending.id, 'approve')).toMatchObject({
      replayed: true,
      decision: { outcome: 'rejected' },
    })
    expect(reopened.store.getSpace('spc-health')?.archived).toBe(false)
  })

  it('refuses an old approval after another client archives and restores the Space', async () => {
    const built = await server()
    const { pending } = await requestArchive(built)
    for (const action of ['archive', 'restore']) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/settings/spaces/spc-health',
        payload: { action },
      })
      expect(response.statusCode).toBe(200)
    }
    expect(await resolve(built, pending.id, 'approve')).toMatchObject({
      decision: { outcome: 'failed' },
    })
    expect(built.store.getSpace('spc-health')?.archived).toBe(false)
  })

  it('restores the focused Chat approval after restart and archives once on approval', async () => {
    const first = await server()
    const { pending } = await requestArchive(first, true)
    expect(first.store.getSpace('spc-health')?.archived).toBe(false)
    await first.app.close()
    const reopened = await server(first.root)
    expect(await resolve(reopened, pending.id, 'approve')).toMatchObject({
      decision: { outcome: 'executed' },
    })
    expect(reopened.store.getSpace('spc-health')?.archived).toBe(true)
    expect(
      reopened.store.eventLog('spc-health').filter((event) => event.text === 'Archived Space'),
    ).toHaveLength(1)
  })

  it('cannot approve an expired request or create a standing archival permission', async () => {
    let now = new Date('2030-07-08T10:00:00Z')
    const built = await server(undefined, () => now)
    const { pending } = await requestArchive(built)
    now = new Date('2030-07-08T11:00:00Z')
    expect(await resolve(built, pending.id, 'approve')).toMatchObject({
      decision: { outcome: 'expired' },
    })
    expect(built.store.getSpace('spc-health')?.archived).toBe(false)
    expect(built.trust.listAllowlistRules()).toEqual([])
  })

  it('keeps interrupted approved archival executing until recovery records its actual outcome', async () => {
    const clock = () => new Date('2030-07-08T10:00:00Z')
    const first = await server(undefined, clock)
    const { pending } = await requestArchive(first)
    const path = join(first.root, 'spaces', 'health', 'SPACE.json')
    const fs = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === path) throw new Error('Space metadata replacement interrupted')
      return fs.renameSync(source, destination)
    })
    try {
      const response = await first.app.inject({
        method: 'POST',
        url: `/api/pending-decisions/${encodeURIComponent(pending.id)}/resolve`,
        payload: { resolution: 'approve' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ decision: { state: 'resolving' } })
    } finally {
      vi.mocked(renameSync).mockImplementation(fs.renameSync)
    }
    await first.app.close()
    const reopened = await server(first.root, clock)
    expect(await reopened.pendingDecisions.get(pending.id)).toMatchObject({
      state: 'terminal',
      outcome: 'executed',
    })
    expect(reopened.store.getSpace('spc-health')?.archived).toBe(true)
    expect(
      reopened.store.eventLog('spc-health').filter((event) => event.text === 'Archived Space'),
    ).toHaveLength(1)
    reopened.store.restoreSpace('spc-health')
    expect(await resolve(reopened, pending.id, 'approve')).toMatchObject({ replayed: true })
    expect(reopened.store.getSpace('spc-health')?.archived).toBe(false)
  })
})
