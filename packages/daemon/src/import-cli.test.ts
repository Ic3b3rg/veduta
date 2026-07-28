import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliIo, RunContext } from './import-cli.ts'
import { run } from './import-cli.ts'

const KEY_MATERIAL_ENV = 'a test vault key, long enough for scrypt derivation'
// A 40-char hex string, not `sk-ant-...` (rules section, group A precedent in
// `import-apply.test.ts`): the built-in `sk-ant-` redaction pattern would redact this value
// regardless of whether the importer's own secret-registration path ever ran, so the "no
// secret in any output line" assertion below would pass even if nothing were registered.
const FIXTURE_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

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
  if (!existsSync(root)) return []
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

/**
 * A realistic `~/.hermes` install ("Source layouts" table; fixture shape copied from
 * `import-apply.test.ts`'s `buildHermesFixture`): SOUL.md, a real-shaped USER.md profile,
 * `§`-separated MEMORY.md entries, a dated daily note, and a `.env` with one importable provider
 * key. `home` is the fake home directory the CLI's `--home` (or `VEDUTA_LEGACY_HOME`) points at;
 * `.hermes` is created directly under it.
 */
function buildHermesHome(): string {
  const home = freshDir('veduta-cli-home-')
  const dir = join(home, '.hermes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SOUL.md'),
    'You are Hermes, calm and thorough. Hermes never rushes a user through a decision.\n',
  )
  mkdirSync(join(dir, 'memories'), { recursive: true })
  writeFileSync(
    join(dir, 'memories', 'USER.md'),
    ['Name: Priya Sharma', 'Role: Product manager at a fintech startup'].join('\n'),
  )
  writeFileSync(
    join(dir, 'memories', 'MEMORY.md'),
    ['Priya prefers async updates over meetings.', 'The team ships on Thursdays.'].join('\n§\n'),
  )
  writeFileSync(
    join(dir, 'memories', '2026-01-05.md'),
    'Talked through Q1 roadmap risks with Priya.',
  )
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY=${FIXTURE_SECRET}\n`)
  writeFileSync(join(dir, 'config.yaml'), 'model: hermes-large\ncompression: true\n')
  return home
}

function capturingIo(): CliIo & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  }
}

interface Fixture {
  home: string
  rootDir: string
}

function setup(): Fixture {
  const home = buildHermesHome()
  const rootDir = freshDir('veduta-cli-target-')
  return { home, rootDir }
}

function baseArgv(fixture: Fixture, extra: string[] = []): string[] {
  return ['hermes', '--home', fixture.home, '--root', fixture.rootDir, ...extra]
}

function baseContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    env: {},
    io: capturingIo(),
    stdinIsTty: false,
    ...overrides,
  }
}

describe('import-cli run', () => {
  it('default run (no --apply) prints all three group headings, returns 0, and mutates nothing', async () => {
    const fixture = setup()
    const io = capturingIo()
    const before = listRecursive(fixture.rootDir)

    const code = await run(baseArgv(fixture), { env: {}, io, stdinIsTty: false })

    expect(code).toBe(0)
    expect(io.lines).toContain('Import:')
    expect(io.lines).toContain('Overwrite:')
    expect(io.lines).toContain('Skip:')
    expect(io.lines.some((line) => line.includes('run again with --apply'))).toBe(true)
    expect(listRecursive(fixture.rootDir)).toEqual(before)
  })

  it('issue 020 AC3: --apply with a non-TTY stdin prints the preview, returns 2, and mutates nothing', async () => {
    const fixture = setup()
    const io = capturingIo()
    const before = listRecursive(fixture.rootDir)

    const code = await run(baseArgv(fixture, ['--apply']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: false,
    })

    expect(code).toBe(2)
    expect(io.lines).toContain('Import:')
    expect(io.lines.some((line) => line.includes('interactive terminal'))).toBe(true)
    expect(listRecursive(fixture.rootDir)).toEqual(before)
  })

  it('--apply with a TTY and vault key material performs the import, returns 0, and prints the backup path', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(baseArgv(fixture, ['--apply']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: true,
    })

    expect(code).toBe(0)
    expect(io.lines.some((line) => line.includes('import complete'))).toBe(true)
    expect(io.lines.some((line) => line.startsWith('  backup:'))).toBe(true)
    expect(existsSync(join(fixture.rootDir, 'backups'))).toBe(true)
    expect(existsSync(join(fixture.rootDir, 'secrets.vault'))).toBe(false)
  })

  it('a second --apply without --overwrite returns 2 and names the previous import', async () => {
    const fixture = setup()
    const context = () =>
      baseContext({ env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV }, stdinIsTty: true })

    const first = await run(baseArgv(fixture, ['--apply']), context())
    expect(first).toBe(0)

    const io = capturingIo()
    const second = await run(baseArgv(fixture, ['--apply']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: true,
    })

    expect(second).toBe(2)
    expect(io.lines.some((line) => line.includes('already imported'))).toBe(true)
  })

  it('--apply --secrets with an active service returns 2 without importing, naming the stop command', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(baseArgv(fixture, ['--apply', '--secrets']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: true,
      serviceActive: () => 'active' as const,
    })

    expect(code).toBe(2)
    expect(io.lines.some((line) => line.includes('systemctl stop veduta'))).toBe(true)
    expect(existsSync(join(fixture.rootDir, 'secrets.vault'))).toBe(false)
  })

  it('--apply --secrets refuses when the service probe itself failed, rather than assuming inactive', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(baseArgv(fixture, ['--apply', '--secrets']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: true,
      // A permission or D-Bus failure, not systemd's own "inactive" answer: a live
      // daemon is still possible, so importing secrets could clobber the vault it owns.
      serviceActive: () => 'unknown' as const,
    })

    expect(code).toBe(2)
    expect(io.lines.some((line) => line.includes('could not be determined'))).toBe(true)
    expect(existsSync(join(fixture.rootDir, 'secrets.vault'))).toBe(false)
  })

  it('--apply --secrets proceeds with a restart reminder when there is no systemd at all', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(baseArgv(fixture, ['--apply', '--secrets']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io,
      stdinIsTty: true,
      serviceActive: () => 'no-systemd' as const,
    })

    expect(code).toBe(0)
    expect(io.lines.some((line) => line.includes('no systemd on this host'))).toBe(true)
  })

  it('an unknown flag returns 1 with the usage line', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(baseArgv(fixture, ['--bogus']), { env: {}, io, stdinIsTty: false })

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.startsWith('usage:'))).toBe(true)
  })

  it('an unknown source kind returns 1 with the usage line', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(['clawdbot9000', '--home', fixture.home, '--root', fixture.rootDir], {
      env: {},
      io,
      stdinIsTty: false,
    })

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.startsWith('usage:'))).toBe(true)
  })

  it('a missing source positional returns 1 with the usage line', async () => {
    const io = capturingIo()

    const code = await run(['--home', '/tmp', '--root', '/tmp'], { env: {}, io, stdinIsTty: false })

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.includes('missing source'))).toBe(true)
    expect(io.lines.some((line) => line.startsWith('usage:'))).toBe(true)
  })

  it('an extra positional argument returns 1 with the usage line, instead of being silently ignored', async () => {
    const fixture = setup()
    const io = capturingIo()

    const code = await run(
      ['hermes', 'unexpected-extra-arg', '--home', fixture.home, '--root', fixture.rootDir],
      { env: {}, io, stdinIsTty: false },
    )

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.includes('unexpected-extra-arg'))).toBe(true)
    expect(io.lines.some((line) => line.startsWith('usage:'))).toBe(true)
  })

  it('a planning error (a corrupt import.json) yields exit code 1 instead of an unhandled rejection', async () => {
    const fixture = setup()
    mkdirSync(fixture.rootDir, { recursive: true })
    writeFileSync(join(fixture.rootDir, 'import.json'), '{ not valid json')
    const io = capturingIo()

    const code = await run(baseArgv(fixture), { env: {}, io, stdinIsTty: false })

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.includes('invalid JSON'))).toBe(true)
  })

  it('no source found returns 1, naming the searched paths', async () => {
    const emptyHome = freshDir('veduta-cli-empty-home-')
    const rootDir = freshDir('veduta-cli-target-')
    const io = capturingIo()

    const code = await run(['hermes', '--home', emptyHome, '--root', rootDir], {
      env: {},
      io,
      stdinIsTty: false,
    })

    expect(code).toBe(1)
    expect(io.lines.some((line) => line.includes(rootDir))).toBe(true)
    expect(io.lines.some((line) => line.includes(emptyHome))).toBe(true)
  })

  it('no output line ever contains the fixture secret value, across every scenario above', async () => {
    const fixture = setup()
    const allLines: string[] = []

    const collect = (): CliIo => ({
      stdout: (line) => allLines.push(line),
      stderr: (line) => allLines.push(line),
    })

    await run(baseArgv(fixture), { env: {}, io: collect(), stdinIsTty: false })
    await run(baseArgv(fixture, ['--apply']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io: collect(),
      stdinIsTty: false,
    })
    await run(baseArgv(fixture, ['--apply', '--secrets']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io: collect(),
      stdinIsTty: true,
      serviceActive: () => 'active' as const,
    })
    await run(baseArgv(fixture, ['--apply', '--secrets']), {
      env: { VEDUTA_VAULT_KEY: KEY_MATERIAL_ENV },
      io: collect(),
      stdinIsTty: true,
      serviceActive: () => 'inactive' as const,
    })

    for (const line of allLines) expect(line).not.toContain(FIXTURE_SECRET)
  })
})
