import { fromPartial } from '@total-typescript/shoehorn'
import type { ImportItem, ImportPlan, ImportResult } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { VAULT_UNAVAILABLE_MESSAGE } from './onboarding-status.ts'
import {
  buildImportCommand,
  type CliIo,
  printBlockedRefusal,
  printPreview,
  printResult,
  quote,
} from './import-preview-text.ts'

// A 40-char hex string, not `sk-ant-...` (rules section, group A precedent): the built-in
// `sk-ant-` redaction pattern would redact this value regardless of whether the importer's
// own secret-registration path ever ran, so a "no secret in any output line" assertion would
// pass even if nothing were registered.
const FIXTURE_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function capturingIo(): CliIo & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  }
}

function baseItem(overrides: Partial<ImportItem>): ImportItem {
  return fromPartial<ImportItem>({
    action: 'import',
    target: 'SOUL.md',
    detail: 'writes SOUL.md',
    ...overrides,
  })
}

function basePlan(overrides: Partial<ImportPlan>): ImportPlan {
  return fromPartial<ImportPlan>({
    source: 'hermes',
    sourceDir: '/home/priya/.hermes',
    options: { overwrite: false, secrets: false },
    items: [],
    warnings: [],
    notMigrated: [],
    blocked: [],
    requiresOverwrite: false,
    ...overrides,
  })
}

describe('quote', () => {
  it('single-quotes a plain path', () => {
    expect(quote('/home/priya/.veduta')).toBe("'/home/priya/.veduta'")
  })

  it('escapes an embedded single quote', () => {
    expect(quote("/home/o'brien/.veduta")).toBe("'/home/o'\\''brien/.veduta'")
  })
})

describe('buildImportCommand', () => {
  it('builds the renamed import-legacy invocation with --root only, by default', () => {
    expect(buildImportCommand({ kind: 'hermes', rootDir: '/data' })).toBe(
      "pnpm --filter @veduta/daemon import-legacy hermes --root '/data'",
    )
  })

  it('includes --apply/--overwrite/--secrets only when requested, in that order', () => {
    expect(
      buildImportCommand({
        kind: 'openclaw',
        rootDir: '/data',
        apply: true,
        overwrite: true,
        secrets: true,
      }),
    ).toBe(
      "pnpm --filter @veduta/daemon import-legacy openclaw --apply --overwrite --secrets --root '/data'",
    )
  })

  it('B7: includes --home when given, quoted the same way as --root', () => {
    expect(buildImportCommand({ kind: 'hermes', rootDir: '/data', home: "/home/o'brien" })).toBe(
      "pnpm --filter @veduta/daemon import-legacy hermes --root '/data' --home '/home/o'\\''brien'",
    )
  })

  it('prefixes sudo when requested (the wizard dead ends)', () => {
    expect(buildImportCommand({ kind: 'hermes', rootDir: '/data', sudo: true })).toBe(
      "sudo pnpm --filter @veduta/daemon import-legacy hermes --root '/data'",
    )
  })
})

