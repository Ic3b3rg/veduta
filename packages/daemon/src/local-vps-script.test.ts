import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// packages/daemon/src/ -> packages/daemon -> packages -> repo root.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const runnerScript = join('deploy', 'local-vps.sh')

function runScript(args: string[]) {
  return spawnSync('bash', [runnerScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

describe('deploy/local-vps.sh (issue 023)', () => {
  it('is syntactically valid bash', () => {
    const result = spawnSync('bash', ['-n', runnerScript], { cwd: repoRoot, encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('prints usage mentioning --port and --base-dir and exits 0 with --help', () => {
    const result = runScript(['--help'])

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('--port')
    expect(result.stderr).toContain('--base-dir')
  })

  it('exits 64 on an unknown flag', () => {
    const result = runScript(['--bogus'])

    expect(result.status).toBe(64)
  })

  it('never contains an rm invocation -- the runner must never delete anything', () => {
    const source = readFileSync(join(repoRoot, runnerScript), 'utf8')

    // One documented exception: `ensure_vault_keyfile` always discards its
    // own scratch keyfile candidate after the atomic `ln` publication (after
    // a win it is just a second hard link to the published keyfile; after a
    // lost race it holds unused leftover key material). Removing it is
    // key-material hygiene, not the user-data deletion this test guards
    // against (no `--fresh`, no rm of $BASE_DIR/$DATA_DIR/$VAULT_KEYFILE).
    const withoutScratchCleanup = source.replace('rm -f "$tmp"', '')

    expect(withoutScratchCleanup).not.toMatch(/(^|[^a-zA-Z_])rm /)
  })

  it('exits 64 when --port is not an integer', () => {
    const result = runScript(['--port', 'abc'])

    expect(result.status).toBe(64)
  })

  it('exits 64 when --port is missing its operand', () => {
    const result = runScript(['--port'])

    expect(result.status).toBe(64)
  })

  it('exits 64 when --port is out of range (0)', () => {
    const result = runScript(['--port', '0'])

    expect(result.status).toBe(64)
  })
})

describe('Local VPS PWA build reuse', () => {
  const fixtureDirs: string[] = []

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function fixture(withBuild: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'veduta-local-vps-build-'))
    fixtureDirs.push(root)
    for (const dir of ['deploy', 'node_modules', 'bin']) mkdirSync(join(root, dir))
    copyFileSync(join(repoRoot, runnerScript), join(root, runnerScript))
    writeFileSync(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "build\\n" >> "$TEST_PNPM_LOG"\n')
    writeFileSync(join(root, 'deploy/veduta-run'), '#!/bin/sh\nprintf "supervisor started\\n"\n')
    chmodSync(join(root, 'bin/pnpm'), 0o755)
    chmodSync(join(root, 'deploy/veduta-run'), 0o755)
    const log = join(root, 'build.log')
    writeFileSync(log, '')
    if (withBuild) {
      mkdirSync(join(root, 'packages/pwa/dist'), { recursive: true })
      writeFileSync(join(root, 'packages/pwa/dist/index.html'), '<!doctype html>')
    }
    return {
      run: (...args: string[]) =>
        spawnSync('bash', [join(root, runnerScript), '--base-dir', join(root, 'base'), ...args], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env['PATH']}`,
            TEST_PNPM_LOG: log,
          },
          encoding: 'utf8',
          timeout: 10_000,
        }),
      builds: () => readFileSync(log, 'utf8'),
    }
  }

  it('builds fresh assets by default even when an old build exists', () => {
    const stack = fixture(true)
    const result = stack.run()

    expect(result.status).toBe(0)
    expect(stack.builds()).toBe('build\n')
    expect(result.stdout).toContain('supervisor started')
  })

  it('starts from an explicitly reused build without invoking pnpm', () => {
    const stack = fixture(true)
    const result = stack.run('--skip-build')

    expect(result.status).toBe(0)
    expect(stack.builds()).toBe('')
    expect(result.stdout).toContain('supervisor started')
  })

  it('rejects a missing reused build before starting the supervisor', () => {
    const stack = fixture(false)
    const result = stack.run('--skip-build')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pnpm --filter @veduta/pwa build')
    expect(stack.builds()).toBe('')
    expect(result.stdout).not.toContain('supervisor started')
  })
})
