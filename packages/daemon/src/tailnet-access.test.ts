import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const ready = {
  BackendState: 'Running',
  Self: { Online: true, DNSName: 'veduta.tail123.ts.net.' },
  CurrentTailnet: { Name: 'owner@example.com', StableID: 'tailnet-1', MagicDNSEnabled: true },
  CertDomains: ['veduta.tail123.ts.net'],
}
const unrelated = {
  TCP: { '443': { HTTPS: true } },
  Web: { 'veduta.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } },
  AllowFunnel: { 'veduta.tail123.ts.net:443': true },
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(script: string, fixture: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-tailnet-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify({ status: ready, serve: {}, ...fixture }))
  for (const command of ['tailscale', 'curl', 'systemctl', 'systemd-run']) {
    symlinkSync(join(root, 'packages/daemon/src/fixtures/tailscale-fake.py'), join(dir, command))
  }
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    source deploy/install.sh
    source deploy/tailnet-access.sh
    trap tailnet_stop_candidate EXIT
    ACCESS=tailnet
    ACCESS_PORT=8788
    TAILNET_HOST=veduta.tail123.ts.net
    TAILNET_HTTPS_PORT=8443
    TAILNET_DEVICE_APPROVAL=true
    ORIGIN=https://veduta.tail123.ts.net:8443
    ACCESS_CONFIG="$1/no-installed-config.json"
    prompt_tty() { REPLY="$2"; }
    ${script}
  `,
      '_',
      dir,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH']}`,
        VEDUTA_TEST_TAILNET_STATE: path,
      },
    },
  )
  const state = JSON.parse(readFileSync(path, 'utf8'))
  return { ...result, state }
}