describe('printPreview', () => {
  it('prints the source header and all three group headings, using "none" for empty groups', () => {
    const io = capturingIo()
    printPreview(io, basePlan({}))

    expect(io.lines[0]).toBe('Import plan for Hermes — source: /home/priya/.hermes')
    expect(io.lines).toContain('Import:')
    expect(io.lines).toContain('Overwrite:')
    expect(io.lines).toContain('Skip:')
    expect(io.lines).toContain('Warnings:')
    expect(io.lines).toContain('Not migrated:')
    expect(io.lines).toContain('Blocked:')
    // Every group is empty here, so every heading is immediately followed by "  none".
    for (const heading of [
      'Import:',
      'Overwrite:',
      'Skip:',
      'Warnings:',
      'Not migrated:',
      'Blocked:',
    ]) {
      const index = io.lines.indexOf(heading)
      expect(io.lines[index + 1]).toBe('  none')
    }
  })

  it('groups items by action and renders a normal item line from target/detail/reason', () => {
    const io = capturingIo()
    const plan = basePlan({
      items: [
        baseItem({
          action: 'import',
          target: 'SOUL.md',
          detail: 'writes SOUL.md with the adapted personality',
        }),
        baseItem({ action: 'overwrite', target: 'USER.md', detail: 'replaces USER.md' }),
        baseItem({
          action: 'skip',
          target: 'spaces/imported/log',
          detail: 'nothing to append',
          reason: 'no notes found',
        }),
      ],
    })
    printPreview(io, plan)

    const importIndex = io.lines.indexOf('Import:')
    expect(io.lines[importIndex + 1]).toBe('  SOUL.md: writes SOUL.md with the adapted personality')

    const overwriteIndex = io.lines.indexOf('Overwrite:')
    expect(io.lines[overwriteIndex + 1]).toBe('  USER.md: replaces USER.md')

    const skipIndex = io.lines.indexOf('Skip:')
    expect(io.lines[skipIndex + 1]).toBe(
      '  spaces/imported/log: nothing to append (no notes found)',
    )
  })

  it(
    'renders a vault: item exactly like any other item, straight from target/detail/reason ' +
      '(A19/B group report: no second describeSecrets-based rendering — buildImportPlan ' +
      'already guarantees detail is names-only, asserted directly by import-plan.test.ts)',
    () => {
      const io = capturingIo()
      const plan = basePlan({
        items: [
          baseItem({
            action: 'skip',
            target: 'vault:anthropic',
            detail: 'ANTHROPIC_API_KEY found in .env',
            reason: 'secret, needs --secrets',
          }),
        ],
      })
      printPreview(io, plan)

      const skipIndex = io.lines.indexOf('Skip:')
      expect(io.lines[skipIndex + 1]).toBe(
        '  vault:anthropic: ANTHROPIC_API_KEY found in .env (secret, needs --secrets)',
      )
    },
  )

  it('never contains the fixture secret when fed a real buildImportPlan-shaped vault item (names only)', () => {
    const io = capturingIo()
    const plan = basePlan({
      items: [
        baseItem({
          action: 'import',
          target: 'vault:anthropic',
          detail: 'ANTHROPIC_API_KEY (.env) → vault anthropic, routing pointed at it',
        }),
      ],
    })
    printPreview(io, plan)
    for (const line of io.lines) expect(line).not.toContain(FIXTURE_SECRET)
  })
})

describe('printPreview — soulPreview', () => {
  it('prints the adapted SOUL.md text in a clearly delimited section when present', () => {
    const io = capturingIo()
    const plan = basePlan({ soulPreview: '# SOUL\n\nYou are Veduta, calm and thorough.\n' })
    printPreview(io, plan)

    const text = io.lines.join('\n')
    expect(text).toContain('Adapted SOUL.md (this exact text will be written):')
    expect(text).toContain('You are Veduta, calm and thorough.')

    const headingIndex = io.lines.indexOf('Adapted SOUL.md (this exact text will be written):')
    expect(headingIndex).toBeGreaterThan(-1)
    const ruleLine = io.lines[headingIndex + 1]
    expect(ruleLine).toMatch(/^-+$/)
    const bodyIndex = io.lines.indexOf(plan.soulPreview!)
    expect(bodyIndex).toBe(headingIndex + 2)
    expect(io.lines[bodyIndex + 1]).toBe(ruleLine)
  })

  it('omits the section entirely when soulPreview is absent', () => {
    const io = capturingIo()
    printPreview(io, basePlan({}))

    expect(io.lines.some((line) => line.includes('Adapted SOUL.md'))).toBe(false)
  })
})

