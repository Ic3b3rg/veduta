import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ImportSourceMissingError,
  MAX_FILE_BYTES,
  resolveLegacyDir,
  readLegacySource,
} from './import-source.ts'

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

/** Sorted recursive listing of relative file paths, for before/after "nothing written" comparisons. */
function listRecursive(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else {
        out.push(relative(root, abs))
      }
    }
  }
  walk(root)
  return out.sort()
}

function buildHermesFixture(): string {
  const dir = freshDir('veduta-hermes-src-')
  writeFileSync(join(dir, 'SOUL.md'), '# Hermes Soul\nI am a helpful agent.\n')
  mkdirSync(join(dir, 'memories'))
  writeFileSync(join(dir, 'memories', 'USER.md'), '# User\nName: Ada\n')
  writeFileSync(join(dir, 'memories', 'MEMORY.md'), 'Fact one §Fact two\n')
  writeFileSync(join(dir, 'memories', '2026-01-02.md'), 'daily note\n')
  writeFileSync(join(dir, 'memories', 'topic-cats.md'), 'cats are great\n')
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-should-never-be-read\n')
  writeFileSync(join(dir, 'config.yaml'), 'model: foo\n')
  mkdirSync(join(dir, 'skills'))
  return dir
}

function buildOpenclawFixture(): string {
  const dir = freshDir('veduta-openclaw-src-')
  mkdirSync(join(dir, 'workspace'))
  writeFileSync(join(dir, 'workspace', 'SOUL.md'), '# OpenClaw Soul\n')
  writeFileSync(join(dir, 'workspace', 'USER.md'), '# User\nName: Bo\n')
  writeFileSync(join(dir, 'workspace', 'MEMORY.md'), '- durable fact one\n- durable fact two\n')
  mkdirSync(join(dir, 'workspace', 'memory'))
  writeFileSync(join(dir, 'workspace', 'memory', '2026-01-05.md'), 'daily note for jan 5\n')
  writeFileSync(join(dir, 'workspace', 'memory', 'topic-work.md'), 'work notes\n')
  writeFileSync(join(dir, 'workspace', 'AGENTS.md'), 'agents prompt\n')
  writeFileSync(join(dir, 'openclaw.json'), '{"apiKey":"sk-should-never-be-read"}\n')
  mkdirSync(join(dir, 'sessions'))
  return dir
}

describe('resolveLegacyDir', () => {
  it('prefers a staged directory when it exists and has content', () => {
    const home = freshDir('veduta-home-')
    const staged = freshDir('veduta-staged-')
    writeFileSync(join(staged, 'SOUL.md'), 'staged soul\n')
    mkdirSync(join(home, '.hermes'))
    expect(resolveLegacyDir({ kind: 'hermes', stagedDir: staged, home })).toBe(staged)
  })

  it('B8: an empty staged directory (created but nothing staged into it) never shadows a readable live home', () => {
    const home = freshDir('veduta-home-')
    const staged = freshDir('veduta-staged-empty-') // exists, but nothing written into it
    mkdirSync(join(home, '.hermes'))
    expect(resolveLegacyDir({ kind: 'hermes', stagedDir: staged, home })).toBe(
      join(home, '.hermes'),
    )
  })

  it('B8: a staged directory with only a notes/ subdirectory still counts as present', () => {
    const home = freshDir('veduta-home-')
    const staged = freshDir('veduta-staged-notes-only-')
    mkdirSync(join(staged, 'notes'))
    mkdirSync(join(home, '.hermes'))
    expect(resolveLegacyDir({ kind: 'hermes', stagedDir: staged, home })).toBe(staged)
  })

  it('falls back to the home directory when the staged dir is absent', () => {
    const home = freshDir('veduta-home-')
    mkdirSync(join(home, '.hermes'))
    const stagedDir = join(home, 'does-not-exist')
    expect(resolveLegacyDir({ kind: 'hermes', stagedDir, home })).toBe(join(home, '.hermes'))
  })

  it('resolves through the .clawdbot legacy alias', () => {
    const home = freshDir('veduta-home-')
    mkdirSync(join(home, '.clawdbot'))
    expect(resolveLegacyDir({ kind: 'openclaw', home })).toBe(join(home, '.clawdbot'))
  })

  it('resolves through the .moltbot legacy alias', () => {
    const home = freshDir('veduta-home-')
    mkdirSync(join(home, '.moltbot'))
    expect(resolveLegacyDir({ kind: 'openclaw', home })).toBe(join(home, '.moltbot'))
  })

  it('returns undefined when nothing is found, and never throws', () => {
    const home = freshDir('veduta-home-')
    expect(resolveLegacyDir({ kind: 'openclaw', home })).toBeUndefined()
    expect(resolveLegacyDir({ kind: 'hermes' })).toBeUndefined()
  })
})

describe('readLegacySource — hermes', () => {
  it('maps SOUL, USER, MEMORY and notes; finds .env without reading it', () => {
    const dir = buildHermesFixture()
    const snapshot = readLegacySource(dir, 'hermes')

    expect(snapshot.kind).toBe('hermes')
    expect(snapshot.soul?.text).toContain('Hermes Soul')
    expect(snapshot.user?.relPath).toBe('memories/USER.md')
    expect(snapshot.memory?.text).toContain('Fact one')

    const noteNames = snapshot.notes.map((note) => note.relPath).sort()
    expect(noteNames).toEqual(['memories/2026-01-02.md', 'memories/topic-cats.md'])

    const dailyNote = snapshot.notes.find((note) => note.relPath === 'memories/2026-01-02.md')
    expect(dailyNote?.date).toBe('2026-01-02')
    const topicNote = snapshot.notes.find((note) => note.relPath === 'memories/topic-cats.md')
    expect(topicNote?.date).toBeUndefined()

    // `.env` is claimed (excluded from `notMigrated` below) but never
    // exposed on the snapshot itself (A22) — nothing outside this module
    // consumes a `secretFiles` field, `import-secrets.ts` re-scans the
    // source directory independently.
    for (const note of snapshot.notes) {
      expect(note.text).not.toContain('sk-should-never-be-read')
    }
    expect(snapshot.soul?.text).not.toContain('sk-should-never-be-read')
    expect(snapshot.user?.text).not.toContain('sk-should-never-be-read')
    expect(snapshot.memory?.text).not.toContain('sk-should-never-be-read')

    expect(snapshot.notMigrated).toEqual(['config.yaml', 'skills'])
    expect(snapshot.refused).toEqual([])
    expect(snapshot.oversize).toEqual([])
  })
})

