// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

const surface = SurfaceSchema.parse({
  id: 'srf-distance',
  spaceId: 'spc-health',
  title: 'Distance',
  tree: {
    id: 'chart',
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
})

describe('Chart rendering', () => {
  it('renders the authored labels and a visible line from explicit record keys', () => {
    const view = render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))

    expect(screen.getByText('Daily distance')).toBeDefined()
    expect(screen.getByText('Distance (km)')).toBeDefined()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Monday: 4')
    expect(view.container.querySelector('.recharts-line-dot')).not.toBeNull()
  })

  it('renders a visible bar series with negative and zero values in canonical order', () => {
    const bars = SurfaceSchema.parse({
      ...surface,
      tree: { ...surface.tree, props: { ...surface.tree.props, type: 'bar' } },
      state: {
        records: [
          { day: 'Wednesday', distance: -2 },
          { day: 'Monday', distance: 0 },
          { day: 'Friday', distance: 4.5 },
        ],
      },
    })
    const view = render(renderNode(bars.tree, { state: bars.state, dispatch: vi.fn() }))
    const description = screen.getByRole('img').getAttribute('aria-label')

    expect(description).toContain('Wednesday: -2, Monday: 0, Friday: 4.5')
    expect(view.container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(3)
    expect(view.container.textContent).toContain('-2')
  })

  it.each(['line', 'bar'])('renders the explicit empty text for an empty %s series', (type) => {
    const empty = SurfaceSchema.parse({
      ...surface,
      tree: { ...surface.tree, props: { ...surface.tree.props, type } },
      state: { records: [] },
    })
    const view = render(renderNode(empty.tree, { state: empty.state, dispatch: vi.fn() }))

    expect(screen.getByText('No distance recorded yet.')).toBeDefined()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'No distance recorded yet.',
    )
    expect(view.container.querySelector('svg')).toBeNull()
  })

  it('reconciles an empty series and every visible value with canonical state updates', () => {
    const empty = SurfaceSchema.parse({ ...surface, state: { records: [] } })
    const view = render(renderNode(empty.tree, { state: empty.state, dispatch: vi.fn() }))
    const updated = SurfaceSchema.parse({
      ...surface,
      state: {
        records: [
          { day: 'Monday', distance: 4 },
          { day: 'Tuesday', distance: 7 },
        ],
      },
    })
    view.rerender(renderNode(updated.tree, { state: updated.state, dispatch: vi.fn() }))

    expect(screen.queryByText('No distance recorded yet.')).toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Monday: 4, Tuesday: 7')
    expect(view.container.querySelectorAll('.recharts-line-dot')).toHaveLength(2)
    expect(screen.getByText('7', { selector: 'strong' })).toBeDefined()
  })

  it('exposes corrupt client input visibly instead of hiding invalid records', () => {
    render(renderNode(surface.tree, { state: { records: [{ day: 'Monday' }] }, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toContain('state.records.0.distance')
    expect(screen.getByRole('alert').textContent).toContain('Chart y-values must be finite numbers')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps accepted finite numbers visible even when their range would overflow', () => {
    const extreme = SurfaceSchema.parse({
      ...surface,
      state: {
        records: [
          { day: 'Monday', distance: -Number.MAX_VALUE },
          { day: 'Tuesday', distance: Number.MAX_VALUE },
        ],
      },
    })
    const view = render(renderNode(extreme.tree, { state: extreme.state, dispatch: vi.fn() }))
    const points = [...view.container.querySelectorAll('.recharts-line-dot')]

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'Tuesday: 1.7976931348623157e+308',
    )
    expect(points).toHaveLength(2)
    for (const point of points) {
      const y = Number(point.getAttribute('cy'))
      expect(Number.isFinite(y) && y >= 0 && y <= 200).toBe(true)
    }
  })
})
