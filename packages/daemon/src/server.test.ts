import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { buildServer } from './server.ts'

describe('GET /api/spaces', () => {
  it('returns the seed space with protocol-valid surfaces', async () => {
    const { app } = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { spaces: { slug: string; surfaces: unknown[] }[] }
    expect(body.spaces.map((s) => s.slug)).toEqual(['health'])
    for (const surface of body.spaces[0]!.surfaces) {
      expect(SurfaceSchema.safeParse(surface).success).toBe(true)
    }
  })
})

describe('GET /api/spaces/:id/events', () => {
  it('returns 404 for an unknown space instead of an empty list', async () => {
    const { app } = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/spaces/spc-ghost/events' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/surfaces/:id/actions (fast path)', () => {
  it('mutates the declared stateKey, stamps freshness and logs the event — no LLM involved', async () => {
    const { app, store } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: { nodeId: 'item-milk', name: 'toggle', payload: { value: true } },
    })
    expect(res.statusCode).toBe(200)
    const { surface } = res.json() as { surface: { state: Record<string, unknown> } }
    expect(surface.state['milk']).toBe(true)
    const events = store.eventLog('spc-health')
    expect(events.at(-1)?.text).toContain('milk')
  })

  it('rejects an action the node does not declare as fast (403)', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: { nodeId: 'item-milk', name: 'delete-everything', payload: { value: true } },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects an invocation aimed at a node without fast actions (403)', async () => {
    const { app, store } = buildServer()
    const before = store.getSurface('srf-goal')!.state
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-goal/actions',
      payload: { nodeId: 'current', name: 'toggle', payload: { value: 0 } },
    })
    expect(res.statusCode).toBe(403)
    expect(store.getSurface('srf-goal')!.state).toEqual(before)
  })

  it('rejects a malformed invocation with 400', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: fromPartial({ nodeId: 'item-milk' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for an unknown surface', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-nope/actions',
      payload: { nodeId: 'x', name: 'toggle', payload: { value: 1 } },
    })
    expect(res.statusCode).toBe(404)
  })
})
