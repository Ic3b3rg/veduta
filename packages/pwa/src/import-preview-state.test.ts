import { fromPartial } from '@total-typescript/shoehorn'
import type { ImportItem, ImportPlan } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupImportItems,
  isApplyOffered,
  showsOverwriteToggle,
  startMigrationPreview,
} from './import-preview-state.ts'

function item(overrides: Partial<ImportItem> & Pick<ImportItem, 'action'>): ImportItem {
  return fromPartial<ImportItem>({
    target: 'SOUL.md',
    detail: 'adapted personality',
    ...overrides,
  })
}

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return fromPartial<ImportPlan>({
    source: 'hermes',
    sourceDir: '/data/import-source/hermes',
    options: { overwrite: false, secrets: false },
    items: [],
    warnings: [],
    notMigrated: [],
    blocked: [],
    requiresOverwrite: false,
    ...overrides,
  })
}

describe('groupImportItems', () => {
  it('puts each item under its own action heading', () => {
    const items = [
      item({ action: 'import', target: 'FACTS.md' }),
      item({ action: 'overwrite', target: 'SOUL.md' }),
      item({ action: 'skip', target: 'ANTHROPIC_API_KEY' }),
      item({ action: 'import', target: 'USER.md' }),
    ]

    const grouped = groupImportItems(items)

    expect(grouped.import.map((entry) => entry.target)).toEqual(['FACTS.md', 'USER.md'])
    expect(grouped.overwrite.map((entry) => entry.target)).toEqual(['SOUL.md'])
    expect(grouped.skip.map((entry) => entry.target)).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('returns an empty array (never omits the key) for a group with no items', () => {
    const grouped = groupImportItems([item({ action: 'import' })])

    expect(grouped.overwrite).toEqual([])
    expect(grouped.skip).toEqual([])
  })

  it('groups an empty item list into three empty arrays', () => {
    expect(groupImportItems([])).toEqual({ import: [], overwrite: [], skip: [] })
  })
})

describe('isApplyOffered', () => {
  it('is false when nothing has been previewed yet', () => {
    expect(isApplyOffered(undefined, false)).toBe(false)
  })

  it('is false for a blocked plan even when the overwrite selection matches', () => {
    const blockedPlan = plan({
      blocked: ['SOUL.md exceeds the size limit'],
      options: { overwrite: true, secrets: false },
    })
    expect(isApplyOffered(blockedPlan, true)).toBe(false)
  })

  it('is true once a clean plan matches the current overwrite selection', () => {
    expect(isApplyOffered(plan({ options: { overwrite: false, secrets: false } }), false)).toBe(
      true,
    )
  })

  it('is false when the plan on hand was built for a different overwrite value (stale after toggling)', () => {
    const stalePlan = plan({ options: { overwrite: false, secrets: false } })
    expect(isApplyOffered(stalePlan, true)).toBe(false)
  })
})

describe('showsOverwriteToggle', () => {
  it('mirrors plan.requiresOverwrite', () => {
    expect(showsOverwriteToggle(plan({ requiresOverwrite: true }))).toBe(true)
    expect(showsOverwriteToggle(plan({ requiresOverwrite: false }))).toBe(false)
  })
})

describe('startMigrationPreview', () => {
  it('clears any previous plan and result for the new (source, overwrite) pair', () => {
    // Simulates toggling Overwrite while a plan (and, in principle, a stale
    // result) is already on screen: the fresh preview state must never
    // carry the old plan forward, since
    // `isApplyOffered` would otherwise let Apply run against it before the
    // re-preview for the new toggle value has come back.
    const started = startMigrationPreview('hermes', true)

    expect(started).toEqual({
      source: 'hermes',
      overwrite: true,
      plan: undefined,
      result: undefined,
    })
  })

  it('reflects the requested source and overwrite value, not any previous selection', () => {
    expect(startMigrationPreview('openclaw', false)).toEqual({
      source: 'openclaw',
      overwrite: false,
      plan: undefined,
      result: undefined,
    })
  })
})
