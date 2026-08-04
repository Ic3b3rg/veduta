import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SpaceSchema } from '@veduta/protocol'
import { requiredString } from '../sqlite-rows.ts'
import { parseSpaceEventLine } from '../spaces-engine.ts'
import { surfaceEngineEventFromRow } from '../surface-engine.ts'
import { CURRENT_DATA_VERSION, readDataVersion } from './data-version.ts'

export interface SelfCheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfCheckReport {
  ok: boolean
  checks: SelfCheckResult[]
}

export interface SelfCheckOptions {
  rootDir: string
}

/**
 * Stage 1 of the update wrapper's two-stage health check
 * (`docs/adr/0013-signed-self-update.md`'s self-update amendments,
 * `issues/043-self-update.md` AC3): a deep, read-only inspection of a
 * migrated data root that never calls `buildServer`. `buildServer` seeds the
 * Health Space, starts the scheduler, reconciles the memory index, and runs
 * ingestion recovery — all mutating — so a health check built on top of it
 * could report "healthy" only after already changing the very root it was
 * asked to verify. Every check below opens files read-only and reads
 * `spaces/`/`surfaces.sqlite` directly, the same layout `SpacesEngine` and
 * `SurfaceEngine` use, without instantiating either engine (both mutate on
 * construction — `SpacesEngine.ensureBaseLayout` and `SurfaceEngine`'s
 * `initializeSchema`/seed). Stage 2 — starting the real daemon and waiting
 * for it to come up — is the wrapper's job, not this module's.
 *
 * Each check catches its own errors so one failing check never prevents the
 * rest from running: the report is meant to tell an operator (or the
 * updater's rollback decision) exactly which part of the data root is
 * unhealthy, not just that something is.
 */
export async function runSelfCheck(options: SelfCheckOptions): Promise<SelfCheckReport> {
  const { rootDir } = options
  const checks: SelfCheckResult[] = [
    checkDataVersion(rootDir),
    checkStoresOpen(rootDir),
    checkSpacesList(rootDir),
    checkSurfaceReplay(rootDir),
    checkEventLogParse(rootDir),
  ]

  // Harness-only failure injection for issues/043-self-update.md AC3: the
  // e2e harness needs a way to force stage 1 to fail without corrupting a
  // real data root, so it can assert the wrapper's rollback path actually
  // runs. Guarded by two separate env vars on purpose — a stray
  // `VEDUTA_TEST_FAIL_SELF_CHECK` left set in an operator's environment must
  // never silently fail a real self-check; both this AND the harness-wide
  // `VEDUTA_UPDATE_TEST_KNOBS` opt-in have to be present.
  if (
    process.env['VEDUTA_UPDATE_TEST_KNOBS'] === '1' &&
    process.env['VEDUTA_TEST_FAIL_SELF_CHECK'] === '1'
  ) {
    checks.push({
      name: 'test-knob',
      ok: false,
      detail: 'VEDUTA_TEST_FAIL_SELF_CHECK forced failure',
    })
  }

  return { ok: checks.every((check) => check.ok), checks }
}

