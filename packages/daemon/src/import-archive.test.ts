import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ImportPlan } from '@veduta/protocol'
import { ImportPlanSchema } from '@veduta/protocol'
import {
  NEVER_ARCHIVED,
  buildNotesMarkdown,
  writeImportArchive,
  type WriteImportArchiveResult,
} from './import-archive.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('NEVER_ARCHIVED', () => {
  it('lists exactly the secret and runtime-state names the plan mandates', () => {
    expect([...NEVER_ARCHIVED].sort()).toEqual(
      ['.env', 'auth.json', 'openclaw.json', 'state.db', 'sessions', 'logs', 'pending'].sort(),
    )
  })
})

describe('writeImportArchive', () => {
  it('archives allowed-extension text files, redacted, with restrictive permissions', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'config.yaml'), 'model: claude\nkey: sk-ant-SECRETVALUE-1\n')
    mkdirSync(join(sourceDir, 'skills'))
    writeFileSync(join(sourceDir, 'skills', 'weather.md'), '# Weather skill\n')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived.sort()).toEqual(['config.yaml', join('skills', 'weather.md')].sort())
    expect(result.skipped).toEqual([])

    const configContent = readFileSync(join(archiveDir, 'config.yaml'), 'utf8')
    expect(configContent).not.toContain('sk-ant-SECRETVALUE-1')
    expect(configContent).toContain('[redacted]')
  })

  it('never copies the secret and runtime-state names, listing them as skipped', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-FIXTURESECRET-9\n')
    writeFileSync(join(sourceDir, 'auth.json'), '{"token":"tok"}')
    writeFileSync(join(sourceDir, 'openclaw.json'), '{"key":"x"}')
    writeFileSync(join(sourceDir, 'state.db'), 'binary-ish content')
    mkdirSync(join(sourceDir, 'sessions'))
    writeFileSync(join(sourceDir, 'sessions', 'a.json'), '{}')
    mkdirSync(join(sourceDir, 'logs'))
    writeFileSync(join(sourceDir, 'logs', 'a.txt'), 'log line')
    mkdirSync(join(sourceDir, 'pending'))
    writeFileSync(join(sourceDir, 'pending', 'a.md'), 'pending note')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([])
    const skippedPaths = result.skipped.map((entry) => entry.path)
    expect(skippedPaths).toContain('.env')
    expect(skippedPaths).toContain('auth.json')
    expect(skippedPaths).toContain('openclaw.json')
    expect(skippedPaths).toContain('state.db')
    expect(skippedPaths).toContain('sessions')
    expect(skippedPaths).toContain('logs')
    expect(skippedPaths).toContain('pending')
  })

  it('never copies SOUL.md/USER.md/MEMORY.md or the notes/memory directories (already mapped elsewhere)', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'SOUL.md'), '# SOUL')
    writeFileSync(join(sourceDir, 'USER.md'), '# USER')
    mkdirSync(join(sourceDir, 'memories'))
    writeFileSync(join(sourceDir, 'memories', 'MEMORY.md'), 'stuff')
    writeFileSync(join(sourceDir, 'memories', '2026-01-01.md'), 'note')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([])
  })

  it('A16: never copies OpenClaw workspace/memory/*.md either — the prefix match, not a bare segment match', () => {
    // Before A16, `MAPPED_DIR_NAMES` stored the two-segment string
    // `join('workspace', 'memory')` in a Set and then tested each path
    // *segment* individually against it, so `'workspace/memory'` never
    // equalled either `'workspace'` or `'memory'` alone — the entry could
    // never match anything, and an OpenClaw daily note already imported
    // into the Event log got archived a second time.
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    mkdirSync(join(sourceDir, 'workspace', 'memory'), { recursive: true })
    writeFileSync(join(sourceDir, 'workspace', 'memory', '2026-01-01.md'), 'daily note')
    writeFileSync(join(sourceDir, 'workspace', 'memory', 'topic.md'), 'topic note')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([])
  })

  it('A11: excludes a file whose name looks credential-like even though it is not on the exact-name denylist', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'credentials.json'), '{"key":"x"}')
    writeFileSync(join(sourceDir, 'oauth.txt'), 'oauth stuff')
    writeFileSync(join(sourceDir, 'my-password-notes.md'), 'notes')
    writeFileSync(join(sourceDir, 'config.yaml'), 'model: claude\n')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual(['config.yaml'])
    const skipped = result.skipped.map((entry) => ({ path: entry.path, reason: entry.reason }))
    expect(skipped.find((s) => s.path === 'credentials.json')?.reason).toMatch(/credential-like/)
    expect(skipped.find((s) => s.path === 'oauth.txt')?.reason).toMatch(/credential-like/)
    expect(skipped.find((s) => s.path === 'my-password-notes.md')?.reason).toMatch(
      /credential-like/,
    )
  })

  it('only archives .md/.yaml/.yml/.json/.txt, skipping other extensions', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'notes.md'), 'ok')
    writeFileSync(join(sourceDir, 'cron.yaml'), 'ok')
    writeFileSync(join(sourceDir, 'script.sh'), '#!/bin/sh')
    writeFileSync(join(sourceDir, 'binary.bin'), Buffer.from([0, 1, 2]))

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived.sort()).toEqual(['cron.yaml', 'notes.md'].sort())
    expect(result.skipped.some((entry) => entry.path === 'script.sh')).toBe(true)
    expect(result.skipped.some((entry) => entry.path === 'binary.bin')).toBe(true)
  })

  it('caps recursion depth, listing overflow as skipped rather than silently dropped', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    const deepDir = join(sourceDir, 'a', 'b', 'c', 'd')
    mkdirSync(deepDir, { recursive: true })
    writeFileSync(join(sourceDir, 'a', 'b', 'c', 'shallow.md'), 'within depth 3')
    writeFileSync(join(deepDir, 'toodeep.md'), 'past depth 3')

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([join('a', 'b', 'c', 'shallow.md')])
    expect(result.skipped.some((entry) => entry.path === join('a', 'b', 'c', 'd'))).toBe(true)
  })

  it('caps individual file size at 1 MiB, reporting the overflow', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'huge.md'), 'x'.repeat(1_048_577))

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([])
    expect(result.skipped[0]?.path).toBe('huge.md')
    expect(result.skipped[0]?.reason).toMatch(/1 MiB/)
  })

  it('refuses a symlinked file rather than following it out of the tree', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    const outsideDir = freshDir('veduta-archive-outside-')
    writeFileSync(join(outsideDir, 'secret.md'), 'outside the tree')
    symlinkSync(join(outsideDir, 'secret.md'), join(sourceDir, 'linked.md'))

    const result = writeImportArchive({ sourceDir, archiveDir })

    expect(result.archived).toEqual([])
    expect(result.skipped.some((entry) => entry.path === 'linked.md')).toBe(true)
  })

  it('creates the archive directory and every written file with restrictive permissions', () => {
    const sourceDir = freshDir('veduta-archive-src-')
    const archiveDir = join(freshDir('veduta-archive-dst-'), 'archive')
    writeFileSync(join(sourceDir, 'notes.md'), 'hello')

    writeImportArchive({ sourceDir, archiveDir })

    const dirMode = statMode(archiveDir)
    const fileMode = statMode(join(archiveDir, 'notes.md'))
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
  })
})

