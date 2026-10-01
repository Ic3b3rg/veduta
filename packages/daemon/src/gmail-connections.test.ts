import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GMAIL_READ_SCOPE } from '@veduta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { GmailConnections } from './gmail-connections.ts'
import { loadIngestionConfig, saveIngestionConfig } from './ingestion-config.ts'
import { PreFilterRulesSchema } from './pre-filter.ts'
import { SecretsVault } from './secrets-vault.ts'

function fixture(fetchFn: typeof fetch) {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-gmail-connections-'))
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

  it('adopts legacy credentials without touching Google until explicit verification', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-gmail-legacy-'))
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
  })
})
