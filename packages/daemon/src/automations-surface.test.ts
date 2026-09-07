import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  automationIdFromStateKey,
  automationHistoryStateKey,
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
  it('keeps the daemon-private System identity stable when its presentation slug changes', () => {
    const surface = automationsSurface({ id: SYSTEM_SPACE_ID, slug: 'controls' }, [], freshness)

    expect(surface.id).toBe('srf-system-automations')
  })

  it('builds a protocol-valid Surface with one Automation Atom per job', () => {
    const surface = automationsSurface(
      space,
      [reminder, { ...reminder, id: 4, enabled: false }],
      freshness,
    )

    expect(surface.id).toBe('srf-health-automations')
    expect(surface.state).toEqual({
      'job-3': true,
      'history-3': [],
      'job-4': false,
      'history-4': [],
    })
    const list = surface.tree.children?.[1]
    expect(list?.id).toBe('automations-list')
    expect(list?.children?.map((node) => node.type)).toEqual(['Automation', 'Automation'])
    expect(list?.children?.[0]?.binding).toBe('job-3')
    expect(list?.children?.[0]?.props).toEqual({
      label: 'Log my weight',
      schedule: 'once at 2026-07-08 21:00 UTC',
      historyBinding: 'history-3',
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
    expect(automationHistoryStateKey(12)).toBe('history-12')
    expect(automationIdFromStateKey('job-12')).toBe(12)
    expect(automationIdFromStateKey('milk')).toBeUndefined()
  })

  it('keeps the list node id stable for single-op tree refreshes', () => {
    expect(automationsListNode([]).id).toBe('automations-list')
    expect(automationsListNode([reminder]).id).toBe('automations-list')
  })

  it('projects bounded meaningful run history through Surface state', () => {
    const history = [
      {
        id: '3:2026-07-08T21:00:00.000Z',
        automationId: 3,
        scheduledFor: '2026-07-08T21:00:00.000Z',
        kind: 'failed' as const,
        summary: 'Refresh failed',
        at: '2026-07-08T21:00:01.000Z',
      },
    ]
    const node = automationsListNode([
      {
        ...reminder,
        history,
      },
    ])

    expect(node.children?.[0]?.props?.['historyBinding']).toBe('history-3')
    expect(
      automationsSurface(space, [{ ...reminder, history }], freshness).state['history-3'],
    ).toEqual(history)
  })
})
