import { describe, expect, it } from 'vitest'
import { AtomNodeSchema, SurfaceSchema } from './index.ts'

const chartSurface = {
  id: 'srf-distance',
  spaceId: 'spc-health',
  title: 'Distance',
  tree: {
    id: 'distance-chart',
    type: 'Chart',
    binding: 'records',
    props: {
      type: 'line',
      xKey: 'day',
      yKey: 'distance',
      label: 'Daily distance',
      xLabel: 'Day',
      yLabel: 'Distance (km)',
      emptyText: 'No distance recorded yet.',
    },
  },
  state: { records: [{ day: 'Monday', distance: 4 }] },
  freshness: { updatedAt: '2026-09-01T10:00:00.000Z', updatedBy: 'agent' },
}

describe('Chart Surface semantics', () => {
  it.each(['line', 'bar'])('accepts one ordered %s series without rewriting records', (type) => {
    const records = [
      { day: 'Wednesday', distance: -2, note: 'Correction' },
      { day: 'Monday', distance: 0 },
      { day: 3, distance: 4.5 },
    ]
    const surface = SurfaceSchema.parse({
      ...chartSurface,
      tree: { ...chartSurface.tree, props: { ...chartSurface.tree.props, type } },
      state: { records },
    })

    expect(surface.state['records']).toEqual(records)
    if (surface.tree.type !== 'Chart') throw new Error('Chart required')
    expect(surface.tree.props?.['type']).toBe(type)
  })

  it('accepts an explicit empty series with its authored empty state', () => {
    const surface = SurfaceSchema.parse({ ...chartSurface, state: { records: [] } })
    expect(surface.state['records']).toEqual([])
    if (surface.tree.type !== 'Chart') throw new Error('Chart required')
    expect(surface.tree.props?.['emptyText']).toBe('No distance recorded yet.')
  })

  it('rejects a non-numeric y-value instead of accepting a misleading series', () => {
    const result = SurfaceSchema.safeParse({
      ...chartSurface,
      state: { records: [{ day: 'Monday', distance: '4 km' }] },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['state', 'records', 0, 'distance'] }),
      )
    }
  })

  it.each([
    { type: 'pie' },
    { xKey: undefined },
    { yKey: '' },
    { label: '' },
    { xLabel: undefined },
    { yLabel: ' ' },
    { emptyText: undefined },
    { series: [{ yKey: 'distance' }, { yKey: 'other' }] },
    { data: [{ day: 'Monday', distance: 4 }] },
    { stacked: true },
  ])('rejects unsupported or incomplete Chart definitions %#', (props) => {
    expect(
      AtomNodeSchema.safeParse({
        ...chartSurface.tree,
        props: { ...chartSurface.tree.props, ...props },
      }).success,
    ).toBe(false)
  })

  it.each([
    { binding: undefined },
    { actions: [{ name: 'change', path: 'agent' }] },
    { children: [] },
  ])('requires a read-only Chart bound to canonical records %#', (extra) => {
    expect(AtomNodeSchema.safeParse({ ...chartSurface.tree, ...extra }).success).toBe(false)
  })

  it.each([
    null,
    {},
    [null],
    [4],
    [{ distance: 4 }],
    [{ day: '', distance: 4 }],
    [{ day: 'Monday' }],
    [{ day: 'Monday', distance: null }],
    [{ day: 'Monday', distance: true }],
    [{ day: 'Monday', distance: Number.NaN }],
    [{ day: 'Monday', distance: Number.POSITIVE_INFINITY }],
    [[{ day: 'Monday', distance: 4 }]],
  ])('rejects malformed canonical records %#', (records) => {
    expect(SurfaceSchema.safeParse({ ...chartSurface, state: { records } }).success).toBe(false)
  })
})
