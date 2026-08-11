import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  createFakeCodexTransport,
  fakeCodexConnectedAccountReadResponse,
  fakeCodexInitializeResponse,
  fakeCodexLoginStartResponse,
  fakeCodexModelEntry,
  fakeCodexModelListResponse,
  fakeCodexSignedOutAccountReadResponse,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { CodexSessionPool, type CodexTransport } from './codex-app-server.ts'
import { ModelConnectionError, type AdapterContext } from './model-connection-adapter.ts'
import {
  codexSubscriptionAdapter,
  createCodexAdapter,
  initializeCodexTransport,
} from './model-connection-codex.ts'
import type { SecretResolver } from './model-routing.ts'

const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000000'
const ROOT_DIR = '/tmp/veduta-codex-adapter-test'
const NOW = () => new Date('2026-08-09T10:00:00.000Z')

function contextWith(transport: FakeCodexTransport): AdapterContext {
  return fromPartial<AdapterContext>({
    connectionId: CONNECTION_ID,
    rootDir: ROOT_DIR,
    vault: undefined,
    secrets: fromPartial<SecretResolver>({ resolve: () => undefined }),
    fetchImpl: fromPartial<typeof fetch>({}),
    now: NOW,
    probe: async () => {},
    codexHome: join(ROOT_DIR, 'codex', CONNECTION_ID),
    codexTransport: async () => transport,
  })
}

describe('capabilities', () => {
  it('offers Veduta tools through the hardened dynamic-tool adapter', () => {
    expect(codexSubscriptionAdapter.capabilities.vedutaTools).toBe(true)
  })
})

describe('authorize', () => {
  it('returns the verification URL and user code from account/login/start', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/login/start': fakeCodexLoginStartResponse({
          loginId: 'login-1',
          userCode: 'ABCD-1234',
        }),
      },
    })

    const result = await codexSubscriptionAdapter.authorize(contextWith(transport), {})

    expect(result.state).toBe('waiting-for-user')
    if (result.state !== 'waiting-for-user') throw new Error('unreachable')
    expect(result.challenge.loginId).toBe('login-1')
    expect(result.challenge.verificationUrl).toBe('https://auth.openai.com/codex/device')
    expect(result.challenge.userCode).toBe('ABCD-1234')
    expect(result.challenge.expirySource).toBe('veduta-default')
    expect(new Date(result.challenge.expiresAt).getTime()).toBe(NOW().getTime() + 15 * 60_000)

    // No `initialize` here (issue #47): the pool's own factory
    // handshakes every transport it hands out before any verb sees it, so
    // `authorize()` goes straight to the device-code call.
    expect(transport.requests).toEqual([
      { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
    ])
  })

  it('uses the provider-reported expiry when account/login/start carries one', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/login/start': fakeCodexLoginStartResponse({
          loginId: 'login-2',
          userCode: 'WXYZ-9876',
          expiresAt: '2026-08-09T10:05:00.000Z',
        }),
      },
    })

    const result = await codexSubscriptionAdapter.authorize(contextWith(transport), {})
    if (result.state !== 'waiting-for-user') throw new Error('unreachable')
    expect(result.challenge.expirySource).toBe('provider')
    expect(result.challenge.expiresAt).toBe('2026-08-09T10:05:00.000Z')
  })

  it('surfaces the disabled-device-code reason when account/login/start fails', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/login/start': new Error('device-code login is not enabled for this account'),
      },
    })

    const error = await codexSubscriptionAdapter
      .authorize(contextWith(transport), {})
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('device-code login is disabled for this ChatGPT account'),
    })
  })

  it('does not re-initialize a pooled transport', async () => {
    // No `initialize` scripted at all: if `authorize()` regressed to sending
    // its own handshake again, the fake would reject the call with "no fake
    // Codex response scripted" rather than letting the test pass silently.
    const transport = createFakeCodexTransport({
      responses: {
        'account/login/start': fakeCodexLoginStartResponse({
          loginId: 'login-1',
          userCode: 'ABCD-1234',
        }),
      },
    })

    const result = await codexSubscriptionAdapter.authorize(contextWith(transport), {})

    expect(result.state).toBe('waiting-for-user')
    expect(transport.requests.some((request) => request.method === 'initialize')).toBe(false)
  })
})

