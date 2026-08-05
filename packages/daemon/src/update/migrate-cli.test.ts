import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_DATA_VERSION, readDataVersion, stampDataVersion } from './data-version.ts'
import { main } from './migrate-cli.ts'

/**
 * `migrate-cli.ts` (issue #43, `docs/adr/0013-signed-self-update.md`): the entry point the
 * update transaction spawns from the *new* release's own tree
 * (`update-transaction.ts`'s `runMigrationStep`). Exercised here via direct `main(args)` calls,
 * exactly as the deliverable specifies, rather than spawning a real subprocess.
 */

const dirs: string[] = []
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-migrate-cli-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.exitCode = undefined
})

describe('migrate-cli main', () => {
  it('migrates a root with no marker at all (from 0) up to --to and stamps the marker', () => {
    const root = freshRoot()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--root', root, '--to', String(CURRENT_DATA_VERSION)])

    expect(process.exitCode).toBe(0)
    expect(readDataVersion(root)).toBe(CURRENT_DATA_VERSION)
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes('migrate-cli'))).toBe(true)
    errSpy.mockRestore()
  })

  it('is idempotent: a root already at --to runs nothing and still exits 0', () => {
    const root = freshRoot()
    stampDataVersion(root, CURRENT_DATA_VERSION)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--root', root, '--to', String(CURRENT_DATA_VERSION)])

    expect(process.exitCode).toBe(0)
    expect(readDataVersion(root)).toBe(CURRENT_DATA_VERSION)
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes('nothing to migrate'))).toBe(
      true,
    )
    errSpy.mockRestore()
  })

  it('refuses --to greater than this build CURRENT_DATA_VERSION, and touches nothing', () => {
    const root = freshRoot()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--root', root, '--to', String(CURRENT_DATA_VERSION + 1)])

    expect(process.exitCode).toBe(1)
    expect(readDataVersion(root)).toBeUndefined()
    errSpy.mockRestore()
  })

  it('refuses to migrate backwards when --to is less than the root current dataVersion', () => {
    const root = freshRoot()
    stampDataVersion(root, CURRENT_DATA_VERSION)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--root', root, '--to', '0'])

    expect(process.exitCode).toBe(1)
    expect(readDataVersion(root)).toBe(CURRENT_DATA_VERSION)
    errSpy.mockRestore()
  })

  it('prints usage and exits 1 when --root or --to is missing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--to', '1'])
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    main(['--root', freshRoot()])
    expect(process.exitCode).toBe(1)

    errSpy.mockRestore()
  })

  it('exits 1 with a plain error when --root holds a corrupt data-version.json', () => {
    const root = freshRoot()
    writeFileSync(join(root, 'data-version.json'), 'not json')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    main(['--root', root, '--to', String(CURRENT_DATA_VERSION)])

    expect(process.exitCode).toBe(1)
    errSpy.mockRestore()
  })
})
