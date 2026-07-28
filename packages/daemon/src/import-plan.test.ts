import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportPlanSchema } from '@veduta/protocol'
import { buildImportPlan, type BuildImportPlanInput } from './import-plan.ts'
import {
  IMPORTED_SPACE_SLUG,
  MAX_IMPORTED_FACTS,
  adaptSoul,
  type TargetState,
} from './import-mapping.ts'
import type { LegacySourceSnapshot } from './import-source.ts'
import type { SecretScan } from './import-secrets.ts'

let tmpDirsToClean: string[] = []

afterEach(() => {
  for (const dir of tmpDirsToClean) rmSync(dir, { recursive: true, force: true })
  tmpDirsToClean = []
})

function snapshot(overrides: Partial<LegacySourceSnapshot> = {}): LegacySourceSnapshot {
  return {
    kind: 'hermes',
    dir: '/src/hermes',
    notes: [],
    notMigrated: [],
    oversize: [],
    refused: [],
    ...overrides,
  }
}

function target(overrides: Partial<TargetState> = {}): TargetState {
  return {
    rootDir: '/target/root',
    soulExists: false,
    soulIsDefault: false,
    userHasContent: false,
    importedSpaceExists: false,
    rootIsDirectory: true,
    ...overrides,
  }
}

function secretScan(overrides: Partial<SecretScan> = {}): SecretScan {
  return { importable: [], notImportable: [], unsupported: [], ...overrides }
}

function baseInput(overrides: Partial<BuildImportPlanInput> = {}): BuildImportPlanInput {
  return {
    snapshot: snapshot(),
    secrets: secretScan(),
    target: target(),
    options: { overwrite: false, secrets: false },
    backupAvailable: true,
    ...overrides,
  }
}

describe('buildImportPlan — schema', () => {
  it('always returns a plan that satisfies ImportPlanSchema.parse', () => {
    const plan = buildImportPlan(baseInput())
    expect(() => ImportPlanSchema.parse(plan)).not.toThrow()
  })
})

describe('buildImportPlan — SOUL conflict', () => {
  it('blocks without --overwrite and becomes an overwrite item with it', () => {
    const input = baseInput({
      snapshot: snapshot({ soul: { relPath: 'SOUL.md', text: 'Custom soul.', bytes: 12 } }),
      target: target({ soulExists: true, soulIsDefault: false }),
    })

    const blockedPlan = buildImportPlan(input)
    expect(blockedPlan.blocked.some((line) => line.includes('SOUL.md'))).toBe(true)
    expect(blockedPlan.items.some((item) => item.target === 'SOUL.md')).toBe(false)
    expect(blockedPlan.requiresOverwrite).toBe(true)

    const overwritePlan = buildImportPlan({
      ...input,
      options: { overwrite: true, secrets: false },
    })
    const soulItem = overwritePlan.items.find((item) => item.target === 'SOUL.md')
    expect(soulItem?.action).toBe('overwrite')
    expect(overwritePlan.blocked.some((line) => line.includes('SOUL.md'))).toBe(false)
  })

  it('imports cleanly when the target SOUL.md is absent', () => {
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ soul: { relPath: 'SOUL.md', text: 'Fresh soul.', bytes: 11 } }),
      }),
    )
    const soulItem = plan.items.find((item) => item.target === 'SOUL.md')
    expect(soulItem?.action).toBe('import')
    expect(plan.blocked).toEqual([])
  })
})

describe('buildImportPlan — oversize identity slot', () => {
  it('blocks even with --overwrite, unlike an ordinary conflict', () => {
    const input = baseInput({
      snapshot: snapshot({ oversize: ['SOUL.md'] }),
      options: { overwrite: true, secrets: false },
    })
    const plan = buildImportPlan(input)
    expect(plan.blocked.some((line) => line.includes('SOUL.md'))).toBe(true)
    expect(plan.blocked.some((line) => line.includes('cannot be cleared with --overwrite'))).toBe(
      true,
    )
  })

  it('reports a non-identity oversize note as a warning, not a block', () => {
    const plan = buildImportPlan(baseInput({ snapshot: snapshot({ oversize: ['notes/big.md'] }) }))
    expect(plan.blocked).toEqual([])
    expect(plan.warnings.some((line) => line.includes('notes/big.md'))).toBe(true)
  })
})

