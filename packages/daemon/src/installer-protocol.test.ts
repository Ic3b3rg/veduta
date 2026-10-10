import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

describe('guided installer access (issue #48)', () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function plan(script: string, args: string[] = []) {
    return spawnSync(
      'bash',
      [
        '-c',
        `
      source deploy/install.sh
      sshd() { printf 'allowtcpforwarding local\\ndisableforwarding no\\npermitopen any\\n'; }
      timeout() { printf 'SSH-2.0-test\\n'; }
      ss() { return 0; }
      prompt_tty() { printf 'prompt: %s [%s]\\n' "$1" "$2" >&2; REPLY="$2"; }
      ${script}
    `,
        '_',
        ...args,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 5000 },
    )
  }

  it('detects a nonstandard SSH port and prints a complete foreground handoff', () => {
    const result = plan(`
      SSH_CONNECTION='198.51.100.20 54321 203.0.113.10 2222'
      SUDO_USER=ubuntu
      ACCESS=tunnel
      ACCESS_PORT=8788
      choose_tunnel_handoff
      print_handoff
    `)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('-L 127.0.0.1:8788:127.0.0.1:8788 -p 2222 ubuntu@203.0.113.10')
    expect(result.stderr).toContain('on your computer, not on the VPS')
  })

  it('offers an occupied port replacement and makes the default editable', () => {
    const result = plan(`
      ss() { case "$*" in *:8788) printf 'LISTEN pid=42 other-service\\n';; esac; }
      ACCESS=tunnel
      ACCESS_PORT=8788
      SSH_TARGET=ubuntu@203.0.113.10
      choose_tunnel_handoff
      print_handoff
    `)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('pid=42 other-service')
    expect(result.stderr).toContain('Choose a free port for Veduta [8789]')
    expect(result.stderr).toContain('-L 127.0.0.1:8789:127.0.0.1:8789')
  })

  it('rejects an unattended occupied port without silently changing the origin', () => {
    const result = plan(`
      ss() { printf 'LISTEN other-service\\n'; }
      ACCESS_PORT=65535
      SSH_TARGET=ubuntu@203.0.113.10
      EXPLICIT_APPLY=true
      choose_tunnel_handoff
    `)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('port 65535 is occupied')
    expect(result.stderr).not.toContain('prompt:')
  })

  it('allows editing a free installed port through Update access', () => {
    const result = plan(`
      prompt_tty() { REPLY="$2"; if [ "$1" = 'Veduta browser port' ]; then REPLY=8999; fi; }
      EDIT_ACCESS=true
      SETUP_ONLY=true
      ACCESS=tunnel
      ACCESS_PORT=8788
      SSH_TARGET=ubuntu@203.0.113.10
      choose_tunnel_handoff
      print_handoff
    `)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('-L 127.0.0.1:8999:127.0.0.1:8999')
  })

  it.each(['disableforwarding yes\\npermitopen any', 'disableforwarding no\\npermitopen none'])(
    'refuses effective SSH restrictions: %s',
    (restriction) => {
      const result = plan(
        `
        POLICY="$1"
        sshd() { printf 'allowtcpforwarding yes\\n%b\\n' "$POLICY"; }
        ACCESS_PORT=8788
        SSH_TARGET=ubuntu@203.0.113.10
        EXPLICIT_APPLY=true
        choose_tunnel_handoff
      `,
        [restriction],
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('sudo sshd -T -C user=ubuntu')
    },
  )

  it('retains candidate recovery files and reports failure if restoring the active configuration fails', () => {
    const result = plan(`
      source deploy/access-transaction.sh
      ACCESS_TRANSACTION=true
      ACCESS_PREVIOUS=/previous
      ACCESS_GENERATION=/candidate
      CURRENT_ORIGIN=http://localhost:8788
      ln() { return 1; }
      mv() { printf 'unexpected-move'; }
      rm() { printf 'unexpected-delete'; }
      systemctl() { printf 'unexpected-restart'; }
      access_abort || printf 'rollback-failed'
    `)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('rollback-failed')
    expect(result.stderr).toContain('Candidate files retained')
    expect(result.stderr).not.toContain('Restored the previous access')
  })

  it('restores the old Gateway even when Serve rollback needs administrator repair', () => {
    const result = plan(`
      source deploy/access-transaction.sh
      ACCESS_TRANSACTION=true
      ACCESS_GENERATION=/candidate
      CURRENT_ACCESS=tunnel
      CURRENT_ORIGIN=http://localhost:8788
      CURRENT_PORT=8788
      tailnet_abort() { return 1; }
      access_restore_configuration() { printf 'config-restored '; }
      systemctl() { printf 'service:%s ' "$*"; }
      wait_for_gateway() { printf 'gateway-ready '; }
      rm() { printf 'unexpected-delete'; }
      access_abort || printf 'rollback-needs-repair'
    `)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('config-restored')
    expect(result.stdout).toContain('service:restart veduta')
    expect(result.stdout).toContain('gateway-ready')
    expect(result.stdout).not.toContain('unexpected-delete')
    expect(result.stderr).toContain('previous Gateway restored, but Serve needs repair')
  })

  it('does not report fresh setup success when private route verification fails', () => {
    const result = plan(`
      source deploy/access-transaction.sh
      tailnet_commit() { return 1; }
      if access_commit; then printf 'unexpected-success'; else printf 'verification-failed'; fi
    `)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('verification-failed')
  })

  it('preserves the installed origin and configuration when planning a repair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veduta-access-plan-'))
    scratch.push(dir)
    const path = join(dir, 'access.json')
    const config = JSON.stringify({
      mode: 'tunnel',
      origin: 'http://localhost:8999',
      port: 8999,
      sshTarget: 'ubuntu@203.0.113.10',
      sshPort: 2222,
      dataDir: '/var/lib/veduta/.veduta',
    })
    writeFileSync(path, config)
    const result = plan(
      `
      ACCESS_CONFIG="$1"
      EXPLICIT_APPLY=true
      choose_access
      printf '%s %s %s' "$ACCESS" "$ORIGIN" "$SSH_PORT"
    `,
      [path],
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('tunnel http://localhost:8999 2222')
    expect(readFileSync(path, 'utf8')).toBe(config)
  })

  it('refuses an SSH server that disables local forwarding with a recovery action', () => {
    const result = plan(`
      sshd() { printf 'allowtcpforwarding no\\n'; }
      ACCESS_PORT=8788
      SSH_TARGET=ubuntu@203.0.113.10
      EXPLICIT_APPLY=true
      choose_tunnel_handoff
    `)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sudo sshd -T')
  })

  it('previews Tunnel access by default and includes a safe recovery command', () => {
    const result = runInstaller(['--preview'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      access_mode: 'tunnel',
      state: 'preview',
      repair_command: 'sudo bash deploy/install.sh',
    })
    expect(result.stderr).toContain('no domain required')
  })

  it('previews private Tailnet access and retains its explicit confirmations for retry', () => {
    const result = runInstaller([
      '--preview',
      '--access',
      'tailnet',
      '--tailnet-port',
      '8443',
      '--device-approval-confirmed',
      '--accept-certificate-name',
    ])
    expect(result.status).toBe(0)
    const event = JSON.parse(result.stdout)
    expect(event.access_mode).toBe('tailnet')
    expect(event.repair_command).toContain('--device-approval-confirmed')
    expect(event.repair_command).toContain('--accept-certificate-name')
    expect(result.stderr).toContain('Tailnet access: private HTTPS')
    expect(result.stderr).not.toContain('Public access: domain and HTTPS required')
  })

  it('previews explicit Public access without mutating the host', () => {
    const result = runInstaller([
      '--preview',
      '--access',
      'public',
      '--domain',
      'veduta.example.com',
      '--email',
      'owner@example.com',
    ])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ access_mode: 'public' })
  })

  it('rejects invalid configuration before starting a stage', () => {
    for (const args of [
      ['--preview', '--access', 'wrong'],
      ['--preview', '--port', '65536'],
      ['--preview', '--ssh-target', '-oProxyCommand=bad'],
      ['--preview', '--domain', 'example.com\nEnvironment=INJECTED=1'],
      ['--apply', '--access', 'public'],
      ['--apply', '--access', 'tunnel'],
    ]) {
      const result = runInstaller(args)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('error:')
      expect(result.stdout).toBe('')
    }
  })

  it('fails promptly with a file-based invocation when an interactive script is piped into bash', () => {
    const result = spawnSync(
      'python3',
      [
        join(repoRoot, 'packages/daemon/src/fixtures/installer-pty.py'),
        join(repoRoot, installerScript),
      ],
      { encoding: 'utf8', timeout: 6000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.stdout + result.stderr).toContain('download the installer to a file')
    expect(result.stdout + result.stderr).not.toContain('Public domain (A/AAAA')
  })
})
