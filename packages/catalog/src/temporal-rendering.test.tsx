// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const timestamp = '2026-10-09T04:08:08.751Z'

describe('Surface date presentation', () => {
  it.each([
    ['en-US', 'Oct 9, 2026'],
    ['it-IT', '9 ott 2026'],
  ])(
    'formats existing Health Chart and Table values for %s without rewriting state',
    (locale, date) => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale])
      const surface = SurfaceSchema.parse({
        id: 'srf-health-history',
        spaceId: 'spc-health',
        title: 'Weight history',
        freshness: { updatedAt: timestamp, updatedBy: 'agent' },
        state: { records: [{ at: timestamp, weight: 72 }] },
        tree: {
          id: 'history',
          type: 'Col',
          children: [
            {
              id: 'chart',
              type: 'Chart',
              binding: 'records',
              props: {
                type: 'line',
                xKey: 'at',
                yKey: 'weight',
                label: 'Weight',
                xLabel: 'Recorded',
                yLabel: 'kg',
                emptyText: 'No measurements',
              },
            },
            {
              id: 'table',
              type: 'Table',
              binding: 'records',
              props: { columns: ['at', 'weight'] },
            },
          ],
        },
      })
      const view = render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))

      const times = [...view.container.querySelectorAll('time')]
      expect(times).toHaveLength(2)
      for (const time of times) {
        expect(time.textContent).toContain(date)
        expect(time.textContent).not.toContain(timestamp)
        expect(time.getAttribute('datetime')).toBe(timestamp)
        expect(time.getAttribute('title')).toContain(timestamp)
      }
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain(timestamp)
      expect(surface.state).toEqual({ records: [{ at: timestamp, weight: 72 }] })

      view.unmount()
      render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
      expect(screen.getByRole('table').textContent).toContain(date)
    },
  )

  it('keeps literal, invalid and unzoned inputs intact and shares explicit formats with content values', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    const surface = SurfaceSchema.parse({
      id: 'srf-values',
      spaceId: 'spc-health',
      title: 'Dates and references',
      freshness: { updatedAt: timestamp, updatedBy: 'agent' },
      state: {},
      tree: {
        id: 'values',
        type: 'Col',
        children: [
          {
            id: 'table',
            type: 'Table',
            props: {
              columns: ['value', 'reference'],
              columnFormats: { reference: 'text' },
              rows: [
                { value: '2026-10-09', reference: timestamp },
                { value: '2026-02-30', reference: 'Invalid calendar date' },
                { value: '2026-10-09T04:08:08', reference: 'No timezone' },
                { value: '10/09/2026', reference: 'Ambiguous date' },
                { value: 2026, reference: 'Numeric value' },
                { value: '2026', reference: 'Numeric text' },
                { value: null, reference: 'Unknown' },
              ],
            },
          },
          {
            id: 'stat',
            type: 'Stat',
            props: { label: 'Last day', value: timestamp, valueFormat: 'date' },
          },
          { id: 'copy', type: 'Text', props: { text: timestamp, valueFormat: 'date' } },
          { id: 'literal-copy', type: 'Text', props: { text: timestamp } },
        ],
      },
    })
    const view = render(renderNode(surface.tree, { state: {}, dispatch: vi.fn() }))
    const times = [...view.container.querySelectorAll('time')]
    expect(times).toHaveLength(3)
    expect(times.map((time) => time.textContent)).toEqual([
      'Oct 9, 2026',
      'Oct 9, 2026',
      'Oct 9, 2026',
    ])
    expect(screen.getByRole('cell', { name: timestamp })).toBeDefined()
    for (const literal of ['2026-02-30', '2026-10-09T04:08:08', '10/09/2026', '—'])
      expect(screen.getByRole('cell', { name: literal })).toBeDefined()
    expect(screen.getAllByRole('cell', { name: '2026' })).toHaveLength(2)
    expect(screen.getByText(timestamp, { selector: 'p' })).toBeDefined()
  })

  it('allows a Chart to declare ISO-shaped reference labels as literal text', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-reference',
      spaceId: 'spc-work',
      title: 'References',
      freshness: { updatedAt: timestamp, updatedBy: 'agent' },
      state: { records: [{ id: timestamp, value: 1 }] },
      tree: {
        id: 'references',
        type: 'Chart',
        binding: 'records',
        props: {
          type: 'bar',
          xKey: 'id',
          yKey: 'value',
          xFormat: 'text',
          label: 'References',
          xLabel: 'Reference',
          yLabel: 'Count',
          emptyText: 'No references',
        },
      },
    })
    const view = render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
    expect(view.container.querySelector('time')).toBeNull()
    expect(screen.getAllByText(timestamp).length).toBeGreaterThan(0)
  })
})
