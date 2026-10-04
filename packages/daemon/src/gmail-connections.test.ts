import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GMAIL_READ_SCOPE } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailConnections } from './gmail-connections.ts'
import { loadIngestionConfig, saveIngestionConfig } from './ingestion-config.ts'
import { PreFilterRulesSchema } from './pre-filter.ts'
import { SecretsVault } from './secrets-vault.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(fetchFn: typeof fetch) {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-gmail-connections-'))
  roots.push(rootDir)
  const vault = SecretsVault.open(rootDir, Buffer.from('test-key'))
  const connections = new GmailConnections({
    rootDir,
    vault,
    secrets: vault,
    allowedRedirectOrigins: ['https://veduta.test'],
    fetchFn,
  })
  return { rootDir, vault, connections }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('passive Gmail connections', () => {
  it('authorizes two accounts with only the declared read scope and no message access', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(String(init?.body))
        return json({
          access_token: `access-${body.get('code')}`,
          refresh_token: `refresh-${body.get('code')}`,
          scope: GMAIL_READ_SCOPE,
        })
      }
      if (url.endsWith('/profile')) {
        const email =
          init?.headers && 'authorization' in init.headers
            ? String(init.headers.authorization).endsWith('first')
              ? 'first@gmail.test'
              : 'second@gmail.test'
            : 'unknown@gmail.test'
        return json({ emailAddress: email })
      }
      throw new Error(`unexpected Gmail endpoint: ${url}`)
    })
    const { rootDir, vault, connections } = fixture(fetchFn)
    const first = connections.create({
      name: 'Personal',
      clientId: 'client',
      clientSecret: 'private-value',
    }).connections[0]!
    const second = connections.create({
      name: 'Work',
      clientId: 'client',
      clientSecret: 'private-value',
    }).connections[1]!
    for (const [record, code] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      const { authorizationUrl } = connections.beginAuthorization(record.id, 'https://veduta.test')
      const url = new URL(authorizationUrl)
      expect(url.searchParams.get('scope')).toBe(GMAIL_READ_SCOPE)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('redirect_uri')).toBe('https://veduta.test/app/settings/gmail')
      await connections.completeAuthorization(record.id, code, url.searchParams.get('state')!)
    }
    expect(connections.snapshot().connections.map((record) => record.accountEmail)).toEqual([
      'first@gmail.test',
      'second@gmail.test',
    ])
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    ])
    const disk = readFileSync(join(rootDir, 'gmail-connections.json'), 'utf8')
    expect(disk).not.toContain('private-value')
    expect(disk).not.toContain('refresh-first')
    expect(vault.resolve(`secret://vault/gmail-refresh-token-${first.id}`)).toBe('refresh-first')
    connections.remove(first.id)
    expect(vault.resolve(`secret://vault/gmail-refresh-token-${first.id}`)).toBeUndefined()
    expect(vault.resolve(`secret://vault/gmail-refresh-token-${second.id}`)).toBe('refresh-second')
    expect(connections.snapshot().connections).toHaveLength(1)
  })

  it('rejects a broad scope and replays of one authorization state', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json({ access_token: 'access', refresh_token: 'refresh', scope: 'https://mail.google.com/' }),
    )
    const { connections } = fixture(fetchFn)
    const id = connections.create({
      name: 'Personal',
      clientId: 'id',
      clientSecret: 'private-value',
    }).connections[0]!.id
    const { authorizationUrl } = connections.beginAuthorization(id, 'https://veduta.test')
    const state = new URL(authorizationUrl).searchParams.get('state')!
    await expect(connections.completeAuthorization(id, 'code', state)).rejects.toThrow(/read-only/)
    await expect(connections.completeAuthorization(id, 'code', state)).rejects.toThrow(/expired/)
    expect(connections.snapshot().connections[0]?.state).toBe('failed')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid_client', /invalid_client.*Client ID.*full Client secret/],
    ['invalid_grant', /invalid_grant.*new authorization/],
    ['redirect_uri_mismatch', /redirect_uri_mismatch.*exact redirect URI/],
    ['deleted_client', /deleted_client.*Restore.*Google OAuth setup/],
    ['unauthorized_client', /unauthorized_client.*Web application/],
    ['invalid_request', /invalid_request.*Google OAuth setup/],
  ])(
    'preserves a safe recovery reason for Google %s without provider text',
    async (error, reason) => {
      const fetchFn = vi.fn<typeof fetch>(async () =>
        json(
          { error, error_description: 'PROVIDER-ECHO-private-value-code', extra: 'SECRET' },
          400,
        ),
      )
      const { rootDir, vault, connections } = fixture(fetchFn)
      const id = connections.create({
        name: 'Personal',
        clientId: 'id',
        clientSecret: 'private-value',
      }).connections[0]!.id
      const { authorizationUrl } = connections.beginAuthorization(id, 'https://veduta.test')
      const state = new URL(authorizationUrl).searchParams.get('state')!
      await expect(connections.completeAuthorization(id, 'code', state)).rejects.toThrow(reason)
      const restored = new GmailConnections({
        rootDir,
        vault,
        secrets: vault,
        allowedRedirectOrigins: ['https://veduta.test'],
        fetchFn,
      })
      expect(restored.snapshot().connections[0]).toMatchObject({
        state: 'failed',
        reason: expect.stringMatching(reason),
      })
      expect(vault.resolve(`secret://vault/gmail-refresh-token-${id}`)).toBeUndefined()
      expect(vault.resolve(`secret://vault/gmail-oauth-verifier-${id}`)).toBeUndefined()
      const files = readdirSync(rootDir)
        .filter((name) => name.startsWith('gmail-connections.json'))
        .map((name) => readFileSync(join(rootDir, name), 'utf8'))
        .join('\n')
      expect(files).not.toContain('PROVIDER-ECHO')
      expect(files).not.toContain('private-value')
      expect(files).not.toContain('SECRET')
      expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
        'https://oauth2.googleapis.com/token',
      ])
    },
  )

  it.each([
    ['unknown', JSON.stringify({ error: 'PROVIDER-SECRET', error_description: 'PROVIDER-ECHO' })],
    ['malformed', 'PROVIDER-ECHO-not-json'],
    ['missing code', JSON.stringify({ error_description: 'PROVIDER-ECHO' })],
    [
      'oversized',
      JSON.stringify({ error: 'invalid_client', error_description: 'PROVIDER-ECHO'.repeat(1024) }),
    ],
  ])('uses a safe fallback for an %s Google failure response', async (_kind, body) => {
    const { connections } = fixture(async () => new Response(body, { status: 400 }))
    const id = connections.create({
      name: 'Personal',
      clientId: 'id',
      clientSecret: 'private-value',
    }).connections[0]!.id
    const { authorizationUrl } = connections.beginAuthorization(id, 'https://veduta.test')
    const state = new URL(authorizationUrl).searchParams.get('state')!
    await expect(connections.completeAuthorization(id, 'code', state)).rejects.toThrow(
      'Gmail authorization was rejected',
    )
    expect(connections.snapshot().connections[0]?.reason).toBe('Gmail authorization was rejected')
    expect(JSON.stringify(connections.snapshot())).not.toContain('PROVIDER-')
  })

  it('fails a stalled Google error body within the authorization deadline', async () => {
    vi.useFakeTimers()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
        controller.enqueue(new TextEncoder().encode('{"error":"invalid_client",'))
      },
    })
    const { vault, connections } = fixture(async () => new Response(body, { status: 400 }))
    const id = connections.create({
      name: 'Personal',
      clientId: 'id',
      clientSecret: 'private-value',
    }).connections[0]!.id
    const { authorizationUrl } = connections.beginAuthorization(id, 'https://veduta.test')
    const state = new URL(authorizationUrl).searchParams.get('state')!
    const completion = connections.completeAuthorization(id, 'code', state).catch(() => {})
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(connections.snapshot().connections[0]).toMatchObject({
        state: 'failed',
        reason: expect.stringMatching(/timed out.*review/),
      })
      expect(vault.resolve(`secret://vault/gmail-oauth-verifier-${id}`)).toBeUndefined()
    } finally {
      try {
        stream.close()
      } catch {
        // Cancellation already closed the response stream.
      }
      await completion
      vi.useRealTimers()
    }
  })

  it.each(['invalid_client', 'deleted_client', 'unauthorized_client'])(
    'explains original-client recovery for a connected account rejected with %s',
    async (error) => {
      let rejected = false
      const clients: (string | null)[] = []
      const { connections } = fixture(async (input, init) => {
        if (String(input).endsWith('/token')) {
          clients.push(new URLSearchParams(String(init?.body)).get('client_id'))
          return rejected
            ? json({ error }, 400)
            : json({ access_token: 'access', refresh_token: 'refresh', scope: GMAIL_READ_SCOPE })
        }
        return json({ emailAddress: 'first@gmail.test' })
      })
      connections.configureOAuthClient({ clientId: 'original', clientSecret: 'original-secret' })
      const id = connections.create({ name: 'Personal' }).connections[0]!.id
      const initial = new URL(
        connections.beginAuthorization(id, 'https://veduta.test').authorizationUrl,
      )
      await connections.completeAuthorization(id, 'first-code', initial.searchParams.get('state')!)
      connections.configureOAuthClient({ clientId: 'replacement', clientSecret: 'new-secret' })
      const reconnect = new URL(
        connections.beginAuthorization(id, 'https://veduta.test').authorizationUrl,
      )
      rejected = true
      await expect(
        connections.completeAuthorization(id, 'new-code', reconnect.searchParams.get('state')!),
      ).rejects.toThrow(/original.*remove.*add it again/)
      expect(clients).toEqual(['original', 'original'])
      expect(connections.snapshot().connections[0]).toMatchObject({
        id,
        accountEmail: 'first@gmail.test',
        state: 'failed',
        reason: expect.stringMatching(/original.*remove.*add it again/),
      })
    },
  )

  it('adopts legacy credentials without touching Google until explicit verification', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-gmail-legacy-'))
    roots.push(rootDir)
    const vault = SecretsVault.open(rootDir, Buffer.from('test-key'))
    vault.set('gmail-client-id', 'old-id')
    vault.set('gmail-client-secret', 'old-secret')
    vault.set('gmail-refresh-token', 'old-refresh')
    saveIngestionConfig(rootDir, {
      ...loadIngestionConfig(rootDir),
      sources: {
        gmail: {
          adapter: 'gmail-push',
          verification: 'channel-token',
          secret: 'secret://vault/ingest-gmail-token',
          spaceId: 'spc-health',
          ratePerMinute: 60,
          filters: PreFilterRulesSchema.parse({}),
          gmail: { topicName: 'legacy-topic', subscription: 'legacy-sub' },
          google: {
            clientIdRef: 'secret://vault/gmail-client-id',
            clientSecretRef: 'secret://vault/gmail-client-secret',
            refreshTokenRef: 'secret://vault/gmail-refresh-token',
          },
        },
      },
    })
    const fetchFn = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/token')
        ? json({ access_token: 'access', expires_in: 3600 })
        : json({ emailAddress: 'old@gmail.test' }),
    )
    const options = {
      rootDir,
      vault,
      secrets: vault,
      allowedRedirectOrigins: ['https://veduta.test'],
      fetchFn,
    }
    const first = new GmailConnections(options)
    const second = new GmailConnections(options)
    expect(first.snapshot().connections).toHaveLength(1)
    expect(second.snapshot().connections).toHaveLength(1)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(second.snapshot().connections[0]?.state).toBe('needs_authorization')
    await second.verifyLegacy('svc-gmail-legacy')
    expect(second.snapshot().connections[0]?.accountEmail).toBe('old@gmail.test')
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    ])
    second.remove('svc-gmail-legacy')
    expect(new GmailConnections(options).snapshot().connections).toEqual([])
  })

  it('reuses protected installation credentials after restart and removing an account', async () => {
    const requests: string[] = []
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('client_id')).toBe('shared-client')
        expect(body.get('client_secret')).toBe('shared-secret')
        return json({
          access_token: body.get('code'),
          refresh_token: `refresh-${body.get('code')}`,
          scope: GMAIL_READ_SCOPE,
        })
      }
      if (url.endsWith('/profile')) {
        const bearer = new Headers(init?.headers).get('authorization')
        return json({
          emailAddress: bearer === 'Bearer first' ? 'first@gmail.test' : 'second@gmail.test',
        })
      }
      throw new Error('Setup accessed mailbox content')
    }
    const { rootDir, vault, connections } = fixture(fetchFn)
    connections.configureOAuthClient({ clientId: 'shared-client', clientSecret: 'shared-secret' })
    expect(connections.snapshot().oauthClient).toEqual({ configured: true })
    expect(requests).toEqual([])
    const first = connections.create({ name: 'First' }).connections[0]!
    const second = connections.create({ name: 'Second' }).connections[1]!
    for (const [account, code] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      const url = new URL(
        connections.beginAuthorization(account.id, 'https://veduta.test').authorizationUrl,
      )
      await connections.completeAuthorization(account.id, code, url.searchParams.get('state')!)
    }
    connections.remove(first.id)
    expect(vault.resolve(`secret://vault/gmail-refresh-token-${first.id}`)).toBeUndefined()
    expect(vault.resolve(`secret://vault/gmail-refresh-token-${second.id}`)).toBe('refresh-second')
    const restored = new GmailConnections({
      rootDir,
      vault,
      secrets: vault,
      allowedRedirectOrigins: ['https://veduta.test'],
      fetchFn,
    })
    restored.remove(second.id)
    const next = restored.create({ name: 'Third' }).connections[0]!
    expect(
      new URL(
        restored.beginAuthorization(next.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('shared-client')
    const disk = readFileSync(join(rootDir, 'gmail-connections.json'), 'utf8')
    const backup = readdirSync(rootDir)
      .filter((file) => file.startsWith('gmail-connections.json.bak-'))
      .map((file) => readFileSync(join(rootDir, file), 'utf8'))
      .join('\n')
    for (const secret of ['shared-client', 'shared-secret', 'refresh-first', 'refresh-second']) {
      expect(disk).not.toContain(secret)
      expect(backup).not.toContain(secret)
      expect(JSON.stringify(restored.snapshot())).not.toContain(secret)
    }
    expect(requests).toHaveLength(4)
  })

  it('keeps an in-flight authorization bound to its client when installation settings change', async () => {
    let exchangedClient: string | null = null
    const { connections } = fixture(async (input, init) => {
      if (String(input).endsWith('/token')) {
        exchangedClient = new URLSearchParams(String(init?.body)).get('client_id')
        return json({ access_token: 'access', refresh_token: 'refresh', scope: GMAIL_READ_SCOPE })
      }
      return json({ emailAddress: 'first@gmail.test' })
    })
    connections.configureOAuthClient({
      clientId: 'original-client',
      clientSecret: 'original-secret',
    })
    const account = connections.create({ name: 'First' }).connections[0]!
    const url = new URL(
      connections.beginAuthorization(account.id, 'https://veduta.test').authorizationUrl,
    )
    connections.configureOAuthClient({
      clientId: 'replacement-client',
      clientSecret: 'replacement-secret',
    })
    await connections.completeAuthorization(account.id, 'code', url.searchParams.get('state')!)
    expect(exchangedClient).toBe('original-client')
    expect(
      new URL(
        connections.beginAuthorization(account.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('original-client')
    const next = connections.create({ name: 'Second' }).connections[1]!
    expect(
      new URL(
        connections.beginAuthorization(next.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('replacement-client')
  })

  it('requires configuration before a new account and recovers a draft after correcting the client', () => {
    const { connections } = fixture(async () => {
      throw new Error('Setup contacted Google')
    })
    expect(() => connections.create({ name: 'First' })).toThrow(/Google OAuth/)
    expect(connections.snapshot().connections).toEqual([])
    connections.configureOAuthClient({
      clientId: 'incorrect-client',
      clientSecret: 'incorrect-secret',
    })
    const draft = connections.create({ name: 'First' }).connections[0]!
    const url = new URL(
      connections.beginAuthorization(draft.id, 'https://veduta.test').authorizationUrl,
    )
    connections.failAuthorization(draft.id, url.searchParams.get('state')!, 'access_denied')
    connections.configureOAuthClient({
      clientId: 'corrected-client',
      clientSecret: 'corrected-secret',
    })
    expect(
      new URL(
        connections.beginAuthorization(draft.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('corrected-client')
  })

  it('rejects a second-device authorization restart while Google verifies the original client', async () => {
    let releaseToken!: (response: Response) => void
    const tokenResponse = new Promise<Response>((resolve) => {
      releaseToken = resolve
    })
    const { connections } = fixture(async (input, init) => {
      if (String(input).endsWith('/token')) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('client_id')).toBe('original-client')
        expect(body.get('client_secret')).toBe('original-secret')
        if (body.get('grant_type') === 'authorization_code') return tokenResponse
        expect(body.get('refresh_token')).toBe('original-refresh')
        return json({ access_token: 'refreshed-access', expires_in: 3600 })
      }
      return json({ emailAddress: 'first@gmail.test' })
    })
    connections.configureOAuthClient({
      clientId: 'original-client',
      clientSecret: 'original-secret',
    })
    const account = connections.create({ name: 'First' }).connections[0]!
    const url = new URL(
      connections.beginAuthorization(account.id, 'https://veduta.test').authorizationUrl,
    )
    const completion = connections.completeAuthorization(
      account.id,
      'code',
      url.searchParams.get('state')!,
    )
    try {
      expect(connections.snapshot().connections[0]?.state).toBe('verifying')
      connections.configureOAuthClient({
        clientId: 'replacement-client',
        clientSecret: 'replacement-secret',
      })
      expect(() => connections.beginAuthorization(account.id, 'https://veduta.test')).toThrow(
        /verification is already in progress/,
      )
    } finally {
      releaseToken(
        json({
          access_token: 'access',
          refresh_token: 'original-refresh',
          scope: GMAIL_READ_SCOPE,
        }),
      )
      await completion
    }
    expect(await connections.verifyAccount(account.id)).toBe('first@gmail.test')
    expect(connections.snapshot().connections[0]?.state).toBe('ready')
  })

  it('reuses an unambiguous existing Google client without re-entering credentials', () => {
    const fetchFn = async () => {
      throw new Error('Migration contacted Google')
    }
    const { rootDir, vault, connections } = fixture(fetchFn)
    const old = connections.create({
      name: 'Existing',
      clientId: 'existing-client',
      clientSecret: 'existing-secret',
    }).connections[0]!
    const restored = new GmailConnections({
      rootDir,
      vault,
      secrets: vault,
      allowedRedirectOrigins: ['https://veduta.test'],
      fetchFn,
    })
    restored.remove(old.id)
    const next = restored.create({ name: 'Second account' }).connections[0]!
    expect(
      new URL(
        restored.beginAuthorization(next.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('existing-client')
  })

  it('requires a deliberate installation configuration when existing clients differ', () => {
    const fetchFn = async () => {
      throw new Error('Migration contacted Google')
    }
    const { rootDir, vault, connections } = fixture(fetchFn)
    for (const clientId of ['first-client', 'second-client'])
      connections.create({ name: clientId, clientId, clientSecret: 'secret' })
    const restored = new GmailConnections({
      rootDir,
      vault,
      secrets: vault,
      allowedRedirectOrigins: ['https://veduta.test'],
      fetchFn,
    })
    expect(() => restored.create({ name: 'New account' })).toThrow(/Google OAuth/)
    expect(restored.snapshot().connections).toHaveLength(2)
  })

  it('ignores unavailable existing clients when adopting an agreed usable configuration', () => {
    const fetchFn = async () => {
      throw new Error('Migration contacted Google')
    }
    const { rootDir, vault, connections } = fixture(fetchFn)
    const unavailable = connections.create({
      name: 'Unavailable',
      clientId: 'unavailable-client',
      clientSecret: 'unavailable-secret',
    }).connections[0]!
    connections.create({
      name: 'Existing',
      clientId: 'existing-client',
      clientSecret: 'existing-secret',
    })
    vault.delete(`gmail-client-id-${unavailable.id}`)
    vault.delete(`gmail-client-secret-${unavailable.id}`)
    const restored = new GmailConnections({
      rootDir,
      vault,
      secrets: vault,
      allowedRedirectOrigins: ['https://veduta.test'],
      fetchFn,
    })
    expect(restored.snapshot().oauthClient).toEqual({ configured: true })
    const next = restored.create({ name: 'New account' }).connections[2]!
    expect(
      new URL(
        restored.beginAuthorization(next.id, 'https://veduta.test').authorizationUrl,
      ).searchParams.get('client_id'),
    ).toBe('existing-client')
    expect(restored.snapshot().connections).toHaveLength(3)
  })
})