describe('initializeCodexTransport', () => {
  it('the pool initializes every transport it creates', async () => {
    const transport = createFakeCodexTransport({
      responses: { initialize: fakeCodexInitializeResponse() },
    })
    const pool = new CodexSessionPool({
      factory: async () => {
        await initializeCodexTransport(transport)
        return transport
      },
    })

    await pool.get('conn-init', '/tmp/veduta-codex-init')

    expect(transport.requests[0]).toEqual({
      method: 'initialize',
      params: {
        clientInfo: { name: 'veduta', version: expect.any(String) },
        capabilities: { experimentalApi: true },
      },
    })
  })

  it('a version-mismatched app-server never reaches an adapter verb', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        initialize: fakeCodexInitializeResponse('0.999.0'),
        'account/read': fakeCodexConnectedAccountReadResponse(),
      },
    })
    // The exact close-on-failure pattern `server.ts`'s pool factory uses
    // (issue #47): a mis-pinned transport is closed, never returned.
    const pool = new CodexSessionPool({
      factory: async () => {
        try {
          await initializeCodexTransport(transport)
        } catch (error) {
          transport.close()
          throw error
        }
        return transport
      },
    })

    await expect(pool.get('conn-mismatch', '/tmp/veduta-codex-mismatch')).rejects.toMatchObject({
      code: 'unsupported',
    })
    expect(transport.closed).toBe(true)
    expect(transport.requests.map((request) => request.method)).toEqual(['initialize'])
  })
})

describe('refresh', () => {
  it('ignores a completion notification carrying another loginId', async () => {
    const transport = createFakeCodexTransport({
      responses: { 'account/read': fakeCodexSignedOutAccountReadResponse() },
      notifications: [
        { method: 'account/login/completed', params: { loginId: 'someone-elses-login' } },
      ],
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport), {
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T10:15:00.000Z',
      expirySource: 'veduta-default',
    })

    expect(result).toEqual({ state: 'waiting-for-user' })
  })

  it('recovers a completed device login from account/read when its notification was missed', async () => {
    const transport = createFakeCodexTransport({
      responses: { 'account/read': fakeCodexConnectedAccountReadResponse() },
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport), {
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T10:15:00.000Z',
      expirySource: 'veduta-default',
    })

    expect(result).toEqual({ state: 'connected', account: { label: 'ChatGPT Plus' } })
    expect(transport.requests.find((request) => request.method === 'account/read')?.params).toEqual(
      { refreshToken: false },
    )
  })

  it('reaches connected after account/login/completed matches the challenge', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/read': fakeCodexConnectedAccountReadResponse(),
      },
      notifications: [{ method: 'account/login/completed', params: { loginId: 'login-1' } }],
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport), {
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T10:15:00.000Z',
      expirySource: 'veduta-default',
    })

    expect(result).toEqual({ state: 'connected', account: { label: 'ChatGPT Plus' } })
    expect(transport.requests.some((r) => r.method === 'account/read')).toBe(true)
    expect(transport.requests.find((r) => r.method === 'account/read')?.params).toEqual({
      refreshToken: true,
    })
  })

  it('reports revoked when account/read rejects the credential', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/read': new ModelConnectionError(
          'unauthorized',
          'the provider rejected this credential',
        ),
      },
    })

    // A freshness re-check (no challenge argument) goes straight to
    // account/read, the same path a completed login takes next.
    const result = await codexSubscriptionAdapter.refresh(contextWith(transport))
    expect(result.state).toBe('revoked')
  })

  it('reports expired when the refresh call fails for any other reason', async () => {
    const transport = createFakeCodexTransport({
      responses: { 'account/read': new Error('a transient network error') },
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport))
    expect(result.state).toBe('expired')
  })

  it('reports expired when account/read succeeds but reports no signed-in account', async () => {
    // Observed 2026-08-10 against the real 0.146.1 binary: `account/read`
    // answers successfully — never a JSON-RPC error — with `account: null`
    // when no ChatGPT account is signed in.
    const transport = createFakeCodexTransport({
      responses: { 'account/read': fakeCodexSignedOutAccountReadResponse() },
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport))
    expect(result).toEqual({
      state: 'expired',
      reason: 'the Codex app-server reports no signed-in ChatGPT account',
    })
  })
})

