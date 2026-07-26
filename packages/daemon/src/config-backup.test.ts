import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupFile, writeJsonAtomic } from './config-backup.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-config-backup-'))
  return rootDir
}

describe('backupFile', () => {
  it('returns undefined and does nothing when the source does not exist', () => {
    const dir = freshRoot()
    const path = join(dir, 'routing.json')
    expect(backupFile(path)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('copies the source to a name derived from the ISO timestamp', () => {
    const dir = freshRoot()
    const path = join(dir, 'routing.json')
    writeFileSync(path, '{"v":1}')

    const backupPath = backupFile(path, () => new Date('2026-07-24T10:30:00.123Z'))

    expect(backupPath).toBe(`${path}.bak-2026-07-24T10-30-00-123Z`)
    expect(readFileSync(backupPath as string, 'utf8')).toBe('{"v":1}')
    // The source itself is untouched by taking a backup.
    expect(readFileSync(path, 'utf8')).toBe('{"v":1}')
  })

  it('prunes older siblings, keeping exactly the 5 newest', () => {
    const dir = freshRoot()
    const path = join(dir, 'routing.json')
    writeFileSync(path, 'v0')

    const timestamps = [
      '2026-07-24T10-30-00-000Z',
      '2026-07-24T10-31-00-000Z',
      '2026-07-24T10-32-00-000Z',
      '2026-07-24T10-33-00-000Z',
      '2026-07-24T10-34-00-000Z',
      '2026-07-24T10-35-00-000Z',
      '2026-07-24T10-36-00-000Z',
    ]
    let call = 0
    for (const stamp of timestamps) {
      const iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`
      writeFileSync(path, `v${call}`)
      backupFile(path, () => new Date(iso))
      call += 1
    }

    const backups = readdirSync(dir)
      .filter((entry) => entry.startsWith('routing.json.bak-'))
      .sort()
    expect(backups).toHaveLength(5)
    expect(backups[0]).toBe(`routing.json.bak-${timestamps[2]}`)
    expect(backups[4]).toBe(`routing.json.bak-${timestamps[6]}`)
  })
})

describe('writeJsonAtomic', () => {
  it('serializes with trailing newline and 2-space indent, and round-trips', () => {
    const dir = freshRoot()
    const path = join(dir, 'onboarding.json')
    writeJsonAtomic(path, { version: 1, steps: { domain: 'pending' } })

    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toBe(`${JSON.stringify({ version: 1, steps: { domain: 'pending' } }, null, 2)}\n`)
    expect(JSON.parse(raw)).toEqual({ version: 1, steps: { domain: 'pending' } })
  })

  it('creates missing parent directories', () => {
    const dir = freshRoot()
    const path = join(dir, 'nested', 'deeper', 'onboarding.json')
    writeJsonAtomic(path, { ok: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true })
  })

  it('writes the file with mode 0o600', () => {
    const dir = freshRoot()
    const path = join(dir, 'onboarding.json')
    writeJsonAtomic(path, { ok: true })
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('leaves no tmp file behind after a successful write', () => {
    const dir = freshRoot()
    const path = join(dir, 'onboarding.json')
    writeJsonAtomic(path, { ok: true })
    const leftoverTmps = readdirSync(dir).filter((entry) => entry.includes('.tmp'))
    expect(leftoverTmps).toEqual([])
  })

  it('a leftover tmp file from a crashed write does NOT block a subsequent write (tmp names are unique per call)', () => {
    const dir = freshRoot()
    const path = join(dir, 'onboarding.json')
    // Simulate a leftover tmp file from a crashed process — a fixed tmp name
    // would have permanently wedged every future save of this file (an
    // availability bug); a unique-per-call tmp name makes it merely inert.
    writeFileSync(`${path}.stale-crash-leftover.tmp`, 'stale-leftover-content')

    writeJsonAtomic(path, { ok: true })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true })
    // The stale leftover is untouched — nothing here needs to clean it up.
    expect(readFileSync(`${path}.stale-crash-leftover.tmp`, 'utf8')).toBe('stale-leftover-content')
  })

  it('throws and leaves no partial target or tmp file when the parent path is a plain file', () => {
    const dir = freshRoot()
    const blockerPath = join(dir, 'blocker')
    writeFileSync(blockerPath, 'i am a file, not a directory')
    const path = join(blockerPath, 'onboarding.json')

    expect(() => writeJsonAtomic(path, { ok: true })).toThrow()
    expect(existsSync(path)).toBe(false)
    const leftoverTmps = readdirSync(dir).filter((entry) => entry.includes('.tmp'))
    expect(leftoverTmps).toEqual([])
  })
})
