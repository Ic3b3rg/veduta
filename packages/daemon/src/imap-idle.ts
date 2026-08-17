import type { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ImapFlow } from 'imapflow'
import type {
  ExistsEvent,
  FetchMessageObject,
  ImapFlowOptions,
  MailboxObject,
  StatusObject,
} from 'imapflow'
import type { ExternalEvent, ExternalEventBatch } from './external-event.ts'
import type { IngestionSource } from './ingestion-config.ts'
import type { SecretResolver } from './model-routing.ts'
import { defaultRedactor } from './redaction.ts'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'

export interface ImapClient extends EventEmitter {
  capabilities: Map<string, boolean | number>
  connect(): Promise<void>
  close(): void
  mailboxOpen(path: string): Promise<MailboxObject>
  status(path: string, query: { uidNext?: boolean; uidValidity?: boolean }): Promise<StatusObject>
  fetchAll(
    range: string,
    query: { headers?: string[] },
    options?: { uid?: boolean },
  ): Promise<FetchMessageObject[]>
}

export type ImapSettings = Extract<IngestionSource, { adapter: 'imap-idle' }>['imap']
type ImapBatchDisposition = { rateLimited?: true }

export interface ImapIdleSourceOptions {
  rootDir: string
  source: string
  settings: ImapSettings
  secrets: SecretResolver
  cursor: () => string | undefined
  onBatch: (
    batch: ExternalEventBatch,
  ) => void | ImapBatchDisposition | Promise<void | ImapBatchDisposition>
  onAlert?: (source: string, message: string) => void
  clientFactory?: (options: ImapFlowOptions) => ImapClient
  beforeConnect?: (host: string, port: number) => void
  maxBatchSize?: number
  now?: () => Date
}

export interface ImapConnectionHealth {
  source: string
  consecutiveFailures: number
  alerted: boolean
  lastError?: string
  lastConnectedAt?: string
}

const IDLE_RESTART_MS = 25 * 60 * 1000
const SOCKET_TIMEOUT_MS = 30 * 60 * 1000
const MAX_RESPONSE_BYTES = 128 * 1024
const RATE_LIMIT_RETRY_MS = 60 * 1000
const DEFAULT_MAX_BATCH_SIZE = 60
const CONNECTION_ERROR = 'IMAP connection failed'

/**
 * One long-lived IMAP IDLE source. ImapFlow owns the protocol and TLS
 * state machine; Veduta owns cursoring, health, reconnect, and ingestion.
 * See `docs/adr/0023-imap-idle-client.md`.
 */
export class ImapIdleSource {
  private readonly options: ImapIdleSourceOptions
  private readonly clientFactory: (options: ImapFlowOptions) => ImapClient
  private readonly db: DatabaseSync
  private readonly now: () => Date
  private readonly maxBatchSize: number
  private readonly failedClients = new WeakSet<ImapClient>()
  private client: ImapClient | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private deferredSyncTimer: NodeJS.Timeout | undefined
  private connecting = false
  private stopped = true
  private syncChain: Promise<void> = Promise.resolve()

