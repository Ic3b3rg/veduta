import { describe, expect, it } from 'vitest'
import type { ChatTimelineEntry } from '@veduta/protocol'
import { ChatTimelineProjection } from './chat-timeline-projection.ts'

function entry(position: number, revision = 1, text = `Message ${position}`): ChatTimelineEntry {
  return {
    id: `cte-${position}`,
    turnId: `cht-${position}`,
    scope: { type: 'space', spaceId: 'spc-health' },
    cursor: `cursor-${position}`,
    position,
    revision,
    kind: 'user',
    message: { role: 'user', text },
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    turnState: 'accepted',
  }
}

describe('Chat timeline projection', () => {
  it('merges live and repeated pages by stable identity, revision, and Gateway order', () => {
    const projection = new ChatTimelineProjection()
    const scope = { type: 'space' as const, spaceId: 'spc-health' }
    projection.observe(entry(41, 2, 'New state'))
    projection.mergePage(scope, { entries: [entry(40), entry(41)], nextBefore: 'older-40' })
    projection.mergePage(
      scope,
      { entries: [entry(39), entry(40)], nextBefore: 'older-39' },
      'older-40',
    )
    projection.mergePage(
      scope,
      { entries: [entry(39), entry(40)], nextBefore: 'older-39' },
      'older-40',
    )
    expect(projection.entries(scope).map((item) => item.position)).toEqual([39, 40, 41])
    expect(projection.entries(scope).at(-1)?.message.text).toBe('New state')
    expect(projection.nextBefore(scope)).toBe('older-39')
  })

  it('retains all pages and isolates global, Health, and Work through focus changes', () => {
    const projection = new ChatTimelineProjection()
    const health = { type: 'space' as const, spaceId: 'spc-health' }
    const work = { type: 'space' as const, spaceId: 'spc-work' }
    for (let position = 1; position <= 90; position += 1) projection.observe(entry(position))
    projection.observe({
      ...entry(1),
      id: 'work-1',
      scope: work,
      message: { role: 'user', text: 'Work' },
    })
    projection.observe({
      ...entry(1),
      id: 'global-1',
      scope: { type: 'global' },
      message: { role: 'user', text: 'Global' },
    })
    expect(projection.entries(health)).toHaveLength(90)
    expect(projection.entries(work).map((item) => item.message.text)).toEqual(['Work'])
    expect(projection.entries({ type: 'global' }).map((item) => item.message.text)).toEqual([
      'Global',
    ])
  })
})