function runCheck(name: string, run: () => string): SelfCheckResult {
  try {
    return { name, ok: true, detail: run() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Read-only: `readDataVersion` never stamps or bootstraps. A missing marker
 * or a mismatch both fail the check — the boot gate (`data-version.ts`'s
 * `ensureDataVersion`) is what stamps a fresh root or bootstraps a pre-issue
 * root, and neither belongs in a check that must never write.
 */
function checkDataVersion(rootDir: string): SelfCheckResult {
  return runCheck('data-version', () => {
    const dataVersion = readDataVersion(rootDir)
    if (dataVersion === undefined) {
      throw new Error(`no data-version.json marker found under ${rootDir}`)
    }
    if (dataVersion !== CURRENT_DATA_VERSION) {
      throw new Error(
        `dataVersion ${dataVersion} does not match this build's CURRENT_DATA_VERSION ` +
          `${CURRENT_DATA_VERSION}`,
      )
    }
    return `dataVersion ${dataVersion}`
  })
}

/**
 * Every `*.sqlite` file directly under `rootDir` (surfaces, scheduler,
 * trust, push, ingestion — whichever ones a given root actually has) opens
 * read-only and answers `PRAGMA integrity_check`. A fresh or partially
 * populated root is fine: a missing store file is simply not checked, the
 * same way `SurfaceEngine`/`TrustStore`/etc. tolerate a first boot that
 * creates their file lazily.
 */
function checkStoresOpen(rootDir: string): SelfCheckResult {
  return runCheck('stores-open', () => {
    const files = listSqliteFiles(rootDir)
    for (const file of files) {
      const db = new DatabaseSync(join(rootDir, file), { readOnly: true })
      try {
        const rows = db.prepare('PRAGMA integrity_check').all()
        const results = rows.map((row) => requiredString(row, 'integrity_check'))
        const healthy = results.length === 1 && results[0] === 'ok'
        if (!healthy) {
          throw new Error(`${file}: integrity_check reported: ${results.join('; ')}`)
        }
      } finally {
        db.close()
      }
    }
    return `${files.length} sqlite store(s) opened`
  })
}

function listSqliteFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return []
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Lists every Space the same way `SpacesEngine.listAllSpaces` does —
 * `spaces/<slug>/SPACE.json`, parsed with the protocol schema — but as a
 * plain directory walk, never through `SpacesEngine` itself: its constructor
 * creates `rootDir`/`spaces/` and writes `USER.md`/`SOUL.md` when missing
 * (`spaces-engine.ts`'s `ensureBaseLayout`), which would mutate the very
 * root this check must leave untouched.
 */
function checkSpacesList(rootDir: string): SelfCheckResult {
  return runCheck('spaces-list', () => {
    const spacesDir = join(rootDir, 'spaces')
    if (!existsSync(spacesDir)) return '0 spaces'
    const slugs = readdirSync(spacesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    let count = 0
    for (const slug of slugs) {
      const spaceFile = join(spacesDir, slug, 'SPACE.json')
      if (!existsSync(spaceFile)) continue
      SpaceSchema.parse(JSON.parse(readFileSync(spaceFile, 'utf8')))
      count += 1
    }
    return `${count} spaces`
  })
}

/**
 * Replays every `surface_events` row from cursor zero through
 * `surfaceEngineEventFromRow` — the exact row-level parser
 * `SurfaceEngine.surfaceEventsAfter` uses, exported from `surface-engine.ts`
 * for this reuse so a second, drifting copy of the freshness-tolerance logic
 * can never exist. `SurfaceEngine`'s constructor is not an option here: it
 * opens the database read-write, runs `initializeSchema` (creates tables,
 * `alter table` migrations), and seeds when empty — all writes. This check
 * opens `surfaces.sqlite` read-only instead and reads the ordering column
 * the real schema actually has, `cursor` (`surface-engine.ts`'s
 * `initializeSchema`: `cursor integer primary key`), not `id`.
 */
function checkSurfaceReplay(rootDir: string): SelfCheckResult {
  return runCheck('surface-replay', () => {
    const path = join(rootDir, 'surfaces.sqlite')
    if (!existsSync(path)) return '0 events replayed'
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = db.prepare('select kind, event_json from surface_events order by cursor').all()
      for (const row of rows) surfaceEngineEventFromRow(row)
      return `${rows.length} events replayed`
    } finally {
      db.close()
    }
  })
}

/**
 * Parses every line of every Space's Event log with `parseSpaceEventLine` —
 * the same tolerant reader `SpacesEngine.readRecent`/`readSince` use
 * (`spaces-engine.ts`). A garbage line is tolerated by design (it parses to
 * `undefined`, per that function's own contract) and only counted, never
 * treated as a failure: this check fails only when reading a log file
 * itself raises (an I/O error), not on its contents.
 */
function checkEventLogParse(rootDir: string): SelfCheckResult {
  return runCheck('event-log-parse', () => {
    const spacesDir = join(rootDir, 'spaces')
    if (!existsSync(spacesDir)) return '0 lines, 0 unparseable(tolerated)'
    const slugs = readdirSync(spacesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    let totalLines = 0
    let unparseable = 0
    for (const slug of slugs) {
      const logDir = join(spacesDir, slug, 'log')
      if (!existsSync(logDir)) continue
      const logFiles = readdirSync(logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
        .sort()
      for (const file of logFiles) {
        const lines = splitPhysicalLines(readFileSync(join(logDir, file), 'utf8'))
        for (const line of lines) {
          totalLines += 1
          if (parseSpaceEventLine(line) === undefined) unparseable += 1
        }
      }
    }
    return `${totalLines} lines, ${unparseable} unparseable(tolerated)`
  })
}

/**
 * Splits a `.jsonl` file's text into physical lines, dropping the trailing
 * empty string a file ending in a newline produces — the same convention
 * `spaces-engine.ts`'s own log reader uses, so this check's line count
 * matches what `SpacesEngine` actually considers "one entry" rather than
 * over-counting by one for every file.
 */
function splitPhysicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
