import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  GMAIL_READ_SCOPE,
  GmailConnectionsSnapshotSchema,
  GmailConnectionSchema,
  type CreateGmailConnectionRequest,
  type GmailConnection,
  type GmailConnectionsSnapshot,
} from '@veduta/protocol'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'
import { GoogleTokenProvider, type FetchLike } from './google-sources.ts'
import { loadIngestionConfig } from './ingestion-config.ts'
import { readJsonFile } from './json-file.ts'
import type { SecretResolver } from './model-routing.ts'
import { defaultRedactor } from './redaction.ts'
import type { SecretsVault } from './secrets-vault.ts'

const FILE_NAME = 'gmail-connections.json'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
const LEGACY_ID = 'svc-gmail-legacy'
const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000

const SecretRefSchema = z.string().regex(/^secret:\/\/(vault|env)\/[a-zA-Z0-9_-]+$/)
const AuthorizationSchema = z
  .object({
    stateHash: z.string().length(64),
    verifierRef: SecretRefSchema,
    redirectUri: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict()
const RecordSchema = GmailConnectionSchema.extend({
  clientIdRef: SecretRefSchema.optional(),
  clientSecretRef: SecretRefSchema.optional(),
  refreshTokenRef: SecretRefSchema.optional(),
  authorization: AuthorizationSchema.optional(),
}).strict()
const FileSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(RecordSchema),
    dismissedLegacyIds: z.array(z.string()).default([]),
  })
  .strict()

type Record = z.infer<typeof RecordSchema>

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string().min(1),
})
const ProfileSchema = z.object({ emailAddress: z.string().email() })

export class GmailConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface GmailConnectionsOptions {
  rootDir: string
  vault: SecretsVault | undefined
  secrets: SecretResolver
  allowedRedirectOrigins: readonly string[]
  fetchFn?: FetchLike
  now?: () => Date
  onConfigured?: () => void
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function publicConnection(record: Record): GmailConnection {
  const { id, name, accountEmail, state, reason, scopes, createdAt, updatedAt } = record
  return GmailConnectionSchema.parse({
    id,
    name,
    ...(accountEmail === undefined ? {} : { accountEmail }),
    state,
    ...(reason === undefined ? {} : { reason }),
    scopes,
    createdAt,
    updatedAt,
  })
}

export class GmailConnections {
  private readonly path: string
  private readonly options: GmailConnectionsOptions
  private readonly fetchFn: FetchLike
  private readonly now: () => Date
  private readonly tokenProviders = new Map<string, GoogleTokenProvider>()
  private records: Record[]
  private readonly dismissedLegacyIds: Set<string>

  constructor(options: GmailConnectionsOptions) {
    this.options = options
    this.path = join(options.rootDir, FILE_NAME)
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => new Date())
    const stored = existsSync(this.path)
      ? FileSchema.parse(readJsonFile(this.path, { description: 'Gmail connections' }))
      : FileSchema.parse({ version: 1, connections: [] })
    this.records = stored.connections
    this.dismissedLegacyIds = new Set(stored.dismissedLegacyIds)
    this.normalizeInterruptedAuthorization()
    this.adoptLegacySource()
  }

  snapshot(): GmailConnectionsSnapshot {
    return GmailConnectionsSnapshotSchema.parse({
      connections: this.records.map(publicConnection),
    })
  }

  create(input: CreateGmailConnectionRequest): GmailConnectionsSnapshot {
    const vault = this.requireVault()
    defaultRedactor.register(input.clientSecret)
    const id = `svc-gmail-${randomUUID()}`
    const at = this.now().toISOString()
    const clientIdRef = `secret://vault/gmail-client-id-${id}`
    const clientSecretRef = `secret://vault/gmail-client-secret-${id}`
    vault.set(clientIdRef.slice('secret://vault/'.length), input.clientId)
    vault.set(clientSecretRef.slice('secret://vault/'.length), input.clientSecret)
    this.records.push({
      id,
      name: input.name,
      state: 'needs_authorization',
      scopes: [GMAIL_READ_SCOPE],
      createdAt: at,
      updatedAt: at,
      clientIdRef,
      clientSecretRef,
    })
    this.persist()
    this.options.onConfigured?.()
    return this.snapshot()
  }

  rename(id: string, name: string): GmailConnectionsSnapshot {
    const record = this.find(id)
    record.name = name
    record.updatedAt = this.now().toISOString()
    this.persist()
    return this.snapshot()
  }

