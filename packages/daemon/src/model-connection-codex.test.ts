import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it, vi } from 'vitest'
import { createFakeCodexTransport, type FakeCodexTransport } from './codex-app-server-fake.ts'
import { CodexSessionPool, type CodexTransport } from './codex-app-server.ts'
import { ModelConnectionError, type AdapterContext } from './model-connection-adapter.ts'
import {
  CODEX_TURN_TIMEOUT_MS,
  codexSubscriptionAdapter,
  createCodexAdapter,
  initializeCodexTransport,
} from './model-connection-codex.ts'
import type { SecretResolver } from './model-routing.ts'
import type { SubscriptionStreamRequest } from './pi-provider-bridge.ts'

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

describe('authorize', () => {
  it('returns the verification URL and user code from account/login/start', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'account/login/start': {
          loginId: 'login-1',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'ABCD-1234',
        },
      },
    })

    const result = await codexSubscriptionAdapter.authorize(contextWith(transport), {})

    expect(result.state).toBe('waiting-for-user')
    if (result.state !== 'waiting-for-user') throw new Error('unreachable')
    expect(result.challenge.loginId).toBe('login-1')
    expect(result.challenge.verificationUrl).toBe('https://chatgpt.com/device')
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
        'account/login/start': {
          loginId: 'login-2',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'WXYZ-9876',
          expiresAt: '2026-08-09T10:05:00.000Z',
        },
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
        'account/login/start': {
          loginId: 'login-1',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'ABCD-1234',
        },
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
      responses: { initialize: { version: '0.146.1' } },
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
      params: { clientInfo: { name: 'veduta', version: expect.any(String) } },
    })
  })

  it('a version-mismatched app-server never reaches an adapter verb', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        initialize: { version: '0.999.0' },
        'account/read': { planType: 'ChatGPT Plus' },
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
      responses: {},
      notifications: [
        { method: 'account/login/completed', params: { loginId: 'someone-elses-login' } },
      ],
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport), {
      loginId: 'login-1',
      verificationUrl: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-08-09T10:15:00.000Z',
      expirySource: 'veduta-default',
    })

    expect(result).toEqual({ state: 'waiting-for-user' })
  })

  it('reaches connected after account/login/completed matches the challenge', async () => {
    const transport = createFakeCodexTransport({
      responses: { 'account/read': { planType: 'ChatGPT Plus' } },
      notifications: [{ method: 'account/login/completed', params: { loginId: 'login-1' } }],
    })

    const result = await codexSubscriptionAdapter.refresh(contextWith(transport), {
      loginId: 'login-1',
      verificationUrl: 'https://chatgpt.com/device',
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
})

describe('catalog', () => {
  it('exhausts model/list pagination', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'model/list': (params: unknown, callIndex: number) => {
          if (callIndex === 0) {
            expect(params).toEqual({ includeHidden: false })
            return { models: [{ id: 'model-a', label: 'Model A' }], nextCursor: 'page-2' }
          }
          expect(params).toEqual({ includeHidden: false, cursor: 'page-2' })
          return { models: [{ id: 'model-b', isDefault: true }] }
        },
      },
    })

    const entries = await codexSubscriptionAdapter.catalog(contextWith(transport))

    expect(entries).toEqual([
      { id: 'model-a', label: 'Model A', routable: true },
      { id: 'model-b', label: 'model-b', isDefault: true, routable: true },
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

function subscriptionRequest(signal?: AbortSignal): SubscriptionStreamRequest {
  return {
    modelId: 'gpt-5-codex',
    prompt: { systemPrompt: 'You are Veduta.', messages: [{ role: 'user', text: 'hi' }] },
    ...(signal ? { signal } : {}),
  }
}

/** Drains a `stream()` generator, collecting every yielded delta; returns the thrown error (if any) instead of letting it escape, so a refusal test can assert both the collected deltas and the error in one place. */
async function drain(
  generator: AsyncIterable<string>,
): Promise<{ deltas: string[]; error: unknown }> {
  const deltas: string[] = []
  try {
    for await (const delta of generator) deltas.push(delta)
    return { deltas, error: undefined }
  } catch (error) {
    return { deltas, error }
  }
}

describe('stream', () => {
  it('yields text deltas and completes on the turn-completed notification', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
      },
      notifications: [
        {
          method: 'item/updated',
          params: { threadId: 'thread-1', item: { type: 'agentMessage', delta: 'hel' } },
        },
        {
          method: 'item/updated',
          params: { threadId: 'thread-1', item: { type: 'agentMessage', delta: 'lo' } },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1' } },
      ],
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['hel', 'lo'])
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
    expect(transport.requests[0]?.params).toMatchObject({ approvalPolicy: 'never' })
    expect(transport.requests.some((request) => request.method === 'turn/interrupt')).toBe(false)
  })

  it('drops a reasoning item and forwards only text', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
      },
      notifications: [
        {
          method: 'item/updated',
          params: { threadId: 'thread-1', item: { type: 'reasoning', text: 'let me think' } },
        },
        {
          method: 'item/completed',
          params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'the answer' } },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1' } },
      ],
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['the answer'])
  })

  it('interrupts and refuses on a command-execution item', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
        'turn/interrupt': {},
      },
      notifications: [
        {
          method: 'item/updated',
          params: {
            threadId: 'thread-1',
            item: { type: 'commandExecution', text: 'rm -rf /' },
          },
        },
      ],
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(deltas).toEqual([])
    expect(error).toMatchObject({
      code: 'unsupported',
      message:
        'the Codex turn attempted a tool action; refusing to run a turn that could act outside Veduta',
    })
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
      'turn/interrupt',
    ])
    expect(
      transport.requests.find((request) => request.method === 'turn/interrupt')?.params,
    ).toEqual({ threadId: 'thread-1' })
  })

  it('sends turn/interrupt and abandons the thread when the turn is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/interrupt': {},
      },
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(
        contextWith(transport),
        subscriptionRequest(controller.signal),
      ),
    )

    expect(deltas).toEqual([])
    expect(error).toMatchObject({ code: 'unsupported' })
    // `turn/start` is never reached — no thread reuse, no resume, nothing
    // to interrupt beyond the one `turn/interrupt` best-effort call.
    expect(transport.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/interrupt',
    ])
  })

  it('thread/start carries the confirmed tool-restriction config', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
      },
      notifications: [{ method: 'turn/completed', params: { threadId: 'thread-1' } }],
    })

    await drain(codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()))

    expect(transport.requests[0]).toEqual({
      method: 'thread/start',
      params: {
        model: 'gpt-5-codex',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: { web_search: 'disabled', disabled_tools: true },
        dynamicTools: [],
        cwd: join(ROOT_DIR, 'codex', CONNECTION_ID),
      },
    })
  })

  it('ignores item notifications for another thread', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
      },
      notifications: [
        {
          method: 'item/updated',
          params: {
            threadId: 'some-other-thread',
            item: { type: 'agentMessage', delta: 'nope' },
          },
        },
        {
          method: 'item/updated',
          params: { threadId: 'thread-1', item: { type: 'agentMessage', delta: 'yes' } },
        },
        { method: 'turn/completed', params: { threadId: 'some-other-thread' } },
        { method: 'turn/completed', params: { threadId: 'thread-1' } },
      ],
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['yes'])
  })

  it("a device-code poll never consumes a live turn's items", async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': { turnId: 'turn-1' },
      },
      notifications: [
        {
          method: 'item/updated',
          params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'hello' } },
        },
        { method: 'turn/completed', params: { threadId: 'thread-1' } },
      ],
    })

    // A concurrent device-code poll on the same pooled transport reads via
    // `recentNotifications()` — the way `refresh()`'s login-completed check
    // does — before the turn's own subscription ever gets a chance to run.
    // It must never drain what that subscription still needs.
    transport.recentNotifications()

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(error).toBeUndefined()
    expect(deltas).toEqual(['hello'])
  })

  it('a failed turn/start releases the notification subscription (the transport returns to idle)', async () => {
    const transport = createFakeCodexTransport({
      responses: {
        'thread/start': { threadId: 'thread-1' },
        'turn/start': new Error('the app-server rejected turn/start'),
      },
    })

    const { deltas, error } = await drain(
      codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
    )

    expect(deltas).toEqual([])
    expect(error).toBeDefined()
    // The subscription acquired before `turn/start` must still be released
    // on this failure path — otherwise the transport never reports idle
    // again, and a pooled transport with a leaked subscriber is never
    // reused cleanly.
    expect(transport.idle()).toBe(true)
  })

  it('an abort during a silent turn interrupts immediately', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': { threadId: 'thread-1' },
          'turn/start': { turnId: 'turn-1' },
          'turn/interrupt': {},
        },
        // No notification ever arrives — a silent turn: `subscription.next()`
        // would otherwise hang until this connection's own turn bound.
      })

      const drainPromise = drain(
        codexSubscriptionAdapter.stream!(
          contextWith(transport),
          subscriptionRequest(controller.signal),
        ),
      )

      await vi.advanceTimersByTimeAsync(0) // let thread/start + turn/start settle
      controller.abort()
      // No further time advance: the abort must be noticed as soon as it
      // fires — raced directly against the notification wait — not only
      // once a further frame arrives or the `CODEX_TURN_TIMEOUT_MS` bound
      // does.
      const { deltas, error } = await drainPromise

      expect(deltas).toEqual([])
      expect(error).toMatchObject({ code: 'unsupported' })
      expect(transport.requests.map((request) => request.method)).toEqual([
        'thread/start',
        'turn/start',
        'turn/interrupt',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a turn that exceeds the turn bound', async () => {
    vi.useFakeTimers()
    try {
      const transport = createFakeCodexTransport({
        responses: {
          'thread/start': { threadId: 'thread-1' },
          'turn/start': { turnId: 'turn-1' },
          'turn/interrupt': {},
        },
        // No `turn/completed` ever arrives — the turn bound is what ends this.
      })

      const drainPromise = drain(
        codexSubscriptionAdapter.stream!(contextWith(transport), subscriptionRequest()),
      )
      await vi.advanceTimersByTimeAsync(CODEX_TURN_TIMEOUT_MS)
      const { deltas, error } = await drainPromise

      expect(deltas).toEqual([])
      expect(error).toMatchObject({ code: 'unreachable' })
      expect(transport.requests.some((request) => request.method === 'turn/interrupt')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
      probeTransport: async () => fakeTransportOf({ version: '0.146.1' }),
    })

    const result = await adapter.availability(
      fromPartial({ rootDir: '/tmp/root', env: {}, vaultAvailable: true }),
    )
    expect(result).toEqual({ available: true })
  })

  it('names both versions on a mismatched binary', async () => {
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () => fakeTransportOf({ version: '0.147.0' }),
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

  it('runs the probe on every call — the registry owns the one availability cache', async () => {
    let probeCalls = 0
    const adapter = createCodexAdapter({
      resolveBinary: () => '/opt/codex/bin/codex',
      probeTransport: async () => {
        probeCalls++
        return fakeTransportOf({ version: '0.146.1' })
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
