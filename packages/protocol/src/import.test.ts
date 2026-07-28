import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  ImportActionSchema,
  ImportApplyRequestSchema,
  ImportOptionsSchema,
  ImportPlanSchema,
  ImportPreviewRequestSchema,
  ImportResultSchema,
  ImportSourceKindSchema,
} from './import.ts'
import type { ImportItem, ImportPlan, ImportResult } from './import.ts'

describe('ImportSourceKindSchema', () => {
  it('accepts both documented sources', () => {
    expect(ImportSourceKindSchema.safeParse('openclaw').success).toBe(true)
    expect(ImportSourceKindSchema.safeParse('hermes').success).toBe(true)
  })

  it('rejects an unknown source', () => {
    expect(ImportSourceKindSchema.safeParse('clawdbot').success).toBe(false)
  })
})

describe('ImportActionSchema', () => {
  it('rejects an unknown action', () => {
    expect(ImportActionSchema.safeParse('delete').success).toBe(false)
  })

  it('accepts the three documented actions', () => {
    for (const action of ['import', 'overwrite', 'skip']) {
      expect(ImportActionSchema.safeParse(action).success).toBe(true)
    }
  })
})

describe('ImportOptionsSchema', () => {
  it('defaults overwrite and secrets to false when omitted', () => {
    expect(ImportOptionsSchema.parse({})).toEqual({ overwrite: false, secrets: false })
  })

  it('keeps explicit values', () => {
    expect(ImportOptionsSchema.parse({ overwrite: true, secrets: true })).toEqual({
      overwrite: true,
      secrets: true,
    })
  })
})

describe('ImportPreviewRequestSchema and ImportApplyRequestSchema', () => {
  it('defaults overwrite and secrets to false', () => {
    const parsed = ImportPreviewRequestSchema.parse({ source: 'hermes' })
    expect(parsed).toEqual({ source: 'hermes', overwrite: false, secrets: false })
  })

  it('rejects an unexpected key', () => {
    expect(
      ImportPreviewRequestSchema.safeParse({ source: 'hermes', path: '/home/silvio/.hermes' })
        .success,
    ).toBe(false)
    expect(ImportApplyRequestSchema.safeParse({ source: 'openclaw', extra: true }).success).toBe(
      false,
    )
  })

  it('takes the same shape for preview and apply (option parity)', () => {
    const body = { source: 'openclaw' as const, overwrite: true, secrets: false }
    expect(ImportPreviewRequestSchema.parse(body)).toEqual(ImportApplyRequestSchema.parse(body))
  })
})

describe('ImportItemSchema / ImportPlanSchema', () => {
  const validItem: ImportItem = {
    action: 'import',
    target: 'spaces/imported/FACTS.md',
    detail: '42 facts parsed from memories/MEMORY.md',
    count: 42,
  }

  const validPlan: ImportPlan = {
    source: 'hermes',
    sourceDir: '/data/veduta/import-source/hermes',
    options: { overwrite: false, secrets: false },
    items: [
      validItem,
      {
        action: 'skip',
        target: 'ANTHROPIC_API_KEY',
        detail: 'secret found, needs --secrets',
        reason: 'secrets flag not set',
      },
    ],
    warnings: ['legacy alias .clawdbot resolved'],
    notMigrated: ['sessions/ (runtime state, never migrated)'],
    blocked: [],
    requiresOverwrite: false,
  }

  it('round-trips a valid plan through .parse', () => {
    expect(ImportPlanSchema.parse(validPlan)).toEqual(validPlan)
  })

  it('accepts an alreadyImported marker', () => {
    const withMarker: ImportPlan = {
      ...validPlan,
      alreadyImported: { source: 'hermes', at: '2026-01-01T00:00:00.000Z' },
    }
    expect(ImportPlanSchema.safeParse(withMarker).success).toBe(true)
  })

  it('rejects an alreadyImported.at that is not an ISO datetime', () => {
    const withBadMarker = {
      ...validPlan,
      alreadyImported: { source: 'hermes', at: 'last Tuesday' },
    }
    expect(ImportPlanSchema.safeParse(withBadMarker).success).toBe(false)
  })

  it('accepts a plan without soulPreview (skipped or blocked SOUL)', () => {
    expect(ImportPlanSchema.safeParse(validPlan).success).toBe(true)
    expect('soulPreview' in ImportPlanSchema.parse(validPlan)).toBe(false)
  })

  it('accepts soulPreview as a string carrying the full adapted SOUL.md text', () => {
    const withSoulPreview: ImportPlan = {
      ...validPlan,
      soulPreview: '# SOUL\n\nYou are Veduta...\n',
    }
    const parsed = ImportPlanSchema.safeParse(withSoulPreview)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.soulPreview).toBe(withSoulPreview.soulPreview)
  })

  it('rejects an item with an unknown action', () => {
    const invalid = { ...validItem, action: 'delete' }
    expect(ImportPlanSchema.safeParse({ ...validPlan, items: [invalid] }).success).toBe(false)
  })
})

describe('ImportResultSchema', () => {
  it('round-trips a valid result through .parse', () => {
    const plan: ImportPlan = fromPartial({
      source: 'openclaw',
      sourceDir: '/data/veduta/import-source/openclaw',
      options: { overwrite: false, secrets: true },
      items: [],
      warnings: [],
      notMigrated: [],
      blocked: [],
      requiresOverwrite: false,
    })

    const result: ImportResult = {
      plan,
      backupPath: '/data/veduta/backups/backup-20260101.enc',
      archiveDir: '/data/veduta/import-archive/openclaw-20260101',
      notesPath: '/data/veduta/import-archive/openclaw-20260101/NOTES.md',
      spaceId: 'space-imported',
      facts: { added: 10, updated: 2, superseded: 1, noop: 3, overflow: 0 },
      eventsAppended: 5,
      soulUpdated: true,
      userUpdated: true,
      secretsImported: ['anthropic'],
    }

    expect(ImportResultSchema.parse(result)).toEqual(result)
  })

  it('accepts secretsImported as vault entry names only', () => {
    const result = fromPartial<ImportResult>({
      secretsImported: ['anthropic', 'openai', 'openrouter'],
    })
    expect(
      ImportResultSchema.safeParse({
        plan: fromPartial({
          source: 'hermes',
          sourceDir: '/data/veduta/import-source/hermes',
          options: { overwrite: false, secrets: true },
          items: [],
          warnings: [],
          notMigrated: [],
          blocked: [],
          requiresOverwrite: false,
        }),
        backupPath: '/data/veduta/backups/b.enc',
        archiveDir: '/data/veduta/import-archive/hermes-1',
        notesPath: '/data/veduta/import-archive/hermes-1/NOTES.md',
        facts: { added: 0, updated: 0, superseded: 0, noop: 0, overflow: 0 },
        eventsAppended: 0,
        soulUpdated: false,
        userUpdated: false,
        secretsImported: result.secretsImported,
      }).success,
    ).toBe(true)
  })

  it('rejects a secretsImported entry that is not one of the three provider names', () => {
    // A z.string() here would happily validate a literal secret value that
    // slipped through; ByokProviderSchema makes that impossible to parse.
    expect(
      ImportResultSchema.safeParse(
        fromPartial({
          secretsImported: ['sk-ant-not-a-provider-name'],
        }),
      ).success,
    ).toBe(false)
  })

  it('rejects a negative fact count', () => {
    expect(
      ImportResultSchema.safeParse(
        fromPartial({
          facts: { added: -1, updated: 0, superseded: 0, noop: 0, overflow: 0 },
        }),
      ).success,
    ).toBe(false)
  })
})
