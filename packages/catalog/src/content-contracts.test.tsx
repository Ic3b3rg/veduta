// @vitest-environment jsdom
import { SurfaceSchema, inputSetPlan } from '@veduta/protocol'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

describe('accepted content Atoms', () => {
  it('shows structured sessions and every plan detail through generic Atoms', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-plan',
      spaceId: 'spc-health',
      title: 'Gym plan — 3 days',
      freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
      state: {},
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'title', type: 'Title', props: { text: 'Gym plan — 3 days' } },
          ...[
            ['Session 1 — Strength', 'Squat', '3 × 8', '90 seconds'],
            ['Session 2 — Upper body', 'Row', '3 × 10', '60 seconds'],
            ['Session 3 — Full body', 'Deadlift', '3 × 6', '120 seconds'],
          ].map(([session, exercise, sets, rest], index) => ({
            id: `session-${index}`,
            type: 'Col',
            children: [
              { id: `session-title-${index}`, type: 'Title', props: { text: session, level: 3 } },
              {
                id: `session-table-${index}`,
                type: 'Table',
                props: {
                  caption: session,
                  columns: ['exercise', 'sets', 'rest'],
                  rows: [{ exercise, sets, rest }],
                },
              },
            ],
          })),
          {
            id: 'progression',
            type: 'ListItem',
            props: { label: 'Progression', detail: 'Add one repetition before increasing load.' },
          },
          {
            id: 'safety',
            type: 'Markdown',
            props: {
              text: '**Safety:** stop if you feel sharp pain.\n\n- Warm up for 5 minutes.\n- Keep a rest day between sessions.',
            },
          },
        ],
      },
    })
    render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
    expect(screen.getAllByRole('table')).toHaveLength(3)
    const first = screen.getAllByRole('table')[0]!
    expect(within(first).getByRole('cell', { name: 'Squat' })).toBeDefined()
    expect(within(first).getByRole('cell', { name: '3 × 8' })).toBeDefined()
    expect(within(first).getByRole('cell', { name: '90 seconds' })).toBeDefined()
    expect(screen.getByText('Add one repetition before increasing load.')).toBeDefined()
    expect(screen.getByText('Safety:').tagName).toBe('STRONG')
    expect(screen.getByText('Warm up for 5 minutes.').tagName).toBe('LI')
  })

  it('keeps unknown values distinct from zero and shows empty rows and optional summaries', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-empty',
      spaceId: 'spc-work',
      title: 'Empty values',
      freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
      state: { copy: '', total: null, progress: null, rows: [] },
      tree: {
        id: 'root',
        type: 'Col',
        children: [
          { id: 'copy', type: 'Text', binding: 'copy' },
          {
            id: 'table',
            type: 'Table',
            binding: 'rows',
            props: { columns: ['name'], caption: 'Sessions', emptyText: 'No sessions planned' },
          },
          {
            id: 'stat',
            type: 'Stat',
            binding: 'total',
            props: { label: 'Total', unit: 'kg', detail: 'Waiting for the first value' },
          },
          { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Completion' } },
          {
            id: 'automation',
            type: 'Automation',
            props: { label: 'Review', schedule: 'Weekly', enabled: false },
          },
        ],
      },
    })
    render(renderNode(surface.tree, { state: surface.state, dispatch: vi.fn() }))
    expect(screen.getByText('No content yet')).toBeDefined()
    expect(screen.getByText('No sessions planned')).toBeDefined()
    expect(screen.getAllByText('Not recorded')).toHaveLength(2)
    expect(screen.queryByText('0%')).toBeNull()
    expect(screen.getByText('Waiting for the first value')).toBeDefined()
    expect(screen.getByText('Disabled')).toBeDefined()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders Markdown through React elements without executing raw markup or unsafe links', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-safe',
      spaceId: 'spc-work',
      title: 'Safe text',
      state: {},
      freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
      tree: {
        id: 'safe',
        type: 'Markdown',
        props: {
          text: '# Guidance\n\n**Strong** and `code` with [reference](https://example.com).\n\n<script>window.attacked = true</script>\n\n[unsafe](javascript:alert(1))\n\n```html\n<img src=x onerror=alert(1)>\n```',
        },
      },
    })
    const view = render(renderNode(surface.tree, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('heading', { name: 'Guidance' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'reference' }).getAttribute('href')).toBe(
      'https://example.com',
    )
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull()
    expect(view.container.querySelector('script, img, iframe')).toBeNull()
    expect(screen.getByText('<script>window.attacked = true</script>')).toBeDefined()
    expect(screen.getByText('<img src=x onerror=alert(1)>').tagName).toBe('CODE')
  })

  it('updates Automation run history when only its secondary history binding changes', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-history',
      spaceId: 'spc-work',
      title: 'History',
      freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
      tree: {
        id: 'review',
        type: 'Automation',
        binding: 'enabled',
        props: { label: 'Review', schedule: 'Weekly', historyBinding: 'history' },
        actions: [
          {
            name: 'toggle',
            path: 'fast',
            revision: 'acr-review',
            plan: inputSetPlan('enabled', { type: 'boolean' }),
          },
        ],
      },
      state: { enabled: true, history: [] },
    })
    const dispatch = vi.fn()
    const view = render(renderNode(surface.tree, { state: surface.state, dispatch }))
    expect(screen.queryByText(/Run history/)).toBeNull()
    view.rerender(
      renderNode(surface.tree, {
        state: {
          enabled: true,
          history: [
            {
              id: 'run-1',
              automationId: 1,
              scheduledFor: '2026-10-01T08:00:00.000Z',
              at: '2026-10-01T08:00:01.000Z',
              kind: 'changed',
              summary: 'Plan updated',
            },
          ],
        },
        dispatch,
      }),
    )
    expect(screen.getByText('Run history (1)')).toBeDefined()
    expect(screen.getByText('Plan updated')).toBeDefined()
  })
})