describe('readLegacySource — openclaw', () => {
  it('maps workspace/* and dates the daily note from its filename', () => {
    const dir = buildOpenclawFixture()
    const snapshot = readLegacySource(dir, 'openclaw')

    expect(snapshot.kind).toBe('openclaw')
    expect(snapshot.soul?.relPath).toBe('workspace/SOUL.md')
    expect(snapshot.user?.relPath).toBe('workspace/USER.md')
    expect(snapshot.memory?.text).toContain('durable fact one')

    const dailyNote = snapshot.notes.find(
      (note) => note.relPath === 'workspace/memory/2026-01-05.md',
    )
    expect(dailyNote?.date).toBe('2026-01-05')
    const topicNote = snapshot.notes.find(
      (note) => note.relPath === 'workspace/memory/topic-work.md',
    )
    expect(topicNote?.date).toBeUndefined()

    // `openclaw.json` is claimed (excluded from `notMigrated` below) but not
    // exposed on the snapshot itself — see the hermes test's comment (A22).
    expect(snapshot.notMigrated).toEqual(['sessions', 'workspace/AGENTS.md'])
    for (const note of snapshot.notes) {
      expect(note.text).not.toContain('sk-should-never-be-read')
    }
  })
})

describe('readLegacySource — staged flat layout', () => {
  it('resolves and maps a flat staged directory (decision 16)', () => {
    const dir = freshDir('veduta-staged-flat-')
    writeFileSync(join(dir, 'SOUL.md'), '# Flat Soul\n')
    writeFileSync(join(dir, 'USER.md'), '# User\nName: Cy\n')
    writeFileSync(join(dir, 'MEMORY.md'), 'flat fact\n')
    mkdirSync(join(dir, 'notes'))
    writeFileSync(join(dir, 'notes', '2026-02-01.md'), 'flat daily note\n')

    const hermesSnapshot = readLegacySource(dir, 'hermes')
    expect(hermesSnapshot.soul?.relPath).toBe('SOUL.md')
    expect(hermesSnapshot.user?.relPath).toBe('USER.md')
    expect(hermesSnapshot.memory?.relPath).toBe('MEMORY.md')
    expect(hermesSnapshot.notes.map((n) => n.relPath)).toEqual(['notes/2026-02-01.md'])
    expect(hermesSnapshot.notes[0]?.date).toBe('2026-02-01')
    expect(hermesSnapshot.notMigrated).toEqual([])
  })
})

describe('readLegacySource — security hardening', () => {
  it('refuses a symlinked SOUL.md and never leaks the link target contents', () => {
    const dir = buildHermesFixture()
    const outside = freshDir('veduta-outside-')
    const secretTarget = join(outside, 'shadow-like-secret.md')
    writeFileSync(secretTarget, 'THIS-MUST-NEVER-APPEAR-IN-ANY-SNAPSHOT\n')

    // Replace the legit SOUL.md with a symlink pointing outside the tree.
    rmSync(join(dir, 'SOUL.md'))
    symlinkSync(secretTarget, join(dir, 'SOUL.md'))

    const snapshot = readLegacySource(dir, 'hermes')

    expect(snapshot.soul).toBeUndefined()
    expect(snapshot.refused).toEqual(['SOUL.md'])

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('THIS-MUST-NEVER-APPEAR-IN-ANY-SNAPSHOT')
  })

  it('records an oversize file without reading it', () => {
    const dir = buildHermesFixture()
    const bigText = 'x'.repeat(MAX_FILE_BYTES + 1)
    writeFileSync(join(dir, 'memories', 'MEMORY.md'), bigText)

    const snapshot = readLegacySource(dir, 'hermes')

    expect(snapshot.memory).toBeUndefined()
    expect(snapshot.oversize).toEqual(['memories/MEMORY.md'])
  })

  it('throws ImportSourceMissingError for a missing root', () => {
    const parent = freshDir('veduta-missing-parent-')
    const missing = join(parent, 'does-not-exist')
    expect(() => readLegacySource(missing, 'hermes')).toThrow(ImportSourceMissingError)
  })

  it('throws ImportSourceMissingError when the root is not a directory', () => {
    const dir = freshDir('veduta-not-a-dir-')
    const filePath = join(dir, 'not-a-dir')
    writeFileSync(filePath, 'x')
    expect(() => readLegacySource(filePath, 'hermes')).toThrow(ImportSourceMissingError)
  })

  it('never writes anything to the source or to an unrelated target directory', () => {
    const dir = buildHermesFixture()
    const target = freshDir('veduta-target-')
    writeFileSync(join(target, 'placeholder.txt'), 'untouched\n')

    const sourceBefore = listRecursive(dir)
    const targetBefore = listRecursive(target)

    readLegacySource(dir, 'hermes')

    expect(listRecursive(dir)).toEqual(sourceBefore)
    expect(listRecursive(target)).toEqual(targetBefore)
  })
})