describe('buildImportPlan — FACTS overflow', () => {
  it('caps FACTS at MAX_IMPORTED_FACTS and states the overflow count in a warning', () => {
    const bullets = Array.from({ length: MAX_IMPORTED_FACTS + 7 }, (_, i) => `- fact ${i}`).join(
      '\n',
    )
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({
          memory: { relPath: 'MEMORY.md', text: bullets, bytes: bullets.length },
        }),
      }),
    )
    const factsItem = plan.items.find(
      (item) => item.target === `spaces/${IMPORTED_SPACE_SLUG}/FACTS.md`,
    )
    expect(factsItem?.count).toBe(MAX_IMPORTED_FACTS)
    const eventsItem = plan.items.find(
      (item) => item.target === `spaces/${IMPORTED_SPACE_SLUG}/log`,
    )
    expect(eventsItem?.count).toBe(7)
    expect(plan.warnings.some((line) => line.includes('remaining 7'))).toBe(true)
  })
})

describe('buildImportPlan — imported Space conflict', () => {
  it('blocks appending without --overwrite, and appends with it', () => {
    const input = baseInput({
      snapshot: snapshot({
        memory: { relPath: 'MEMORY.md', text: '- one fact', bytes: 10 },
        notes: [
          { relPath: 'memories/2026-01-02.md', text: 'a note', bytes: 6, date: '2026-01-02' },
        ],
      }),
      target: target({ importedSpaceExists: true }),
    })
    const blockedPlan = buildImportPlan(input)
    expect(blockedPlan.blocked.some((line) => line.includes('Imported'))).toBe(true)
    expect(
      blockedPlan.items.some(
        (item) => item.target.startsWith('spaces/imported/') && item.action !== 'skip',
      ),
    ).toBe(false)

    const overwritePlan = buildImportPlan({
      ...input,
      options: { overwrite: true, secrets: false },
    })
    const factsItem = overwritePlan.items.find(
      (item) => item.target === `spaces/${IMPORTED_SPACE_SLUG}/FACTS.md`,
    )
    expect(factsItem?.action).toBe('overwrite')
    const eventsItem = overwritePlan.items.find(
      (item) => item.target === `spaces/${IMPORTED_SPACE_SLUG}/log`,
    )
    expect(eventsItem?.action).toBe('overwrite')
  })
})

describe('buildImportPlan — already imported', () => {
  it('blocks a re-import of the same source without --overwrite, naming source and date', () => {
    const plan = buildImportPlan(
      baseInput({ alreadyImported: { source: 'hermes', at: '2026-01-01T00:00:00.000Z' } }),
    )
    expect(plan.requiresOverwrite).toBe(true)
    expect(
      plan.blocked.some((line) => line.includes('Hermes') && line.includes('2026-01-01')),
    ).toBe(true)
  })

  it('clears with --overwrite when there is no other conflict', () => {
    const plan = buildImportPlan(
      baseInput({
        alreadyImported: { source: 'hermes', at: '2026-01-01T00:00:00.000Z' },
        options: { overwrite: true, secrets: false },
      }),
    )
    expect(plan.blocked).toEqual([])
  })
})

describe('buildImportPlan — hard blocks overwrite cannot clear', () => {
  it('blocks when no backup is available, regardless of --overwrite', () => {
    const plan = buildImportPlan(
      baseInput({ backupAvailable: false, options: { overwrite: true, secrets: false } }),
    )
    expect(plan.blocked.some((line) => line.includes('backup'))).toBe(true)
  })

  it('blocks when source and target directories overlap', () => {
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ dir: '/data/veduta' }),
        target: target({ rootDir: '/data/veduta/nested' }),
      }),
    )
    expect(plan.blocked.some((line) => line.includes('overlap'))).toBe(true)
  })

  it('blocks when the target root is "/"', () => {
    const plan = buildImportPlan(baseInput({ target: target({ rootDir: '/' }) }))
    expect(plan.blocked.some((line) => line.includes('cannot be "/"'))).toBe(true)
  })

  it('blocks when the target root does not exist or is not a directory', () => {
    const plan = buildImportPlan(
      baseInput({ target: target({ rootIsDirectory: false, rootDir: '/does/not/exist' }) }),
    )
    expect(
      plan.blocked.some(
        (line) => line.includes('does not exist') || line.includes('not a directory'),
      ),
    ).toBe(true)
  })
})

