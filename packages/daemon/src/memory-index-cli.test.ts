import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from './memory-index-cli.ts'
import { SpacesEngine } from './spaces-engine.ts'

describe('memory-index-cli run', () => {
  const dirs: string[] = []
  const makeRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'veduta-memory-index-cli-'))
    dirs.push(dir)
    return dir
  }
  const collectIo = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
      out,
      err,
    }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Seeds a Space with a couple of events and a fact, purely through `SpacesEngine`'s files. */
  function seedRoot(rootDir: string): void {
    const engine = new SpacesEngine({ rootDir })
    const health = engine.createSpace({ name: 'Health' })
    engine.appendEvent(health.id, { type: 'note', text: 'Went for a long swim this afternoon' })
    engine.appendEvent(health.id, { type: 'note', text: 'Booked a dentist appointment' })
    engine.writeFact(health.id, 'Allergic to penicillin')
  }

  it('rebuild reports a non-zero record count, exits 0, and leaves memory.sqlite on disk', async () => {
    const root = makeRoot()
    seedRoot(root)
    const { io, out } = collectIo()

    const code = await run(['rebuild', '--root', root], { io })

    expect(code).toBe(0)
    expect(existsSync(join(root, 'memory.sqlite'))).toBe(true)
    const total = out.find((line) => line.startsWith('total:'))
    expect(total).toBeDefined()
    expect(total).not.toBe('total: 0 record(s)')
  })

  it('rebuild twice in a row is deterministic', async () => {
    const root = makeRoot()
    seedRoot(root)

    const first = collectIo()
    expect(await run(['rebuild', '--root', root], { io: first.io })).toBe(0)

    const second = collectIo()
    expect(await run(['rebuild', '--root', root], { io: second.io })).toBe(0)

    expect(second.out).toEqual(first.out)
  })

  it('rebuild removes a stale -wal companion left behind by a crashed process', async () => {
    const root = makeRoot()
    seedRoot(root)
    // `memory.sqlite` does not exist yet at this point (nothing has opened
    // an index over this root), so a dummy `-wal` file here stands in for a
    // companion left behind without its database, which `rebuild` must
    // still clean up.
    const walPath = join(root, 'memory.sqlite-wal')
    writeFileSync(walPath, 'stale')
    expect(existsSync(walPath)).toBe(true)

    const { io } = collectIo()
    expect(await run(['rebuild', '--root', root], { io })).toBe(0)

    expect(existsSync(walPath)).toBe(false)
  })

  it('reconcile on an already-current index changes no counts', async () => {
    const root = makeRoot()
    seedRoot(root)
    expect(await run(['rebuild', '--root', root], { io: collectIo().io })).toBe(0)

    const first = collectIo()
    expect(await run(['reconcile', '--root', root], { io: first.io })).toBe(0)

    const second = collectIo()
    expect(await run(['reconcile', '--root', root], { io: second.io })).toBe(0)

    expect(second.out).toEqual(first.out)
  })

  it('status prints the schema version and per-Space counts without modifying the database', async () => {
    const root = makeRoot()
    seedRoot(root)
    expect(await run(['rebuild', '--root', root], { io: collectIo().io })).toBe(0)

    const before = collectIo()
    expect(await run(['status', '--root', root], { io: before.io })).toBe(0)
    expect(before.out.some((line) => line.startsWith('schema version:'))).toBe(true)
    expect(before.out.some((line) => /event\(s\)/.test(line))).toBe(true)

    const after = collectIo()
    expect(await run(['status', '--root', root], { io: after.io })).toBe(0)

    expect(after.out).toEqual(before.out)
  })

  it('returns 1 and prints usage for an unknown subcommand', async () => {
    const root = makeRoot()
    const { io, err } = collectIo()
    expect(await run(['bogus', '--root', root], { io })).toBe(1)
    expect(err.join(' ')).toContain('usage: memory-index')
  })

  it('returns 1 and prints usage when no subcommand is given', async () => {
    const root = makeRoot()
    const { io, err } = collectIo()
    expect(await run(['--root', root], { io })).toBe(1)
    expect(err.join(' ')).toContain('usage: memory-index')
  })
})