describe('catalog', () => {
  it('exhausts model/list pagination', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        // Field names (`data`, `displayName`, a `null` exhausted cursor)
        // observed 2026-08-10 against the real 0.146.1 binary —
        // `ModelListResponseSchema`'s own doc comment.
        'model/list': (params: unknown, callIndex: number) => {
          if (callIndex === 0) {
            expect(params).toEqual({ includeHidden: false })
            return fakeCodexModelListResponse(
              [fakeCodexModelEntry({ id: 'model-a', displayName: 'Model A' })],
              'page-2',
            )
          }
          expect(params).toEqual({ includeHidden: false, cursor: 'page-2' })
          return fakeCodexModelListResponse([
            fakeCodexModelEntry({ id: 'model-b', isDefault: true }),
          ])
        },
      },
    })

    const entries = await codexSubscriptionAdapter.catalog(contextWith(transport))

    expect(entries).toEqual([
      {
        id: 'model-a',
        label: 'Model A',
        description: 'Model A description',
        isDefault: false,
        routable: true,
      },
      {
        id: 'model-b',
        label: 'model-b',
        description: 'model-b description',
        isDefault: true,
        routable: true,
      },
    ])
  })
})

describe('verify', () => {
  it('delegates to ctx.probe and surfaces its exact failure text', async () => {
    const transport = createFakeCodexTransport({ responses: {} })
    const ctx: AdapterContext = {
      ...contextWith(transport),
      probe: async () => {
        throw new Error('the probe turn failed')
      },
    }
    await expect(codexSubscriptionAdapter.verify(ctx, 'model-a')).rejects.toThrow(
      'the probe turn failed',
    )
  })
})

describe('revoke', () => {
  it('reports providerRevoked false and the exact note', async () => {
    const transport = createFakeCodexTransport({ responses: { 'account/logout': {} } })

    const result = await codexSubscriptionAdapter.revoke(contextWith(transport))

    expect(result).toEqual({
      providerRevoked: false,
      note: 'local credentials were cleared; the provider may still consider the session active — remove it in your OpenAI account settings to be certain',
    })
    expect(transport.requests).toEqual([{ method: 'account/logout', params: {} }])
  })
})

describe('availability', () => {
  function fakeTransportOf(response: unknown): CodexTransport {
    return createFakeCodexTransport({ responses: { initialize: response } })
  }

  it('names the missing binary and never spawns a probe transport', async () => {
    const probeTransport = async (): Promise<CodexTransport> => {
      throw new Error('must not be called when no binary is configured')
    }
    const adapter = createCodexAdapter({ resolveBinary: () => undefined, probeTransport })

    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp/root', env: {}, vaultAvailable: true }),
    )

    expect(result).toEqual({
      available: false,
      reason:
        'the Codex app-server binary is not installed: run deploy/codex-setup.sh on the instance (or set VEDUTA_CODEX_BIN to a pinned @openai/codex 0.146.1 binary) — see docs/SECURITY.md',
    })
  })

  it('is available when the probe transport reports the pinned version', async () => {
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () => fakeTransportOf(fakeCodexInitializeResponse()),
    })

    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp/root', env: {}, vaultAvailable: true }),
    )
    expect(result).toEqual({ available: true })
  })

  it('names both versions on a mismatched binary', async () => {
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () => fakeTransportOf(fakeCodexInitializeResponse('0.147.0')),
    })

    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp/root', env: {}, vaultAvailable: true }),
    )

    expect(result).toEqual({
      available: false,
      reason:
        'the installed Codex binary reports version 0.147.0; Veduta supports exactly 0.146.1 — install the pinned version',
    })
  })

  it('reports the raw userAgent when it carries no recognizable version', async () => {
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () =>
        fakeTransportOf({
          userAgent: 'codex-unknown-build',
          codexHome: '/home/user/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        }),
    })

    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp/root', env: {}, vaultAvailable: true }),
    )

    expect(result).toEqual({
      available: false,
      reason:
        'the installed Codex binary\'s initialize response reported no recognizable version in its userAgent ("codex-unknown-build"); Veduta supports exactly 0.146.1 — install the pinned version',
    })
  })

  it('runs the probe on every call — the registry owns the one availability cache', async () => {
    let probeCalls = 0
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () => {
        probeCalls++
        return fakeTransportOf(fakeCodexInitializeResponse())
      },
    })
    const env = fromPartial<Parameters<typeof adapter.availability>[0]>({
      rootDir: '/tmp/root',
      env: {},
      vaultAvailable: true,
    })

    await adapter.availability(env)
    await adapter.availability(env)

    expect(probeCalls).toBe(2)
  })
})