  beginAuthorization(
    id: string,
    redirectOrigin: string,
    redirectPath: '/app/settings/gmail' | '/app/connections' = '/app/settings/gmail',
  ): { authorizationUrl: string } {
    const record = this.find(id)
    const vault = this.requireVault()
    if (!this.options.allowedRedirectOrigins.includes(redirectOrigin)) {
      throw new GmailConnectionError(400, 'unsupported Gmail authorization origin')
    }
    const clientId = this.resolve(record.clientIdRef, 'Gmail OAuth client ID')
    this.resolve(record.clientSecretRef, 'Gmail OAuth client secret')
    const redirectUri = `${redirectOrigin}${redirectPath}`
    const state = `${id}.${randomBytes(32).toString('base64url')}`
    const verifier = randomBytes(32).toString('base64url')
    const verifierRef = `secret://vault/gmail-oauth-verifier-${id}`
    vault.set(verifierRef.slice('secret://vault/'.length), verifier)
    defaultRedactor.register(verifier)
    record.authorization = {
      stateHash: hash(state),
      verifierRef,
      redirectUri,
      expiresAt: new Date(this.now().getTime() + AUTHORIZATION_LIFETIME_MS).toISOString(),
    }
    record.state = 'authorizing'
    delete record.reason
    record.updatedAt = this.now().toISOString()
    this.persist()

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', GMAIL_READ_SCOPE)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url'),
    )
    url.searchParams.set('code_challenge_method', 'S256')
    if (record.accountEmail) url.searchParams.set('login_hint', record.accountEmail)
    return { authorizationUrl: url.toString() }
  }

  async completeAuthorization(
    id: string,
    code: string,
    state: string,
  ): Promise<GmailConnectionsSnapshot> {
    const record = this.find(id)
    const authorization = record.authorization
    if (
      record.state !== 'authorizing' ||
      !authorization ||
      this.now().toISOString() > authorization.expiresAt ||
      !safeEqual(hash(state), authorization.stateHash)
    ) {
      throw new GmailConnectionError(409, 'Gmail authorization expired or did not match')
    }
    const verifier = this.resolve(authorization.verifierRef, 'Gmail OAuth verifier')
    const clientId = this.resolve(record.clientIdRef, 'Gmail OAuth client ID')
    const clientSecret = this.resolve(record.clientSecretRef, 'Gmail OAuth client secret')
    record.state = 'verifying'
    delete record.authorization
    record.updatedAt = this.now().toISOString()
    this.persist()
    defaultRedactor.register(code)
    try {
      const response = await this.fetchFn(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: authorization.redirectUri,
          code,
          code_verifier: verifier,
        }).toString(),
      })
      if (!response.ok) throw new GmailConnectionError(502, 'Gmail authorization was rejected')
      const tokens = TokenResponseSchema.parse(await response.json())
      defaultRedactor.register(tokens.access_token)
      defaultRedactor.register(tokens.refresh_token)
      if (tokens.scope.split(' ').sort().join(' ') !== GMAIL_READ_SCOPE) {
        throw new GmailConnectionError(409, 'Gmail did not grant the requested read-only scope')
      }
      const profileResponse = await this.fetchFn(PROFILE_ENDPOINT, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      if (!profileResponse.ok)
        throw new GmailConnectionError(502, 'Gmail account verification failed')
      const profile = ProfileSchema.parse(await profileResponse.json())
      if (
        record.accountEmail &&
        record.accountEmail.toLowerCase() !== profile.emailAddress.toLowerCase()
      ) {
        throw new GmailConnectionError(409, 'Gmail account changed during reconnection')
      }
      if (
        this.records.some(
          (candidate) =>
            candidate.id !== id &&
            candidate.accountEmail?.toLowerCase() === profile.emailAddress.toLowerCase(),
        )
      ) {
        throw new GmailConnectionError(409, 'That Gmail account is already connected')
      }
      if (!this.records.includes(record))
        throw new GmailConnectionError(404, 'Gmail connection removed')
      const vault = this.requireVault()
      const refreshTokenRef = `secret://vault/gmail-refresh-token-${id}`
      vault.set(refreshTokenRef.slice('secret://vault/'.length), tokens.refresh_token)
      record.refreshTokenRef = refreshTokenRef
      this.tokenProviders.delete(id)
      record.accountEmail = profile.emailAddress
      record.state = 'ready'
      delete record.reason
      record.updatedAt = this.now().toISOString()
      this.persist()
      return this.snapshot()
    } catch (error) {
      if (this.records.includes(record)) {
        record.state = 'failed'
        record.reason =
          error instanceof GmailConnectionError ? error.message : 'Gmail authorization failed'
        record.updatedAt = this.now().toISOString()
        this.persist()
      }
      throw error instanceof GmailConnectionError
        ? error
        : new GmailConnectionError(502, 'Gmail authorization failed')
    } finally {
      this.options.vault?.delete(authorization.verifierRef.slice('secret://vault/'.length))
    }
  }

  failAuthorization(
    id: string,
    state: string,
    reason: 'access_denied' | 'other',
  ): GmailConnectionsSnapshot {
    const record = this.find(id)
    const authorization = record.authorization
    if (
      record.state !== 'authorizing' ||
      !authorization ||
      !safeEqual(hash(state), authorization.stateHash)
    ) {
      throw new GmailConnectionError(409, 'Gmail authorization expired or did not match')
    }
    this.options.vault?.delete(authorization.verifierRef.slice('secret://vault/'.length))
    delete record.authorization
    record.state = 'failed'
    record.reason =
      reason === 'access_denied' ? 'Gmail access was declined' : 'Gmail authorization failed'
    record.updatedAt = this.now().toISOString()
    this.persist()
    return this.snapshot()
  }

  async verifyLegacy(id: string): Promise<GmailConnectionsSnapshot> {
    const record = this.find(id)
    if (id !== LEGACY_ID || !record.refreshTokenRef) {
      throw new GmailConnectionError(
        409,
        'This Gmail connection has no legacy authorization to verify',
      )
    }
    record.state = 'verifying'
    record.updatedAt = this.now().toISOString()
    this.persist()
    try {
      const token = await new GoogleTokenProvider({
        clientIdRef: this.requiredRef(record.clientIdRef),
        clientSecretRef: this.requiredRef(record.clientSecretRef),
        refreshTokenRef: record.refreshTokenRef,
        secrets: this.options.secrets,
        fetchFn: this.fetchFn,
      }).accessToken()
      defaultRedactor.register(token)
      const response = await this.fetchFn(PROFILE_ENDPOINT, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('profile verification failed')
      const profile = ProfileSchema.parse(await response.json())
      if (!this.records.includes(record))
        throw new GmailConnectionError(404, 'Gmail connection removed')
      if (
        this.records.some(
          (candidate) =>
            candidate.id !== id &&
            candidate.accountEmail?.toLowerCase() === profile.emailAddress.toLowerCase(),
        )
      ) {
        throw new GmailConnectionError(409, 'That Gmail account is already connected')
      }
      record.accountEmail = profile.emailAddress
      record.state = 'ready'
      delete record.reason
      record.updatedAt = this.now().toISOString()
      this.persist()
      return this.snapshot()
    } catch (error) {
      if (this.records.includes(record)) {
        record.state = 'failed'
        record.reason =
          error instanceof GmailConnectionError
            ? error.message
            : 'Gmail account verification failed; reconnect to restore access'
        record.updatedAt = this.now().toISOString()
        this.persist()
      }
      throw error instanceof GmailConnectionError
        ? error
        : new GmailConnectionError(502, 'Gmail account verification failed')
    }
  }

  /** Identity-only check for a verified connection before another Space grants it. */
  async verifyAccount(id: string): Promise<string> {
    const record = this.find(id)
    if (record.state !== 'ready' || !record.accountEmail || !record.refreshTokenRef)
      throw new GmailConnectionError(409, 'Gmail connection needs authorization')
    const provider = new GoogleTokenProvider({
      clientIdRef: this.requiredRef(record.clientIdRef),
      clientSecretRef: this.requiredRef(record.clientSecretRef),
      refreshTokenRef: record.refreshTokenRef,
      secrets: this.options.secrets,
      fetchFn: this.fetchFn,
    })
    try {
      const token = await provider.accessToken()
      defaultRedactor.register(token)
      const response = await this.fetchFn(PROFILE_ENDPOINT, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
      })
      if (!response.ok) throw new Error('profile unavailable')
      const profile = ProfileSchema.parse(await response.json())
      if (profile.emailAddress.toLowerCase() !== record.accountEmail.toLowerCase())
        throw new GmailConnectionError(409, 'Gmail account changed during verification')
      return profile.emailAddress
    } catch (error) {
      throw error instanceof GmailConnectionError
        ? error
        : new GmailConnectionError(502, 'Gmail account verification failed')
    }
  }

  remove(id: string): GmailConnectionsSnapshot {
    const record = this.find(id)
    this.records = this.records.filter((candidate) => candidate.id !== id)
    if (id === LEGACY_ID) this.dismissedLegacyIds.add(id)
    this.tokenProviders.delete(id)
    this.persist()
    for (const ref of [
      record.clientIdRef,
      record.clientSecretRef,
      record.refreshTokenRef,
      record.authorization?.verifierRef,
    ]) {
      if (ref?.startsWith('secret://vault/')) {
        this.options.vault?.delete(ref.slice('secret://vault/'.length))
      }
    }
    return this.snapshot()
  }

  async listMessageIds(
    id: string,
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new GmailConnectionError(400, 'Gmail result bound must be between 1 and 20')
    }
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(maxResults))
    return this.readOnlyRequest(id, url, signal)
  }

  async getMessage(id: string, messageId: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]+$/.test(messageId)) {
      throw new GmailConnectionError(400, 'Invalid Gmail message id')
    }
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`)
    url.searchParams.set('format', 'full')
    return this.readOnlyRequest(id, url, signal)
  }

  private async readOnlyRequest(id: string, url: URL, signal?: AbortSignal): Promise<unknown> {
    const record = this.find(id)
    if (record.state !== 'ready' || !record.refreshTokenRef) {
      throw new GmailConnectionError(409, 'Gmail connection needs authorization')
    }
    let provider = this.tokenProviders.get(id)
    if (!provider) {
      provider = new GoogleTokenProvider({
        clientIdRef: this.requiredRef(record.clientIdRef),
        clientSecretRef: this.requiredRef(record.clientSecretRef),
        refreshTokenRef: record.refreshTokenRef,
        secrets: this.options.secrets,
        fetchFn: this.fetchFn,
        now: this.now,
      })
      this.tokenProviders.set(id, provider)
    }
    const token = await provider.accessToken()
    defaultRedactor.register(token)
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new GmailConnectionError(502, 'Gmail read failed')
    return response.json()
  }

  private find(id: string): Record {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw new GmailConnectionError(404, 'Gmail connection not found')
    return record
  }

  private requireVault(): SecretsVault {
    if (!this.options.vault) throw new GmailConnectionError(409, 'Secrets vault is unavailable')
    return this.options.vault
  }

  private requiredRef(ref: string | undefined): string {
    if (!ref) throw new GmailConnectionError(409, 'Gmail OAuth credentials are missing')
    return ref
  }

  private resolve(ref: string | undefined, name: string): string {
    const value = this.options.secrets.resolve(this.requiredRef(ref))
    if (!value) throw new GmailConnectionError(409, `${name} is unavailable`)
    return value
  }

  private persist(): void {
    const file = FileSchema.parse({
      version: 1,
      connections: this.records,
      dismissedLegacyIds: [...this.dismissedLegacyIds],
    })
    backupFile(this.path)
    writeJsonAtomic(this.path, file)
  }

  private normalizeInterruptedAuthorization(): void {
    let changed = false
    for (const record of this.records) {
      if (record.state === 'verifying') {
        record.state = 'failed'
        record.reason = 'Gmail authorization was interrupted; reconnect to try again'
        delete record.authorization
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private adoptLegacySource(): void {
    if (
      this.records.some((record) => record.id === LEGACY_ID) ||
      this.dismissedLegacyIds.has(LEGACY_ID)
    )
      return
    const source = loadIngestionConfig(this.options.rootDir).sources['gmail']
    if (source?.adapter !== 'gmail-push' || !source.google) return
    const { clientIdRef, clientSecretRef, refreshTokenRef } = source.google
    const available = [clientIdRef, clientSecretRef, refreshTokenRef].every(
      (ref) => this.options.secrets.resolve(ref) !== undefined,
    )
    const at = this.now().toISOString()
    this.records.push({
      id: LEGACY_ID,
      name: 'Imported Gmail',
      state: available ? 'needs_authorization' : 'needs_credentials',
      ...(available ? {} : { reason: 'Saved Gmail credentials are unavailable' }),
      scopes: [GMAIL_READ_SCOPE],
      createdAt: at,
      updatedAt: at,
      clientIdRef,
      clientSecretRef,
      refreshTokenRef,
    })
    this.persist()
  }
}
