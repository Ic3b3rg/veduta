import { SurfaceSchema } from '@veduta/protocol'
import { expect, it } from 'vitest'
import { surfaceFromTemplate, templateFromSurface } from './templates.ts'

it('reuses a strict tabular composition without copying its rows or losing its columns', () => {
  const surface = SurfaceSchema.parse({
    id: 'srf-plan',
    spaceId: 'spc-work',
    title: 'Plan',
    state: { progress: 0.5, total: 3, records: [{ name: 'Private content' }] },
    freshness: { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' },
    tree: {
      id: 'root',
      type: 'Col',
      children: [
        {
          id: 'static-table',
          type: 'Table',
          props: { columns: ['name'], rows: [{ name: 'Private static content' }] },
        },
        { id: 'table', type: 'Table', binding: 'records', props: { columns: ['name'] } },
        { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Completion' } },
        { id: 'stat', type: 'Stat', binding: 'total', props: { label: 'Total' } },
      ],
    },
  })
  const template = templateFromSurface(surface, {
    savedBy: 'pin',
    savedAt: '2026-10-01T08:01:00.000Z',
    origin: 'trusted:user',
  })
  const reused = surfaceFromTemplate(template, {
    surfaceId: 'srf-copy',
    spaceId: 'spc-work',
    updatedAt: '2026-10-01T08:02:00.000Z',
    updatedBy: 'agent',
  })
  expect(reused.tree.children?.[0]?.props).toEqual({ columns: ['name'], rows: [] })
  expect(template.dataProps).toEqual(['static-table.rows'])
  expect(reused.state).toEqual({ progress: null, total: null, records: [] })
  expect(JSON.stringify(template)).not.toContain('Private')
  expect(SurfaceSchema.safeParse(reused).success).toBe(true)
})
