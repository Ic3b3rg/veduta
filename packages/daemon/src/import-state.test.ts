import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IMPORT_STATE_FILE,
  findImport,
  loadImportState,
  saveImportState,
  type ImportState,
} from './import-state.ts'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-import-state-'))
  tmpDirs.push(dir)
  return dir
}

describe('loadImportState', () => {
  it('returns an empty state when no file exists', () => {
    const dir = freshDir()
    expect(loadImportState(dir)).toEqual({ version: 1, imports: [] })
  })

  it('throws a clear error on corrupt JSON rather than silently resetting', () => {
    const dir = freshDir()
    writeFileSync(join(dir, IMPORT_STATE_FILE), '{ not json')
    expect(() => loadImportState(dir)).toThrow(/invalid JSON in import state/)
  })

  it('throws when the file fails schema validation', () => {
    const dir = freshDir()
    writeFileSync(join(dir, IMPORT_STATE_FILE), JSON.stringify({ version: 2, imports: [] }))
    expect(() => loadImportState(dir)).toThrow()
  })

  it('round-trips a saved state', () => {
    const dir = freshDir()
    const state: ImportState = {
      version: 1,
      imports: [
        {
          source: 'hermes',
          sourceDir: '/home/user/.hermes',
          at: '2026-01-01T00:00:00.000Z',
          spaceId: 'spc-imported',
          factsWritten: 3,
          eventsAppended: 2,
        },
      ],
    }
    saveImportState(dir, state)
    expect(loadImportState(dir)).toEqual(state)
  })
})

describe('saveImportState', () => {
  it('backs up an existing import.json before overwriting it', () => {
    const dir = freshDir()
    saveImportState(dir, { version: 1, imports: [] })
    saveImportState(dir, {
      version: 1,
      imports: [
        {
          source: 'openclaw',
          sourceDir: '/home/user/.openclaw',
          at: '2026-01-02T00:00:00.000Z',
          factsWritten: 1,
          eventsAppended: 0,
        },
      ],
    })
    const backups = readdirSync(dir).filter((entry) =>
      entry.startsWith(`${IMPORT_STATE_FILE}.bak-`),
    )
    expect(backups).toHaveLength(1)
  })

  it('writes the file atomically (no leftover tmp file)', () => {
    const dir = freshDir()
    saveImportState(dir, { version: 1, imports: [] })
    expect(existsSync(join(dir, IMPORT_STATE_FILE))).toBe(true)
    const tmpLeftovers = readdirSync(dir).filter((entry) => entry.includes('.tmp'))
    expect(tmpLeftovers).toHaveLength(0)
  })
})

describe('findImport', () => {
  it('returns undefined when the source was never imported', () => {
    const state: ImportState = { version: 1, imports: [] }
    expect(findImport(state, 'hermes')).toBeUndefined()
  })

  it('returns the only entry for that source', () => {
    const state: ImportState = {
      version: 1,
      imports: [
        {
          source: 'hermes',
          sourceDir: '/x',
          at: '2026-01-01T00:00:00.000Z',
          factsWritten: 1,
          eventsAppended: 0,
        },
      ],
    }
    expect(findImport(state, 'hermes')?.at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns the most recent entry when the same source was imported more than once', () => {
    const state: ImportState = {
      version: 1,
      imports: [
        {
          source: 'hermes',
          sourceDir: '/x',
          at: '2026-01-01T00:00:00.000Z',
          factsWritten: 1,
          eventsAppended: 0,
        },
        {
          source: 'hermes',
          sourceDir: '/x',
          at: '2026-03-01T00:00:00.000Z',
          factsWritten: 5,
          eventsAppended: 2,
        },
        {
          source: 'hermes',
          sourceDir: '/x',
          at: '2026-02-01T00:00:00.000Z',
          factsWritten: 2,
          eventsAppended: 1,
        },
      ],
    }
    expect(findImport(state, 'hermes')?.at).toBe('2026-03-01T00:00:00.000Z')
  })

  it('ignores entries for a different source', () => {
    const state: ImportState = {
      version: 1,
      imports: [
        {
          source: 'openclaw',
          sourceDir: '/x',
          at: '2026-01-01T00:00:00.000Z',
          factsWritten: 1,
          eventsAppended: 0,
        },
      ],
    }
    expect(findImport(state, 'hermes')).toBeUndefined()
  })
})
