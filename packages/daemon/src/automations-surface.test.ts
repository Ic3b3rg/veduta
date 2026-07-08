import { describe, expect, it } from 'vitest'
import {
  automationIdFromStateKey,
  automationsListNode,
  automationsSurface,
  automationStateKey,
} from './automations-surface.ts'

const space = { id: 'spc-health', slug: 'health' }
const freshness = { updatedAt: '2026-07-08T12:00:00.000Z', updatedBy: 'job' as const }

const reminder = {
  id: 3,
  description: 'Log my weight',
  enabled: true,
  scheduleText: 'once at 2026-07-08 21:00 UTC',
}

describe('automationsSurface', () => {
  it('builds a protocol-valid Surface with one Automation Atom per job', () => {
    const surface = automationsSurface(
      space,
      [reminder, { ...reminder, id: 4, enabled: false }],
      freshness,
    )

    expect(surface.id).toBe('srf-health-automations')
    expect(surface.state).toEqual({ 'job-3': true, 'job-4': false })
    const list = surface.tree.children?.[1]
    expect(list?.id).toBe('automations-list')
    expect(list?.children?.map((node) => node.type)).toEqual(['Automation', 'Automation'])
    expect(list?.children?.[0]?.binding).toBe('job-3')
    expect(list?.children?.[0]?.props).toEqual({
      label: 'Log my weight',
      schedule: 'once at 2026-07-08 21:00 UTC',
    })
  })

  it('declares the toggle as a fast action on the job state key', () => {
    const surface = automationsSurface(space, [reminder], freshness)
    const action = surface.tree.children?.[1]?.children?.[0]?.actions?.[0]
    expect(action).toMatchObject({ name: 'toggle', path: 'fast', stateKey: 'job-3' })
  })

  it('shows an empty-state Caption instead of disappearing', () => {
    const surface = automationsSurface(space, [], freshness)
    expect(surface.tree.children?.[1]?.children?.[0]).toMatchObject({
      type: 'Caption',
      props: { text: 'No automations yet.' },
    })
    expect(surface.state).toEqual({})
  })

  it('round-trips ids through state keys', () => {
    expect(automationStateKey(12)).toBe('job-12')
    expect(automationIdFromStateKey('job-12')).toBe(12)
    expect(automationIdFromStateKey('milk')).toBeUndefined()
  })

  it('keeps the list node id stable for single-op tree refreshes', () => {
    expect(automationsListNode([]).id).toBe('automations-list')
    expect(automationsListNode([reminder]).id).toBe('automations-list')
  })
})