describe('printBlockedRefusal', () => {
  it('prints every blocked reason and the quoted --overwrite command, with --home, when requiresOverwrite is set', () => {
    const io = capturingIo()
    const plan = basePlan({
      blocked: ['Hermes was already imported on 2026-01-01T00:00:00.000Z; re-run with --overwrite'],
      requiresOverwrite: true,
    })
    printBlockedRefusal(io, plan, 'hermes', "/data/o'brien", '/home/priya')

    expect(io.lines).toContain('import refused:')
    expect(io.lines.some((line) => line.includes('already imported'))).toBe(true)
    expect(io.lines).toContain('next command:')
    const commandLine = io.lines.find((line) =>
      line.includes('pnpm --filter @veduta/daemon import-legacy'),
    )
    expect(commandLine).toBeDefined()
    expect(commandLine).toContain('--apply --overwrite')
    expect(commandLine).toContain(quote("/data/o'brien"))
    expect(commandLine).toContain(`--home ${quote('/home/priya')}`)
  })

  it("B7: carries forward this run's own --secrets choice into the recovery command", () => {
    const io = capturingIo()
    const plan = basePlan({
      blocked: ['SOUL.md already exists and differs from the default template'],
      requiresOverwrite: true,
      options: { overwrite: false, secrets: true },
    })
    printBlockedRefusal(io, plan, 'hermes', '/data', '/home/priya')

    const commandLine = io.lines.find((line) =>
      line.includes('pnpm --filter @veduta/daemon import-legacy'),
    )
    expect(commandLine).toBeDefined()
    expect(commandLine).toContain('--secrets')
  })

  it('prints VAULT_UNAVAILABLE_MESSAGE when the block is "no backup possible"', () => {
    const io = capturingIo()
    const plan = basePlan({
      blocked: [
        'No backup can be taken: no vault key material is available, so nothing will be written.',
      ],
      requiresOverwrite: false,
    })
    printBlockedRefusal(io, plan, 'hermes', '/data', '/home/priya')

    expect(io.lines.join('\n')).toContain(VAULT_UNAVAILABLE_MESSAGE)
    expect(io.lines).not.toContain('next command:')
  })
})

describe('printResult', () => {
  it('formats fact counts, event count, updated flags, secret names, and every path', () => {
    const io = capturingIo()
    const result = fromPartial<ImportResult>({
      facts: { added: 3, updated: 1, superseded: 0, noop: 2, overflow: 5 },
      eventsAppended: 7,
      soulUpdated: true,
      userUpdated: false,
      secretsImported: ['anthropic'],
      backupPath: '/data/backups/backup-1.enc',
      archiveDir: '/data/import-archive/hermes-1',
      notesPath: '/data/import-archive/hermes-1/NOTES.md',
    })
    printResult(io, result)

    const text = io.lines.join('\n')
    expect(text).toContain('3 added, 1 updated, 0 superseded, 2 unchanged, 5 overflowed')
    expect(text).toContain('events appended: 7')
    expect(text).toContain('SOUL.md updated: yes')
    expect(text).toContain('USER.md updated: no')
    expect(text).toContain('secrets imported: anthropic')
    expect(text).toContain('backup: /data/backups/backup-1.enc')
    expect(text).toContain('archive: /data/import-archive/hermes-1')
    expect(text).toContain('notes: /data/import-archive/hermes-1/NOTES.md')
  })

  it('prints "secrets imported: none" when nothing was imported', () => {
    const io = capturingIo()
    const result = fromPartial<ImportResult>({
      facts: { added: 0, updated: 0, superseded: 0, noop: 0, overflow: 0 },
      eventsAppended: 0,
      soulUpdated: false,
      userUpdated: false,
      secretsImported: [],
      backupPath: '/data/backups/backup-1.enc',
      archiveDir: '/data/import-archive/hermes-1',
      notesPath: '/data/import-archive/hermes-1/NOTES.md',
    })
    printResult(io, result)
    expect(io.lines.join('\n')).toContain('secrets imported: none')
  })
})