  constructor(options: ImapIdleSourceOptions) {
    this.options = options
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new ImapFlow(clientOptions))
    this.now = options.now ?? (() => new Date())
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize <= 0) {
      throw new Error('IMAP maxBatchSize must be a positive safe integer')
    }
    this.db = new DatabaseSync(join(options.rootDir, 'ingestion.sqlite'))
    this.initializeHealth()
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.clearDeferredSync()
    this.client?.close()
    this.client = undefined
  }

  health(): ImapConnectionHealth {
    const row = this.db
      .prepare('select * from imap_connections where source = ?')
      .get(this.options.source)
    if (!row) throw new Error(`missing IMAP health row for source "${this.options.source}"`)
    const lastError = optionalString(row, 'last_error')
    const lastConnectedAt = optionalString(row, 'last_connected_at')
    return {
      source: requiredString(row, 'source'),
      consecutiveFailures: requiredNumber(row, 'consecutive_failures'),
      alerted: requiredNumber(row, 'alerted') === 1,
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return
    this.connecting = true
    let client: ImapClient | undefined
    try {
      const { settings } = this.options
      this.options.beforeConnect?.(settings.host, settings.port)
      const user = this.resolveSecret(settings.usernameRef, 'username')
      const pass = this.resolveSecret(settings.passwordRef, 'password')
      const activeClient = this.clientFactory({
        host: settings.host,
        port: settings.port,
        secure: true,
        servername: settings.host,
        auth: { user, pass, loginMethod: settings.authMethod },
        logger: false,
        logRaw: false,
        maxIdleTime: IDLE_RESTART_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
        maxLineLength: MAX_RESPONSE_BYTES,
        maxLiteralSize: MAX_RESPONSE_BYTES,
        tls: { minVersion: 'TLSv1.2' },
      })
      client = activeClient
      this.client = activeClient
      activeClient.on('error', () => this.fail(activeClient))
      activeClient.on('close', () => this.fail(activeClient))
      activeClient.on('exists', (event: ExistsEvent) => {
        if (event.path !== 'INBOX' || event.count <= event.prevCount) return
        this.queueSync(activeClient)
      })
      await activeClient.connect()
      if (this.stopped) {
        activeClient.close()
        return
      }
      if (!activeClient.capabilities.has('IDLE')) {
        throw new Error(`IMAP source "${this.options.source}" does not support IDLE`)
      }
      const mailbox = await activeClient.mailboxOpen('INBOX')
      if (this.stopped || activeClient !== this.client) return
      if (this.options.cursor() === undefined) {
        await this.options.onBatch({
          events: [],
          nextCursor: encodeCursor(mailbox.uidValidity, Math.max(0, mailbox.uidNext - 1)),
        })
        // Close the SELECT→baseline race: an EXISTS received while the
        // empty baseline batch was committing gets a fresh UIDNEXT check.
        await this.runSync(activeClient)
      } else {
        await this.runSync(activeClient, mailbox)
      }
      if (this.stopped || activeClient !== this.client) return
      this.recordSuccess()
    } catch {
      this.fail(client)
    } finally {
      this.connecting = false
    }
  }

  private queueSync(client: ImapClient): void {
    if (this.deferredSyncTimer) return
    void this.runSync(client).catch(() => this.fail(client))
  }

  private runSync(
    client: ImapClient,
    knownStatus?: { uidValidity: bigint; uidNext: number },
  ): Promise<void> {
    const next = this.syncChain.then(async () => this.syncInbox(client, knownStatus))
    this.syncChain = next.catch(() => {})
    return next
  }

  private async syncInbox(
    client: ImapClient,
    knownStatus?: { uidValidity: bigint; uidNext: number },
  ): Promise<void> {
    if (this.stopped || client !== this.client) return
    const cursor = parseCursor(this.options.cursor())
    if (!cursor) return
    const status =
      knownStatus ??
      requireUidStatus(await client.status('INBOX', { uidValidity: true, uidNext: true }))
    const newestUid = Math.max(0, status.uidNext - 1)
    if (status.uidValidity !== cursor.uidValidity) {
      await this.options.onBatch({
        events: [],
        nextCursor: encodeCursor(status.uidValidity, newestUid),
        reset: true,
      })
      return
    }
    const targetUid = Math.min(newestUid, cursor.uid + this.maxBatchSize)
    if (targetUid <= cursor.uid) return

    const messages = await client.fetchAll(
      `${cursor.uid + 1}:${targetUid}`,
      { headers: ['from', 'subject', 'list-unsubscribe', 'precedence'] },
      { uid: true },
    )
    const fetched = messages
      .filter((message) => message.uid > cursor.uid && message.uid <= targetUid)
      .sort((left, right) => left.uid - right.uid)
    const outcome = await this.options.onBatch({
      events: fetched.map((message) =>
        toExternalEvent(this.options.source, status.uidValidity, message),
      ),
      nextCursor: encodeCursor(status.uidValidity, targetUid),
    })
    if (outcome?.rateLimited) {
      this.deferSync(client, RATE_LIMIT_RETRY_MS)
      return
    }
    if (targetUid < newestUid) this.deferSync(client, 0)
  }

  private resolveSecret(ref: string, name: string): string {
    const value = this.options.secrets.resolve(ref)
    if (value === undefined) {
      throw new Error(`IMAP ${name} secret for source "${this.options.source}" does not resolve`)
    }
    defaultRedactor.register(value)
    return value
  }

  private fail(client: ImapClient | undefined): void {
    if (this.stopped) return
    if (client && this.failedClients.has(client)) return
    if (client) {
      this.failedClients.add(client)
      if (this.client === client) {
        this.client = undefined
        this.clearDeferredSync()
      }
      client.close()
    }
    const failures = this.recordFailure()
    this.scheduleReconnect(failures)
  }

  private recordFailure(): number {
    const current = this.health()
    const failures = current.consecutiveFailures + 1
    const shouldAlert = failures >= 3 && !current.alerted
    this.db
      .prepare(
        `update imap_connections
         set consecutive_failures = ?, alerted = ?, last_error = ?, updated_at = ?
         where source = ?`,
      )
      .run(
        failures,
        shouldAlert || current.alerted ? 1 : 0,
        CONNECTION_ERROR,
        this.now().toISOString(),
        this.options.source,
      )
    if (shouldAlert) {
      this.options.onAlert?.(
        this.options.source,
        `IMAP connection for event source "${this.options.source}" has failed ${failures} times in a row; new mail may be missed until it recovers.`,
      )
    }
    return failures
  }

  private recordSuccess(): void {
    const at = this.now().toISOString()
    this.db
      .prepare(
        `update imap_connections
         set consecutive_failures = 0, alerted = 0, last_error = null,
             last_connected_at = ?, updated_at = ?
         where source = ?`,
      )
      .run(at, at, this.options.source)
  }

  private scheduleReconnect(failures: number): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(1_000 * 2 ** Math.max(0, failures - 1), 60_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private deferSync(client: ImapClient, delay: number): void {
    if (this.stopped || client !== this.client || this.deferredSyncTimer) return
    this.deferredSyncTimer = setTimeout(() => {
      this.deferredSyncTimer = undefined
      this.queueSync(client)
    }, delay)
    this.deferredSyncTimer.unref?.()
  }

  private clearDeferredSync(): void {
    if (this.deferredSyncTimer) clearTimeout(this.deferredSyncTimer)
    this.deferredSyncTimer = undefined
  }

  private initializeHealth(): void {
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists imap_connections (
        source text primary key,
        consecutive_failures integer not null default 0,
        alerted integer not null default 0,
        last_error text,
        last_connected_at text,
        updated_at text not null
      );
    `)
    this.db
      .prepare(
        `insert or ignore into imap_connections
           (source, consecutive_failures, alerted, updated_at)
         values (?, 0, 0, ?)`,
      )
      .run(this.options.source, this.now().toISOString())
  }
}

function encodeCursor(uidValidity: bigint, uid: number): string {
  return `imap:v1:${uidValidity.toString()}:${uid}`
}

function requireUidStatus(status: StatusObject): { uidValidity: bigint; uidNext: number } {
  if (status.uidValidity === undefined || status.uidNext === undefined) {
    throw new Error('IMAP server did not report UIDVALIDITY and UIDNEXT')
  }
  return { uidValidity: status.uidValidity, uidNext: status.uidNext }
}

function parseCursor(value: string | undefined): { uidValidity: bigint; uid: number } | undefined {
  if (value === undefined) return undefined
  const match = /^imap:v1:(\d+):(\d+)$/.exec(value)
  if (!match?.[1] || !match[2]) throw new Error('invalid IMAP cursor')
  const uid = Number(match[2])
  if (!Number.isSafeInteger(uid)) throw new Error('invalid IMAP cursor')
  return { uidValidity: BigInt(match[1]), uid }
}

function toExternalEvent(
  source: string,
  uidValidity: bigint,
  message: FetchMessageObject,
): ExternalEvent {
  const headers = selectedHeaders(message.headers)
  const sender = senderAddress(headers['from'])
  const subject = headers['subject']
  return {
    source,
    kind: 'email',
    externalId: `${uidValidity.toString()}:${message.uid}`,
    type: 'message.received',
    ...(sender ? { sender } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  }
}

function selectedHeaders(buffer: Buffer | undefined): Record<string, string> {
  if (!buffer) return {}
  const allowed = new Set(['from', 'subject', 'list-unsubscribe', 'precedence'])
  const unfolded = buffer.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  const result: Record<string, string> = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    if (!allowed.has(name)) continue
    const value = line.slice(separator + 1).trim()
    if (value && result[name] === undefined) result[name] = value
  }
  return result
}

function senderAddress(from: string | undefined): string | undefined {
  if (!from) return undefined
  const angleAddress = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1]
  const bareAddress = /(?:^|[\s,])([^<>()\s,;]+@[^<>()\s,;]+)/.exec(from)?.[1]
  return (angleAddress ?? bareAddress)?.trim().toLowerCase()
}
