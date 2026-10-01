import { inputSetPlan } from './action-builders.ts'
import { describe, expect, it } from 'vitest'
import { AtomNodeSchema, SurfaceSchema } from './index.ts'

const freshness = { updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: 'agent' }

describe('content and data Atom acceptance', () => {
  it('rejects an unsupported prop or a discarded child on every content Atom', () => {
    const candidates = [
      { type: 'Title', props: { text: 'Plan' } },
      { type: 'Text', props: { text: 'Three sessions' } },
      { type: 'Caption', props: { text: 'Start gradually' } },
      { type: 'Label', props: { text: 'Session' } },
      { type: 'Markdown', props: { text: '**Safety:** stop for pain.' } },
      { type: 'ListItem', props: { label: 'Session 1', detail: 'Squat: 3 × 8' } },
      { type: 'Table', props: { columns: ['exercise', 'sets'], rows: [] } },
      { type: 'Stat', props: { label: 'Sessions', value: 3 } },
      { type: 'Progress', props: { label: 'Week', value: 0 } },
      { type: 'Badge', props: { text: 'Ready' } },
      {
        type: 'Automation',
        props: { label: 'Weekly review', schedule: 'Every Monday', enabled: false },
      },
    ]
    for (const candidate of candidates) {
      expect(AtomNodeSchema.safeParse({ id: candidate.type, ...candidate }).success).toBe(true)
      expect(
        AtomNodeSchema.safeParse({
          id: candidate.type,
          ...candidate,
          props: { ...candidate.props, unsupported: true },
        }).success,
      ).toBe(false)
      expect(
        AtomNodeSchema.safeParse({
          id: candidate.type,
          ...candidate,
          children: [{ id: 'discarded', type: 'Text', props: { text: 'Must not disappear' } }],
        }).success,
      ).toBe(false)
    }
  })

  it('requires a content source instead of accepting a title-only empty body', () => {
    for (const type of ['Title', 'Text', 'Caption', 'Label', 'Markdown', 'ListItem', 'Badge']) {
      expect(AtomNodeSchema.safeParse({ id: 'empty', type }).success).toBe(false)
    }
    expect(
      AtomNodeSchema.safeParse({ id: 'table', type: 'Table', props: { columns: ['exercise'] } })
        .success,
    ).toBe(false)
    expect(
      AtomNodeSchema.safeParse({ id: 'stat', type: 'Stat', props: { label: 'Total' } }).success,
    ).toBe(false)
  })

  it('validates bound rows, metric values, progress, text, and automation history', () => {
    const surface = {
      id: 'srf-plan',
      spaceId: 'spc-health',
      title: 'Plan',
      freshness,
      tree: {
        id: 'root',
        type: 'Col',
        children: [
          { id: 'copy', type: 'Text', binding: 'copy' },
          { id: 'table', type: 'Table', binding: 'rows', props: { columns: ['exercise', 'sets'] } },
          { id: 'stat', type: 'Stat', binding: 'total', props: { label: 'Total' } },
          { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
          {
            id: 'automation',
            type: 'Automation',
            binding: 'enabled',
            props: { label: 'Review', schedule: 'Weekly', historyBinding: 'history' },
            actions: [
              { name: 'toggle', path: 'fast', plan: inputSetPlan('enabled', { type: 'boolean' }) },
            ],
          },
        ],
      },
      state: { copy: '', rows: [], total: null, progress: null, enabled: false, history: [] },
    }
    expect(SurfaceSchema.safeParse(surface).success).toBe(true)
    for (const invalidState of [
      { copy: { invisible: 'Text' } },
      { rows: [{ exercise: { hidden: 'Squat' }, sets: 3 }] },
      { rows: [{ exercise: 'Squat' }] },
      { total: { value: 3 } },
      { progress: '75%' },
      { progress: -1 },
      { progress: 101 },
      { enabled: 'true' },
      { history: 'hidden history' },
    ]) {
      expect(
        SurfaceSchema.safeParse({ ...surface, state: { ...surface.state, ...invalidState } })
          .success,
      ).toBe(false)
    }
  })

  it('rejects competing sources and invalid tabular schemas', () => {
    for (const candidate of [
      { type: 'Text', binding: 'copy', props: { text: 'Silently ignored' } },
      { type: 'Stat', binding: 'total', props: { label: 'Total', value: 3 } },
      { type: 'Table', binding: 'rows', props: { columns: ['exercise'], rows: [] } },
      { type: 'Table', props: { columns: [], rows: [] } },
      { type: 'Table', props: { columns: ['exercise', 'exercise'], rows: [] } },
      { type: 'Table', props: { columns: ['exercise'], rows: [{ exercise: [] }] } },
      { type: 'Progress', props: { label: 'Progress', value: -5 } },
      { type: 'Badge', props: { text: 'Ready', tone: 'glowing' } },
      {
        type: 'Automation',
        props: { label: 'Review', schedule: 'Weekly', enabled: true },
        actions: [{ name: 'misspelled' }],
      },
    ]) {
      expect(AtomNodeSchema.safeParse({ id: 'invalid', ...candidate }).success).toBe(false)
    }
  })
})