describe('Tailscale CLI access boundary (issue #49)', () => {
  it.each(['NeedsLogin', 'NeedsMachineAuth', 'Stopped'])(
    'fails closed when the node is %s',
    (BackendState) => {
      const result = run('tailnet_verify', { status: { ...ready, BackendState } })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('sudo veduta access')
      expect(result.state.serve).toEqual({})
    },
  )

  it('uses an existing connected node and a free HTTPS endpoint', () => {
    const result = run('tailnet_prepare; printf "%s" "$ORIGIN"')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('https://veduta.tail123.ts.net:8443')
    expect(result.state.calls.some((call: string[]) => call[1] === 'up')).toBe(false)
  })

  it('waits on interactive login and verifies the resulting connection', () => {
    const result = run('tailnet_prepare', {
      status: { ...ready, BackendState: 'NeedsLogin' },
      loginStatus: ready,
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('https://login.tailscale.com/a/test-only')
    expect(result.state.status.BackendState).toBe('Running')
  })

  it('requires an honest operator confirmation of account-wide device approval', () => {
    const result = run('TAILNET_DEVICE_APPROVAL=false; EXPLICIT_APPLY=true; tailnet_prepare')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cannot verify it through the local CLI')
    expect(result.state.serve).toEqual({})
  })

  it('offers a free HTTPS port without changing unrelated Serve/Funnel configuration', () => {
    const result = run(
      'TAILNET_HTTPS_PORT=443; tailnet_prepare; tailnet_stage_route; tailnet_verify',
      { serve: unrelated },
    )
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Private address: https://veduta.tail123.ts.net:8443')
    expect(JSON.stringify(result.state.serve.Web['veduta.tail123.ts.net:443'])).toBe(
      JSON.stringify(unrelated.Web['veduta.tail123.ts.net:443']),
    )
    expect(result.state.serve.AllowFunnel).toEqual(unrelated.AllowFunnel)
    expect(result.state.serve.Web['veduta.tail123.ts.net:8443'].Handlers['/']).toEqual({
      Proxy: 'http://127.0.0.1:8788',
    })
  })

  it('refuses to overwrite routes when Serve configuration cannot be read', () => {
    const result = run('tailnet_stage_route', { serveReadFailure: true })
    expect(result.status).not.toBe(0)
    expect(
      result.state.calls.filter(
        (call: string[]) => call[0] === 'tailscale' && call[1] === 'serve' && call[2] !== 'status',
      ),
    ).toEqual([])
  })

  it('removes a staged foreground route on failure without changing persistent routes', () => {
    const result = run('ACCESS_CHANGE=true; tailnet_stage_route; tailnet_verify; tailnet_abort', {
      serve: unrelated,
    })
    expect(result.status).toBe(0)
    expect(result.state.serve.Foreground).toEqual({})
    expect(result.state.serve.Web).toEqual(unrelated.Web)
    expect(result.state.serve.AllowFunnel).toEqual(unrelated.AllowFunnel)
  }, 15_000)

  it('promotes a verified candidate to persistent Serve while preserving unrelated routes', () => {
    const result = run('ACCESS_CHANGE=true; tailnet_stage_route; tailnet_verify; tailnet_commit', {
      serve: unrelated,
    })
    expect(result.status).toBe(0)
    expect(result.state.serve.Foreground).toEqual({})
    expect(result.state.serve.Web['veduta.tail123.ts.net:8443'].Handlers['/']).toEqual({
      Proxy: 'http://127.0.0.1:8788',
    })
    expect(result.state.serve.Web['veduta.tail123.ts.net:443']).toEqual(
      unrelated.Web['veduta.tail123.ts.net:443'],
    )
  }, 15_000)

  it('rolls back the candidate after certificate verification fails', () => {
    const result = run(
      'ACCESS_CHANGE=true; tailnet_stage_route; if ! tailnet_verify; then tailnet_abort; exit 1; fi',
      { serve: unrelated, certificateFailure: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('valid certificate')
    expect(result.state.serve.Foreground).toEqual({})
    expect(result.state.serve.Web).toEqual(unrelated.Web)
  }, 15_000)

  it('has a persistent private route if execution stops at the active-origin swap', () => {
    const result = run(`
      source deploy/access-transaction.sh
      ACCESS_CHANGE=true
      ACCESS_TRANSACTION=true
      ACCESS_GENERATION=/candidate
      tailnet_stage_route
      access_activate() { exit 42; }
      access_commit
    `)
    expect(result.status).toBe(42)
    expect(result.state.serve.Foreground).toEqual({})
    expect(result.state.serve.Web['veduta.tail123.ts.net:8443'].Handlers['/']).toEqual({
      Proxy: 'http://127.0.0.1:8788',
    })
  }, 15_000)

  it('removes only the owned root handler and preserves a sibling route', () => {
    const sibling = { Text: 'unrelated' }
    const result = run('tailnet_remove_route "$TAILNET_HOST" 8443 8788', {
      serve: {
        TCP: { '8443': { HTTPS: true } },
        Web: {
          'veduta.tail123.ts.net:8443': {
            Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' }, '/other': sibling },
          },
        },
      },
    })
    expect(result.status).toBe(0)
    expect(result.state.serve.Web['veduta.tail123.ts.net:8443'].Handlers).toEqual({
      '/other': sibling,
    })
    expect(result.state.serve.TCP).toEqual({ '8443': { HTTPS: true } })
  })

  it('refuses removal when an external change replaced the owned route', () => {
    const result = run('tailnet_remove_route "$TAILNET_HOST" 443 8788', { serve: unrelated })
    expect(result.status).not.toBe(0)
    expect(result.state.serve).toEqual(unrelated)
  })

  it('does not remove a different hostname after the node was renamed', () => {
    const serve = {
      TCP: { '8443': { HTTPS: true } },
      Web: {
        'old.tail123.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } },
        'veduta.tail123.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } },
      },
    }
    const result = run('tailnet_remove_route old.tail123.ts.net 8443 8788', { serve })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('hostname')
    expect(result.state.serve).toEqual(serve)
  })

  it('restores an owned root handler alongside an untouched sibling after rollback', () => {
    const serve = {
      TCP: { '443': { HTTPS: true } },
      Web: {
        'veduta.tail123.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' }, '/other': { Text: 'keep me' } },
        },
      },
    }
    const result = run(
      `
      ACCESS=tunnel
      CURRENT_ACCESS=tailnet
      CURRENT_ORIGIN=https://veduta.tail123.ts.net
      CURRENT_TAILNET_PORT=443
      CURRENT_PORT=8788
      ORIGIN=http://localhost:8788
      tailnet_commit
      tailnet_abort
    `,
      { serve },
    )
    expect(result.status).toBe(0)
    expect(result.state.serve).toEqual(serve)
  })

  it.each([
    'http://127.0.0.1:8788',
    'http://localhost:8788/path',
    'http://[::1]:8788',
    'http://LOCALHOST:8788',
    'http://[::ffff:7f00:1]:8788',
    'http://127.0.0.1:08788',
    'http://0.0.0.0:8788',
  ])(
    'rejects an unrelated Funnel exposing the selected backend at %s before starting Veduta',
    (proxy) => {
      const serve = {
        ...unrelated,
        Web: { 'veduta.tail123.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } },
      }
      const result = run('tailnet_prepare', { serve })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Funnel')
      expect(result.state.serve).toEqual(serve)
    },
  )

  it('treats an omitted HTTP port as port 80 when checking public proxies', () => {
    const serve = {
      ...unrelated,
      Web: { 'veduta.tail123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1' } } } },
    }
    const result = run('ACCESS_PORT=80; tailnet_prepare', { serve })
    expect(result.status).not.toBe(0)
    expect(result.state.serve).toEqual(serve)
  })

  it('rejects a public TCP Funnel forwarding to the selected backend', () => {
    const serve = {
      TCP: { '443': { TCPForward: '127.0.0.1:8788', TerminateTLS: 'veduta.tail123.ts.net' } },
      AllowFunnel: { 'veduta.tail123.ts.net:443': true },
    }
    const result = run('tailnet_prepare', { serve })
    expect(result.status).not.toBe(0)
    expect(result.state.serve).toEqual(serve)
  })

  it('rejects changing the backend behind an unchanged origin before writing configuration', () => {
    const result = run(`
      EXISTING_ACCESS=true
      CURRENT_ACCESS=tailnet
      CURRENT_ORIGIN="$ORIGIN"
      CURRENT_PORT=8790
      CURRENT_TAILNET_PORT=8443
      tailnet_prepare
    `)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('requires a free --tailnet-port')
    expect(result.state.serve).toEqual({})
  })

  it('removes only the previous Tailnet route when committing Tunnel access', () => {
    const result = run(
      `
      ACCESS=tunnel
      CURRENT_ACCESS=tailnet
      CURRENT_ORIGIN=https://veduta.tail123.ts.net
      CURRENT_TAILNET_PORT=443
      CURRENT_PORT=9000
      ORIGIN=http://localhost:8788
      tailnet_commit
      tailnet_abort
    `,
      { serve: unrelated },
    )
    expect(result.status).toBe(0)
    expect(result.state.serve.Web).toEqual(unrelated.Web)
    // Recovery restores private Serve, never an externally enabled Funnel.
    expect(result.state.serve.AllowFunnel).toEqual({})
    expect(result.state.calls.some((call: string[]) => call.includes('reset'))).toBe(false)
  })

  it.each(['certificate', 'funnel', 'missing-route', 'hostname'])(
    'fails closed for %s without changing access mode',
    (failure) => {
      const serve = {
        TCP: { '8443': { HTTPS: true } },
        Web: {
          'veduta.tail123.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } },
        },
        AllowFunnel: { 'veduta.tail123.ts.net:8443': failure === 'funnel' },
      }
      const result = run('tailnet_verify', {
        serve: failure === 'missing-route' ? {} : serve,
        certificateFailure: failure === 'certificate',
        status:
          failure === 'hostname'
            ? { ...ready, Self: { ...ready.Self, DNSName: 'changed.tail123.ts.net.' } }
            : ready,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('sudo veduta access')
      expect(
        result.state.calls.filter(
          (call: string[]) =>
            call[0] === 'tailscale' && call[1] === 'serve' && call[2] !== 'status',
        ),
      ).toEqual([])
    },
  )
})
