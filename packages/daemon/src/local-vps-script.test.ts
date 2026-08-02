import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
