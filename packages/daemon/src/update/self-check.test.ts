import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../store.ts'
import { SurfaceEngine } from '../surface-engine.ts'
import { CURRENT_DATA_VERSION, stampDataVersion } from './data-version.ts'
import { runSelfCheck } from './self-check.ts'

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * sha256 of every file under `rootDir`, keyed by path relative to it — the
 * hermeticity proof (`self-check.ts`'s own docstring): stage 1 must be
 * side-effect-free by construction, and hashing the whole tree before and
 * after `runSelfCheck` is how that claim gets checked rather than assumed.
 *
 * `-wal`/`-shm` sidecar files are skipped, the same exclusion `backup.ts`'s
 * `stageRootDir` applies: SQLite's own reader bookkeeping touches a
 * database's `-shm` file just by opening a read-only connection to it (a
 * new reader lock slot), with no change to the database's actual content —
 * confirmed here by `surfaces.sqlite` and `surfaces.sqlite-wal` themselves
 * staying byte-identical while only `-shm` moved. Treating that as a
 * mutation would make hermeticity untestable for any sqlite-backed root.
 */
function hashTree(rootDir: string): Map<string, string> {
  const hashes = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue
      hashes.set(
        relative(rootDir, full),
        createHash('sha256').update(readFileSync(full)).digest('hex'),
      )
    }
  }
  walk(rootDir)
  return hashes
}

describe('runSelfCheck', () => {
  it('passes on a healthy, migrated root and leaves it byte-for-byte unchanged', async () => {
    const rootDir = await tempRoot('veduta-selfcheck-healthy-')
    // `Store` seeds the Health Space and its Surfaces on construction — not
    // referenced again afterward, so nothing keeps writing to `rootDir`
    // once this line completes.
    new Store({ rootDir })
    stampDataVersion(rootDir, CURRENT_DATA_VERSION)

    const before = hashTree(rootDir)
    const report = await runSelfCheck({ rootDir })
    const after = hashTree(rootDir)

    expect(report.ok).toBe(true)
    for (const check of report.checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true)
    expect(after).toEqual(before)
  })

  it('fails the data-version check when the marker does not match CURRENT_DATA_VERSION', async () => {
    const rootDir = await tempRoot('veduta-selfcheck-mismatch-')
    new Store({ rootDir })
    stampDataVersion(rootDir, 999)

    const report = await runSelfCheck({ rootDir })

    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'data-version')).toMatchObject({
      ok: false,
    })
  })

  it('fails stores-open when a sqlite file is corrupt', async () => {
    const rootDir = await tempRoot('veduta-selfcheck-corrupt-')
    stampDataVersion(rootDir, CURRENT_DATA_VERSION)
    await writeFile(join(rootDir, 'surfaces.sqlite'), 'not a real sqlite file at all, just garbage')

    const report = await runSelfCheck({ rootDir })

    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'stores-open')).toMatchObject({ ok: false })
  })

  it('fails surface-replay when a surface_events row fails schema validation', async () => {
    const rootDir = await tempRoot('veduta-selfcheck-poisoned-')
    stampDataVersion(rootDir, CURRENT_DATA_VERSION)
    new SurfaceEngine({
      rootDir,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
      hasSpace: () => true,
      appendSpaceEvent: () => undefined,
    })

    // A second connection to the same file is how a row that no writer this
    // engine version knows about gets in — the same technique
    // `fixture-corpus.test.ts` uses for its historical-shape corpus. This
    // row's `event_json` is valid JSON (`{}`) but has none of
    // `SurfacePatchEventSchema`'s required fields, so it fails schema
    // validation rather than the freshness-tolerance fallback.
    const rawDb = new DatabaseSync(join(rootDir, 'surfaces.sqlite'))
    rawDb
      .prepare(
        `insert into surface_events (cursor, at, space_id, surface_id, kind, event_json)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(1, '2026-01-01T00:00:00.000Z', 'spc-x', 'srf-x', 'patch', JSON.stringify({}))
    rawDb.close()

    const report = await runSelfCheck({ rootDir })

    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'surface-replay')).toMatchObject({
      ok: false,
    })
  })

  describe('VEDUTA_TEST_FAIL_SELF_CHECK test knob', () => {
    afterEach(() => {
      delete process.env['VEDUTA_UPDATE_TEST_KNOBS']
      delete process.env['VEDUTA_TEST_FAIL_SELF_CHECK']
    })

    it('injects a failing check when both env vars are set', async () => {
      const rootDir = await tempRoot('veduta-selfcheck-knob-both-')
      new Store({ rootDir })
      stampDataVersion(rootDir, CURRENT_DATA_VERSION)
      process.env['VEDUTA_UPDATE_TEST_KNOBS'] = '1'
      process.env['VEDUTA_TEST_FAIL_SELF_CHECK'] = '1'

      const report = await runSelfCheck({ rootDir })

      expect(report.ok).toBe(false)
      expect(report.checks.find((check) => check.name === 'test-knob')).toMatchObject({
        ok: false,
        detail: 'VEDUTA_TEST_FAIL_SELF_CHECK forced failure',
      })
    })

    it('does not inject a failure when only VEDUTA_UPDATE_TEST_KNOBS is set', async () => {
      const rootDir = await tempRoot('veduta-selfcheck-knob-partial-a-')
      new Store({ rootDir })
      stampDataVersion(rootDir, CURRENT_DATA_VERSION)
      process.env['VEDUTA_UPDATE_TEST_KNOBS'] = '1'

      const report = await runSelfCheck({ rootDir })

      expect(report.checks.find((check) => check.name === 'test-knob')).toBeUndefined()
      expect(report.ok).toBe(true)
    })

    it('does not inject a failure when only VEDUTA_TEST_FAIL_SELF_CHECK is set', async () => {
      const rootDir = await tempRoot('veduta-selfcheck-knob-partial-b-')
      new Store({ rootDir })
      stampDataVersion(rootDir, CURRENT_DATA_VERSION)
      process.env['VEDUTA_TEST_FAIL_SELF_CHECK'] = '1'

      const report = await runSelfCheck({ rootDir })

      expect(report.checks.find((check) => check.name === 'test-knob')).toBeUndefined()
      expect(report.ok).toBe(true)
    })
  })
})
