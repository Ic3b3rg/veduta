import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InstallerStageEventSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'

// packages/daemon/src/ -> packages/daemon -> packages -> repo root.
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const installerScript = join('deploy', 'install.sh')

function runInstaller(args: string[]) {
  return spawnSync('bash', [installerScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function parseStageEvents(stdout: string) {
  const lines = stdout.trim().split('\n').filter(Boolean)
  return lines.map((line) => InstallerStageEventSchema.parse(JSON.parse(line)))
}

describe('deploy/install.sh preview mode (issue 019)', () => {
  const dirsToClean: string[] = []

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits a schema-valid stage protocol on stdout and exits 0 with --preview', () => {
    const result = runInstaller(['--preview'])

    expect(result.status).toBe(0)
    expect(result.stdout.trim().length).toBeGreaterThan(0)

    const events = parseStageEvents(result.stdout)
    expect(events.length).toBeGreaterThan(0)
    const lastEvent = events[events.length - 1]
    expect(lastEvent?.needs_user_input).toBe(true)
    expect(lastEvent?.stages.every((stage) => stage.status === 'pending')).toBe(true)
  })

  it('defaults to preview mode with no flags and no controlling tty, and exits 0', () => {
    const result = runInstaller([])

    expect(result.status).toBe(0)
    const events = parseStageEvents(result.stdout)
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]?.needs_user_input).toBe(true)
  })

  it('performs zero filesystem mutations in preview mode, even with an explicit --data-dir', () => {
    // Must be strictly under one of the installer's allowed --data-dir parents (issue #19
    // fix: /var/lib, /srv, /opt, /var/local) -- os.tmpdir() (e.g. /var/folders/... on macOS,
    // /tmp on Linux) is deliberately outside that allowlist, so it can't be reused here. The
    // path is never actually created outside this test (preview mode must not touch the
    // filesystem), so a synthetic, guaranteed-unique name under an allowed parent is enough.
    const dataDir = join('/opt', `veduta-installer-preview-${process.pid}-${Date.now()}`)
    dirsToClean.push(dataDir)

    const result = runInstaller(['--preview', '--data-dir', dataDir])

    expect(result.status).toBe(0)
    expect(existsSync(dataDir)).toBe(false)
  })
})
