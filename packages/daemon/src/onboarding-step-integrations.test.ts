import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadIngestionConfig } from './ingestion-config.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { applyIntegrations, type IntegrationsDeps } from './onboarding-step-integrations.ts'
import { VaultUnavailableError } from './onboarding-status.ts'
import { SecretsVault, VAULT_FILE_NAME } from './secrets-vault.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-integrations-'))
  return rootDir
}

function withFirstSpace(dir: string): void {
  saveOnboardingConfig(dir, {
    version: 1,
    steps: { 'first-space': 'completed' },
    firstSpace: { name: 'Personal', slug: 'personal' },
  })
}

let tokenCounter = 0
function testDeps(
  dir: string,
  vault: SecretsVault | undefined,
  domain: string | null = null,
): IntegrationsDeps {
  return {
    rootDir: dir,
    vault,
    domain,
    randomToken: () => `test-token-${(tokenCounter += 1)}`,
  }
}

describe('applyIntegrations', () => {
  it('skip marks the step skipped and touches neither vault nor ingestion.json', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    applyIntegrations(testDeps(dir, undefined), { skip: true })
    expect(loadOnboardingConfig(dir).steps.integrations).toBe('skipped')
    expect(existsSync(join(dir, VAULT_FILE_NAME))).toBe(false)
    expect(loadIngestionConfig(dir).sources).toEqual({})
  })

  it('requires the first-space step to be completed first', () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    expect(() =>
      applyIntegrations(testDeps(dir, vault), {
        gmail: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'refresh-token',
          topicName: 'topic',
          subscription: 'sub',
        },
      }),
    ).toThrow(/complete the first-space step/)
  })

  it('throws VaultUnavailableError when no vault is open', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    expect(() =>
      applyIntegrations(testDeps(dir, undefined), {
        gmail: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'refresh-token',
          topicName: 'topic',
          subscription: 'sub',
        },
      }),
    ).toThrow(VaultUnavailableError)
  })

  it('gmail-only: writes credentials, a channel token, and a gmail source', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault), {
      gmail: {
        clientId: 'gmail-client-id-value',
        clientSecret: 'gmail-client-secret-value',
        refreshToken: 'gmail-refresh-token-value',
        topicName: 'projects/p/topics/gmail',
        subscription: 'projects/p/subscriptions/gmail',
      },
    })

    expect(vault.resolve('secret://vault/gmail-client-id')).toBe('gmail-client-id-value')
    expect(vault.resolve('secret://vault/gmail-client-secret')).toBe('gmail-client-secret-value')
    expect(vault.resolve('secret://vault/gmail-refresh-token')).toBe('gmail-refresh-token-value')
    expect(vault.has('ingest-gmail-token')).toBe(true)
    expect(vault.has('ingest-calendar-token')).toBe(false)

    const ingestion = loadIngestionConfig(dir)
    expect(ingestion.sources.calendar).toBeUndefined()
    const gmail = ingestion.sources.gmail
    expect(gmail?.adapter).toBe('gmail-push')
    expect(gmail?.spaceId).toBe('spc-personal')
    expect(gmail?.verification).toBe('channel-token')
    expect(gmail?.gmail).toEqual({
      topicName: 'projects/p/topics/gmail',
      subscription: 'projects/p/subscriptions/gmail',
    })
    expect(loadOnboardingConfig(dir).steps.integrations).toBe('completed')
  })

  it('uses the recorded config.firstSpace.spaceId verbatim rather than re-deriving it from the slug', () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: { 'first-space': 'completed' },
      // A spaceId that does NOT follow the `spc-<slug>` scheme — proves the
      // recorded id wins over re-deriving it.
      firstSpace: { name: 'Personal', slug: 'personal', spaceId: 'spc-custom-id' },
    })
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault), {
      gmail: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        topicName: 'topic',
        subscription: 'sub',
      },
    })

    expect(loadIngestionConfig(dir).sources.gmail?.spaceId).toBe('spc-custom-id')
  })

  it('calendar-only: uses the loopback ingest address when domain is null', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault, null), {
      calendar: {
        clientId: 'cal-client-id',
        clientSecret: 'cal-client-secret',
        refreshToken: 'cal-refresh-token',
        calendarId: 'primary',
      },
    })

    const ingestion = loadIngestionConfig(dir)
    expect(ingestion.sources.gmail).toBeUndefined()
    expect(ingestion.sources.calendar?.calendar).toEqual({
      calendarId: 'primary',
      address: 'http://127.0.0.1:8787/api/ingest/calendar',
    })
  })

  it('calendar-only: uses the public https address when a domain is configured', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault, 'veduta.example.com'), {
      calendar: {
        clientId: 'cal-client-id',
        clientSecret: 'cal-client-secret',
        refreshToken: 'cal-refresh-token',
        calendarId: 'primary',
      },
    })

    expect(loadIngestionConfig(dir).sources.calendar?.calendar?.address).toBe(
      'https://veduta.example.com/api/ingest/calendar',
    )
  })

  it('both gmail and calendar in one apply get independent Google credentials — one never clobbers the other', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault), {
      gmail: {
        clientId: 'gmail-oauth-client',
        clientSecret: 'gmail-oauth-secret',
        refreshToken: 'gmail-oauth-refresh',
        topicName: 'projects/p/topics/gmail',
        subscription: 'projects/p/subscriptions/gmail',
      },
      calendar: {
        clientId: 'calendar-oauth-client',
        clientSecret: 'calendar-oauth-secret',
        refreshToken: 'calendar-oauth-refresh',
        calendarId: 'primary',
      },
    })

    const ingestion = loadIngestionConfig(dir)
    expect(ingestion.sources.gmail).toBeDefined()
    expect(ingestion.sources.calendar).toBeDefined()
    // Two entirely different OAuth clients, each preserved under its own
    // namespaced vault entry. This guards against Gmail and Calendar
    // silently overwriting each other's credentials through one shared
    // `google-*` entry.
    expect(vault.resolve('secret://vault/gmail-client-secret')).toBe('gmail-oauth-secret')
    expect(vault.resolve('secret://vault/gmail-refresh-token')).toBe('gmail-oauth-refresh')
    expect(vault.resolve('secret://vault/calendar-client-secret')).toBe('calendar-oauth-secret')
    expect(vault.resolve('secret://vault/calendar-refresh-token')).toBe('calendar-oauth-refresh')
  })

  it('keep-existing with no prior stored credential throws, naming the missing credential (never a value)', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    expect(() =>
      applyIntegrations(testDeps(dir, vault), {
        gmail: {
          clientId: 'client-id',
          topicName: 'topic',
          subscription: 'sub',
        },
      }),
    ).toThrow(/missing gmail-client-secret/)
  })

  it('keep-existing on calendar with no prior stored calendar credential throws, even when gmail has one', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    applyIntegrations(testDeps(dir, vault), {
      gmail: {
        clientId: 'gmail-client-id-value',
        clientSecret: 'gmail-client-secret-value',
        refreshToken: 'gmail-refresh-token-value',
        topicName: 'topic',
        subscription: 'sub',
      },
    })

    expect(() =>
      applyIntegrations(testDeps(dir, vault), {
        calendar: { clientId: 'calendar-client-id-value', calendarId: 'primary' },
      }),
    ).toThrow(/missing calendar-client-secret/)
  })

  it('produced ingestion.json passes IngestionConfigSchema validation via loadIngestionConfig', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)

    applyIntegrations(testDeps(dir, vault), {
      gmail: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        topicName: 'topic',
        subscription: 'sub',
      },
      calendar: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        calendarId: 'primary',
      },
    })

    // loadIngestionConfig itself runs IngestionConfigSchema.parse; reaching
    // here without throwing is the assertion.
    expect(() => loadIngestionConfig(dir)).not.toThrow()
  })

  it('channel token is stable across re-apply (never rotated)', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const request = {
      gmail: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        topicName: 'topic',
        subscription: 'sub',
      },
    }

    applyIntegrations(testDeps(dir, vault), request)
    const firstToken = vault.resolve('secret://vault/ingest-gmail-token')
    applyIntegrations(testDeps(dir, vault), request)
    const secondToken = vault.resolve('secret://vault/ingest-gmail-token')

    expect(secondToken).toBe(firstToken)
  })

  it('creates a .bak of the vault on a second apply', () => {
    const dir = freshRoot()
    withFirstSpace(dir)
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const request = {
      gmail: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        topicName: 'topic',
        subscription: 'sub',
      },
    }

    applyIntegrations(testDeps(dir, vault), request)
    let backups = readdirSync(dir).filter((entry) => entry.startsWith(`${VAULT_FILE_NAME}.bak-`))
    expect(backups).toHaveLength(0)

    applyIntegrations(testDeps(dir, vault), request)
    backups = readdirSync(dir).filter((entry) => entry.startsWith(`${VAULT_FILE_NAME}.bak-`))
    expect(backups).toHaveLength(1)
  })
})