describe('buildImportPlan — staged-path overlap exemption', () => {
  it('does not block when the source is the canonical staged directory inside the target root', () => {
    // The installer stages a legacy install *inside* the daemon's own data
    // directory by design, so this exact path
    // is the one overlap that must never refuse. Without the exemption, every staged
    // import on Linux tripped the generic overlap refusal — the existing
    // tests missed it only because macOS `mkdtempSync` returns
    // `/var/folders/…` while `readLegacySource` realpaths to
    // `/private/var/folders/…`, making the prefix comparison accidentally
    // fail to detect the (very real) overlap.
    const realRootDir = realpathSync(mkdtempSync(join(tmpdir(), 'veduta-import-plan-root-')))
    tmpDirsToClean.push(realRootDir)
    const stagedDir = join(realRootDir, 'import-source', 'hermes')
    mkdirSync(stagedDir, { recursive: true })

    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ dir: stagedDir }),
        target: target({ rootDir: realRootDir }),
      }),
    )
    expect(plan.blocked).toEqual([])
  })

  it('still blocks a non-staged overlap even when it sits under the same root', () => {
    const realRootDir = realpathSync(mkdtempSync(join(tmpdir(), 'veduta-import-plan-root-')))
    tmpDirsToClean.push(realRootDir)
    const otherDir = join(realRootDir, 'not-the-staged-dir')
    mkdirSync(otherDir, { recursive: true })

    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ dir: otherDir }),
        target: target({ rootDir: realRootDir }),
      }),
    )
    expect(plan.blocked.some((line) => line.includes('overlap'))).toBe(true)
  })
})

describe('buildImportPlan — secrets', () => {
  it('never lets a secret value reach any item detail, at either flag', () => {
    const SECRET = 'sk-ant-SECRETVALUE-1'
    const scan = secretScan({
      importable: [
        {
          vaultName: 'anthropic',
          sourceKey: 'ANTHROPIC_API_KEY',
          sourceFile: '.env',
          value: SECRET,
        },
      ],
    })

    for (const withSecrets of [true, false]) {
      const plan = buildImportPlan(
        baseInput({ secrets: scan, options: { overwrite: false, secrets: withSecrets } }),
      )
      const serialized = JSON.stringify(plan)
      expect(serialized).not.toContain(SECRET)
      const secretItem = plan.items.find((item) => item.target === 'vault:anthropic')
      expect(secretItem?.action).toBe(withSecrets ? 'import' : 'skip')
    }
  })
})

describe('buildImportPlan — soulPreview', () => {
  it('carries the exact adapted text when a plan writes SOUL.md, so the preview can show it before anything is written', () => {
    const sourceText = 'You are Hermes, calm and thorough.'
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ soul: { relPath: 'SOUL.md', text: sourceText, bytes: 35 } }),
      }),
    )
    expect(plan.soulPreview).toBe(adaptSoul(sourceText, 'hermes'))
  })

  it('also carries the adapted text on an overwrite item, using the source kind', () => {
    const sourceText = 'You are OpenClaw, terse and fast.'
    const input = baseInput({
      snapshot: snapshot({
        kind: 'openclaw',
        soul: { relPath: 'workspace/SOUL.md', text: sourceText, bytes: 34 },
      }),
      target: target({ soulExists: true, soulIsDefault: false }),
      options: { overwrite: true, secrets: false },
    })
    const plan = buildImportPlan(input)
    expect(plan.soulPreview).toBe(adaptSoul(sourceText, 'openclaw'))
  })

  it('is absent when SOUL.md is skipped (no SOUL.md found in the source)', () => {
    const plan = buildImportPlan(baseInput())
    expect(plan.items.find((item) => item.target === 'SOUL.md')?.action).toBe('skip')
    expect(plan.soulPreview).toBeUndefined()
  })

  it('is absent when the SOUL.md conflict is blocked (no --overwrite yet)', () => {
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ soul: { relPath: 'SOUL.md', text: 'Custom soul.', bytes: 12 } }),
        target: target({ soulExists: true, soulIsDefault: false }),
      }),
    )
    expect(plan.blocked.some((line) => line.includes('SOUL.md'))).toBe(true)
    expect(plan.soulPreview).toBeUndefined()
  })
})

describe('buildImportPlan — notMigrated', () => {
  it('combines snapshot.notMigrated with not-importable secret names and unsupported entries', () => {
    const plan = buildImportPlan(
      baseInput({
        snapshot: snapshot({ notMigrated: ['config.yaml'] }),
        secrets: secretScan({
          notImportable: [{ sourceKey: 'TELEGRAM_BOT_TOKEN', sourceFile: '.env' }],
          unsupported: ['.env: line 3 (unsupported syntax)'],
        }),
      }),
    )
    expect(plan.notMigrated).toEqual(
      expect.arrayContaining([
        'config.yaml',
        expect.stringContaining('TELEGRAM_BOT_TOKEN'),
        '.env: line 3 (unsupported syntax)',
      ]),
    )
  })
})
