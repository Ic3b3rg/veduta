import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type JsonObject } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'

const roots: string[] = []
const stores: Store[] = []
const now = () => new Date('2026-10-01T13:00:00.000Z')
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const rootDir of roots.splice(0)) rmSync(rootDir, { recursive: true, force: true })
})

type Control = 'Switch' | 'Combobox' | 'Automation' | 'ListItem'
function setup(type: Control, disabled = false) {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-agent-control-'))
  roots.push(rootDir)
  const store = new Store({ rootDir, now })
  stores.push(store)
  const space = store.spacesEngine.createSpace({ name: 'Review' })
  const surface = store.createSurface(
    SurfaceSchema.parse({
      id: 'srf-agent-control',
      spaceId: space.id,
      title: 'Review preferences',
      tree: {
        id: 'control',
        type,
        ...(type === 'ListItem' ? {} : { binding: 'choice' }),
        props: {
          label: 'Review preference',
          ...(type === 'Switch' || type === 'Combobox' ? { disabled } : {}),
          ...(type === 'Automation' ? { schedule: 'Daily at 09:00' } : {}),
          ...(type === 'Combobox'
            ? {
                options: [
                  { label: 'Quiet', value: 'quiet' },
                  { label: 'Active', value: 'active' },
                ],
              }
            : {}),
        },
        actions: [
          {
            name: type === 'ListItem' ? 'click' : type === 'Combobox' ? 'change' : 'toggle',
            path: 'agent',
            payload: { target: 'review' },
          },
        ],
      },
      state: type === 'ListItem' ? {} : { choice: type === 'Combobox' ? 'quiet' : true },
      freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    }),
    'agent',
  )
  const action = surface.tree.actions?.[0]
  if (!action) throw new Error('expected a declared Action')
  return { store, surface, actionName: action.name }
}

describe('Agent owning interaction validation before execution (issue #146)', () => {
  it('rejects a Switch string value before queueing, changing state, or appending an Event', () => {
    const { store, surface, actionName } = setup('Switch')
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)
    const versionBefore = store.getSurfaceVersion(surface.id)

    expect(() =>
      store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        payload: { target: 'review', value: 'false' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_payload' }))
    expect(store.agentTurns()).toEqual([])
    expect(store.snapshot()).toEqual(before)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
    expect(store.getSurfaceVersion(surface.id)).toEqual(versionBefore)
  })

  it('rejects a disabled Agent Switch before queueing or appending an Event', () => {
    const { store, surface, actionName } = setup('Switch', true)
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)
    expect(() =>
      store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        payload: { target: 'review', value: false },
      }),
    ).toThrowError(expect.objectContaining({ code: 'disabled_control' }))
    expect(store.agentTurns()).toEqual([])
    expect(store.snapshot()).toEqual(before)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })

  it('does not let a command ListItem submit an unrelated payload', () => {
    const { store, surface, actionName } = setup('ListItem')
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)
    expect(() =>
      store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        payload: { target: 'unrelated' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_payload' }))
    expect(store.agentTurns()).toEqual([])
    expect(store.snapshot()).toEqual(before)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })

  it('keeps a scalar owning value separate from the declared fixed payload', () => {
    const { store, surface, actionName } = setup('Switch')
    const before = store.snapshot()
    const eventsBefore = store.eventLog(surface.spaceId)
    expect(() =>
      store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        payload: { target: 'unrelated', value: false },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_payload' }))
    expect(store.agentTurns()).toEqual([])
    expect(store.snapshot()).toEqual(before)
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })

  it.each<{ type: Control; payload: JsonObject | undefined }>([
    { type: 'Switch', payload: undefined },
    { type: 'Automation', payload: { value: 0 } },
    { type: 'Automation', payload: undefined },
    { type: 'Combobox', payload: { value: 'hidden' } },
    { type: 'Combobox', payload: { value: true } },
    { type: 'Combobox', payload: undefined },
    { type: 'Switch', payload: { value: false, extra: true } },
    { type: 'ListItem', payload: { target: 'review', value: false } },
  ])(
    'rejects missing, invalid, or unrelated $type inputs before the request becomes durable',
    ({ type, payload }) => {
      const { store, surface, actionName } = setup(type)
      const before = store.snapshot()
      const eventsBefore = store.eventLog(surface.spaceId)
      expect(() =>
        store.invokeSurfaceAction(surface.id, {
          nodeId: 'control',
          name: actionName,
          ...(payload === undefined ? {} : { payload }),
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_payload' }))
      expect(store.agentTurns()).toEqual([])
      expect(store.snapshot()).toEqual(before)
      expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
    },
  )

  it.each<{ type: Control; payload: JsonObject | undefined; expected: JsonObject }>([
    {
      type: 'Switch',
      payload: { target: 'review', value: false },
      expected: { target: 'review', value: false },
    },
    { type: 'Automation', payload: { value: false }, expected: { target: 'review', value: false } },
    {
      type: 'Combobox',
      payload: { value: 'active' },
      expected: { target: 'review', value: 'active' },
    },
    { type: 'ListItem', payload: undefined, expected: { target: 'review' } },
    { type: 'ListItem', payload: { target: 'review' }, expected: { target: 'review' } },
  ])(
    'queues a valid $type input without prematurely claiming a canonical mutation',
    ({ type, payload, expected }) => {
      const { store, surface, actionName } = setup(type)
      const before = store.snapshot()
      const result = store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        ...(payload === undefined ? {} : { payload }),
        idempotencyKey: 'owning-control-intent',
      })
      expect(result).toMatchObject({ path: 'agent', turn: { status: 'queued', payload: expected } })
      expect(store.snapshot()).toEqual(before)
      expect(
        store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
      ).toHaveLength(1)
      expect(
        store.invokeSurfaceAction(surface.id, {
          nodeId: 'control',
          name: actionName,
          ...(payload === undefined ? {} : { payload }),
          idempotencyKey: 'owning-control-intent',
        }),
      ).toEqual(result)
      expect(store.agentTurns()).toHaveLength(1)
      expect(
        store.eventLog(surface.spaceId).filter((event) => event.type === 'agent_path'),
      ).toHaveLength(1)
    },
  )

  it('rejects a disabled Agent Combobox before queueing its offered value', () => {
    const { store, surface, actionName } = setup('Combobox', true)
    const eventsBefore = store.eventLog(surface.spaceId)
    expect(() =>
      store.invokeSurfaceAction(surface.id, {
        nodeId: 'control',
        name: actionName,
        payload: { value: 'active' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'disabled_control' }))
    expect(store.agentTurns()).toEqual([])
    expect(store.eventLog(surface.spaceId)).toEqual(eventsBefore)
  })
})
