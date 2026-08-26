import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SYSTEM_SPACE_ID, SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { SYSTEM_AUTOMATIONS_SURFACE_ID } from './automations-surface.ts'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'
import { SystemStatusReadError, createSystemChatTools } from './system-chat-tools.ts'
import { ensureSystemSpace } from './system-space.ts'
import { TurnTaintAccumulator } from './taint.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(): { store: Store; scheduler: Scheduler; tools: ToolDef[] } {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-system-chat-tools-'))
  roots.push(rootDir)
  const store = new Store({ rootDir })
  ensureSystemSpace(store.spacesEngine)
  const scheduler = new Scheduler({ rootDir, store })
  return { store, scheduler, tools: createSystemChatTools({ store, scheduler }) }
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing test tool: ${name}`)
  return tool
}

const context = fromPartial<ToolContext>({
  toolCallId: 'call-system-status',
  origin: 'trusted:user',
  taint: new TurnTaintAccumulator(['trusted:user']),
})

describe('createSystemChatTools', () => {
  it('lists and reads only persisted daemon-owned System status Surfaces', async () => {
    const { store, scheduler, tools } = harness()
    const otherSpace = store.spacesEngine.createSpace({ name: 'Other status' })
    store.createSurface(statusSurface('srf-system-legacy', SYSTEM_SPACE_ID), 'job')
    store.createSurface(statusSurface('srf-system-status', SYSTEM_SPACE_ID), 'job', {
      daemonOwned: true,
      contentOrigin: 'untrusted:gmail',
    })
    store.createSurface(statusSurface('srf-other-daemon', otherSpace.id), 'job', {
      daemonOwned: true,
    })

    try {
      const listSurfaces = toolNamed(tools, 'list_surfaces')
      const list = await listSurfaces.handler(listSurfaces.schema.parse({}), context)
      expect(list.details).toEqual({
        surfaces: [
          expect.objectContaining({
            id: 'srf-system-status',
            title: 'srf-system-status',
            pinned: false,
          }),
          expect.objectContaining({
            id: SYSTEM_AUTOMATIONS_SURFACE_ID,
            title: 'Automations',
            pinned: false,
          }),
        ],
      })
      expect(list.origins).toEqual(['untrusted:gmail', 'trusted:system'])

      const readSurface = toolNamed(tools, 'read_surface')
      const read = await readSurface.handler(
        readSurface.schema.parse({ surfaceId: 'srf-system-status' }),
        context,
      )
      expect(read.details).toMatchObject({
        surface: { id: 'srf-system-status', spaceId: SYSTEM_SPACE_ID },
        version: 1,
        treeVersion: 1,
      })
      expect(read.origins).toEqual(['untrusted:gmail'])

      for (const surfaceId of ['srf-system-legacy', 'srf-other-daemon', 'srf-missing']) {
        expect(() => readSurface.handler(readSurface.schema.parse({ surfaceId }), context)).toThrow(
          SystemStatusReadError,
        )
      }
    } finally {
      scheduler.stop()
      store.close()
    }
  })

  it('preserves declared actions, evented presentation preferences, and Gateway refreshes', () => {
    const { store, scheduler } = harness()
    const actionable = SurfaceSchema.parse({
      id: 'srf-system-actions',
      spaceId: SYSTEM_SPACE_ID,
      title: 'System actions',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'toggle',
            type: 'Button',
            props: { label: 'Toggle' },
            actions: [{ name: 'toggle', path: 'fast', stateKey: 'enabled' }],
          },
          {
            id: 'explain',
            type: 'Button',
            props: { label: 'Explain' },
            actions: [{ name: 'explain', path: 'agent', payload: { topic: 'status' } }],
          },
        ],
      },
      state: { enabled: false },
      freshness: { updatedAt: '2026-08-26T10:00:00.000Z', updatedBy: 'job' },
    })
    store.createSurface(actionable, 'job', { daemonOwned: true })
    store.createSurface(statusSurface('srf-system-neighbor', SYSTEM_SPACE_ID), 'job', {
      daemonOwned: true,
    })
    const eventsBefore = store.eventLog(SYSTEM_SPACE_ID).length

    try {
      const fast = store.invokeSurfaceAction(actionable.id, {
        nodeId: 'toggle',
        name: 'toggle',
        payload: { value: true },
      })
      expect(fast).toMatchObject({
        path: 'fast',
        mutation: { surface: { state: { enabled: true } } },
      })

      const agent = store.invokeSurfaceAction(actionable.id, {
        nodeId: 'explain',
        name: 'explain',
      })
      expect(agent).toMatchObject({
        path: 'agent',
        turn: {
          spaceId: SYSTEM_SPACE_ID,
          surfaceId: actionable.id,
          actionName: 'explain',
          payload: { topic: 'status' },
        },
      })

      store.moveSurface(SYSTEM_SPACE_ID, actionable.id, 'up')
      const pin = store.setPinnedWithOrder(actionable.id, true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      expect(pin).toMatchObject({ changed: true, surface: { pinned: true } })
      const refresh = store.patchTree(
        actionable.id,
        [
          {
            target: 'tree',
            op: 'add',
            path: '/children/2',
            value: { id: 'status', type: 'Caption', props: { text: 'Refreshed' } },
          },
        ],
        { expectedTreeVersion: 1, updatedBy: 'job' },
      )
      expect(refresh).toMatchObject({
        surface: { id: actionable.id, pinned: true },
      })
      expect(store.listTreeProposals({ surfaceId: actionable.id })).toEqual([])

      expect(
        store
          .eventLog(SYSTEM_SPACE_ID)
          .slice(eventsBefore)
          .map((event) => event.type),
      ).toEqual(['fast_path', 'agent_path', 'surface.move', 'surface.pin', 'surface.patch_tree'])
    } finally {
      scheduler.stop()
      store.close()
    }
  })
})

function statusSurface(id: string, spaceId: string) {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: id,
    tree: { id: 'root', type: 'Stat', binding: 'status', props: { label: 'Status' } },
    state: { status: 'Ready' },
    freshness: { updatedAt: '2026-08-26T10:00:00.000Z', updatedBy: 'job' },
  })
}