// --- buildNotesMarkdown (A17: merged in from the former `import-notes.test.ts`) ---

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return ImportPlanSchema.parse({
    source: 'hermes',
    sourceDir: '/src/hermes',
    options: { overwrite: false, secrets: false },
    items: [],
    warnings: [],
    notMigrated: [],
    blocked: [],
    requiresOverwrite: false,
    ...overrides,
  })
}

function archiveResult(
  overrides: Partial<WriteImportArchiveResult> = {},
): WriteImportArchiveResult {
  return { archived: [], skipped: [], ...overrides }
}

describe('buildNotesMarkdown', () => {
  it('includes the vault set command for a skipped secret, with the root single-quote escaped', () => {
    const notes = buildNotesMarkdown({
      plan: plan({
        items: [
          {
            action: 'skip',
            target: 'vault:anthropic',
            detail: 'ANTHROPIC_API_KEY found in .env',
            reason: 'secret, needs --secrets',
          },
        ],
      }),
      rootDir: "/data/it's-a-test",
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult(),
    })

    expect(notes).toContain(
      "pnpm --filter @veduta/daemon vault set anthropic '<YOUR_VALUE>' --root '/data/it'\\''s-a-test'",
    )
  })

  it('never emits a secret value even if one were (incorrectly) present in an item detail', () => {
    const SECRET = 'sk-ant-SECRETVALUE-1'
    const notes = buildNotesMarkdown({
      plan: plan({
        items: [
          {
            action: 'skip',
            target: 'vault:anthropic',
            detail: 'ANTHROPIC_API_KEY found in .env',
            reason: 'secret, needs --secrets',
          },
        ],
      }),
      rootDir: '/data/veduta',
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult(),
    })
    expect(notes).not.toContain(SECRET)
  })

  it('A17: reports the real archive count, not the plan preview count', () => {
    const notes = buildNotesMarkdown({
      plan: plan(),
      rootDir: '/data/veduta',
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult({ archived: ['config.yaml', 'skills/weather.md', 'a.txt'] }),
    })
    expect(notes).toContain('3 file(s) archived')
    expect(notes).toContain('import-archive/')
  })

  it('A17: lists every skipped archive entry under "Not archived" with its reason', () => {
    const notes = buildNotesMarkdown({
      plan: plan(),
      rootDir: '/data/veduta',
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult({
        skipped: [
          { path: 'credentials.json', reason: 'excluded: filename looks credential-like' },
          { path: 'huge.md', reason: 'exceeds the 1 MiB archive cap' },
        ],
      }),
    })
    expect(notes).toContain('## Not archived')
    expect(notes).toContain('credentials.json')
    expect(notes).toContain('excluded: filename looks credential-like')
    expect(notes).toContain('huge.md')
    expect(notes).toContain('exceeds the 1 MiB archive cap')
  })

  it('lists notMigrated entries under "recreate by hand"', () => {
    const notes = buildNotesMarkdown({
      plan: plan({ notMigrated: ['config.yaml', 'skills'] }),
      rootDir: '/data/veduta',
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult(),
    })
    expect(notes).toContain('config.yaml')
    expect(notes).toContain('skills')
  })

  it('always names what was deliberately never copied, and why', () => {
    const notes = buildNotesMarkdown({
      plan: plan(),
      rootDir: '/data/veduta',
      now: '2026-07-27T00:00:00.000Z',
      archiveResult: archiveResult(),
    })
    expect(notes).toContain('.env')
    expect(notes).toContain('auth.json')
    expect(notes).toContain('openclaw.json')
    expect(notes).toContain('state.db')
    expect(notes).toContain('sessions/')
    expect(notes).toContain('logs/')
  })
})
