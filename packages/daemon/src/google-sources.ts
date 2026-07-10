import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExternalEvent } from './external-event.ts'
import type { SecretResolver } from './model-routing.ts'

/**
 * Fetch-based Gmail/Calendar integration (issue #12): watch renewal and
 * the fetch stages that turn Google push notifications (which carry no
 * filterable content) into normalized ExternalEvents. Plain `fetch`
 * against the Google REST APIs — no SDK dependency; OAuth material
 * arrives as `secret://` references and access tokens never leave this
 * module (SECURITY.md §4).
 */
export type FetchLike = typeof globalThis.fetch

export interface GoogleTokenProviderOptions {
  clientIdRef: string
  clientSecretRef: string
  refreshTokenRef: string
  secrets: SecretResolver
  fetchFn?: FetchLike
  now?: () => Date
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Refresh this many ms before the reported expiry. */
const TOKEN_SLACK_MS = 60_000

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
})

export class GoogleTokenProvider {
  private readonly options: GoogleTokenProviderOptions
  private readonly fetchFn: FetchLike
  private readonly now: () => Date
  private cached: { token: string; expiresAtMs: number } | undefined

  constructor(options: GoogleTokenProviderOptions) {
    this.options = options
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - TOKEN_SLACK_MS > this.now().getTime()) {
      return this.cached.token
    }
    const clientId = this.resolve(this.options.clientIdRef, 'client id')
    const clientSecret = this.resolve(this.options.clientSecretRef, 'client secret')
    const refreshToken = this.resolve(this.options.refreshTokenRef, 'refresh token')
    const response = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
    })
    if (!response.ok) {
      // Never include the response body: token endpoint errors are logged
      // upstream and must not risk echoing credential material.
      throw new Error(`Google token refresh failed with status ${response.status}`)
    }
    const parsed = TokenResponseSchema.parse(await response.json())
    this.cached = {
      token: parsed.access_token,
      expiresAtMs: this.now().getTime() + parsed.expires_in * 1000,
    }
    return parsed.access_token
  }

  private resolve(ref: string, what: string): string {
    const value = this.options.secrets.resolve(ref)
    if (value === undefined) throw new Error(`Google ${what} secret does not resolve`)
    return value
  }
}

export interface GoogleSourceOptions {
  source: string
  tokens: GoogleTokenProvider
  fetchFn?: FetchLike
  now?: () => Date
}

export interface FetchStageResult {
  events: ExternalEvent[]
  /** Persist atomically with the batch: the checkpoint for the next fetch. */
  nextCursor: string
  /** The provider cursor was unusable; the baseline was re-established. */
  reset?: boolean
}

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

const GmailWatchResponseSchema = z.object({
  historyId: z.string().min(1),
  expiration: z.string().regex(/^\d+$/),
})

const GmailProfileSchema = z.object({ historyId: z.string().min(1) })

const GmailHistoryPageSchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string().min(1) }) }))
          .optional(),
      }),
    )
    .optional(),
  historyId: z.string().min(1),
  nextPageToken: z.string().optional(),
})

const GmailMessageSchema = z.object({
  id: z.string().min(1),
  internalDate: z.string().regex(/^\d+$/).optional(),
  payload: z
    .object({
      headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    })
    .optional(),
})

const METADATA_HEADERS = ['From', 'Subject', 'List-Unsubscribe', 'Precedence']

/**
 * A MIME part of a `format=full` Gmail message: text/plain or text/html
 * leaves, or a multipart node. Optional fields are typed `| undefined`
 * explicitly (not just `?`) to match zod's `.optional()` output shape
 * under `exactOptionalPropertyTypes`.
 */
interface GmailMessagePart {
  mimeType?: string | undefined
  body?: { data?: string | undefined; size?: number | undefined } | undefined
  parts?: GmailMessagePart[] | undefined
}

const GmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    parts: z.array(GmailMessagePartSchema).optional(),
  }),
)

const GmailFullMessageSchema = z.object({
  id: z.string().min(1),
  payload: GmailMessagePartSchema.optional(),
})

/** Depth-first search for the first leaf part whose `mimeType` matches and that carries body data. */
function findMessagePart(
  part: GmailMessagePart | undefined,
  mimeType: string,
): GmailMessagePart | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data !== undefined) return part
  for (const child of part.parts ?? []) {
    const found = findMessagePart(child, mimeType)
    if (found) return found
  }
  return undefined
}

/** Gmail body data is base64url, unpadded (RFC 4648 §5) — Node's `base64url` encoding decodes it directly. */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

const BODY_CAP_BYTES = 64 * 1024

/** Approximate byte cap: bounds prompt size, not exact UTF-8 accounting (matches quarantined-reader.ts). */
function capBody(value: string): string {
  return value.length <= BODY_CAP_BYTES ? value : `${value.slice(0, BODY_CAP_BYTES)}…`
}

/** Naive tag-strip for the `text/html` fallback: good enough to bound size, not a sanitizer — the body stays quarantined regardless. */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

export class GmailSource {
  private readonly source: string
  private readonly tokens: GoogleTokenProvider
  private readonly fetchFn: FetchLike

  constructor(options: GoogleSourceOptions) {
    this.source = options.source
    this.tokens = options.tokens
    this.fetchFn = options.fetchFn ?? fetch
  }

  /**
   * `users.watch`: (re)arm the Pub/Sub push channel; call at least daily.
   * The returned `historyId` is the only cursor that catches messages
   * arriving between watch creation and the first push — the caller
   * baselines from it when no cursor exists yet.
   */
  async renewWatch(topicName: string): Promise<{ expiresAt: string; historyId: string }> {
    const response = await this.request('POST', `${GMAIL_BASE}/watch`, {
      topicName,
      labelIds: ['INBOX'],
    })
    const parsed = GmailWatchResponseSchema.parse(response)
    return {
      expiresAt: new Date(Number(parsed.expiration)).toISOString(),
      historyId: parsed.historyId,
    }
  }

  /**
   * Turn a push notification into events: list history since the cursor
   * and fetch metadata (never the body) for every new message. A stale
   * cursor (Gmail keeps history ~a week) re-baselines instead of failing
   * forever; the gap is reported so the user hears about it.
   */
  async fetchNewMessages(cursor: string | undefined): Promise<FetchStageResult> {
    if (cursor === undefined) return this.baseline(false)

    const messageIds: string[] = []
    let pageToken: string | undefined
    let latestHistoryId = cursor
    do {
      const url = new URL(`${GMAIL_BASE}/history`)
      url.searchParams.set('startHistoryId', cursor)
      url.searchParams.set('historyTypes', 'messageAdded')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const raw = await this.requestRaw('GET', url.toString())
      if (raw.status === 404) return this.baseline(true)
      const page = GmailHistoryPageSchema.parse(await okJson(raw, 'gmail history.list'))
      latestHistoryId = page.historyId
      for (const entry of page.history ?? []) {
        for (const added of entry.messagesAdded ?? []) messageIds.push(added.message.id)
      }
      pageToken = page.nextPageToken
    } while (pageToken)

    const events: ExternalEvent[] = []
    for (const id of messageIds) {
      events.push(await this.fetchMessageMetadata(id))
    }
    return { events, nextCursor: latestHistoryId }
  }

  private async baseline(reset: boolean): Promise<FetchStageResult> {
    const profile = GmailProfileSchema.parse(await this.request('GET', `${GMAIL_BASE}/profile`))
    return { events: [], nextCursor: profile.historyId, ...(reset ? { reset: true } : {}) }
  }

  /**
   * Re-fetches the full body for the quarantined reader / full-text flow
   * (issue #13): `format=full`, walk `payload.parts` for the first
   * `text/plain` leaf (fallback: naive tag-strip on `text/html`),
   * base64url-decode, cap at 64 KiB. `undefined` when no text body is
   * found. This is quarantined data — the caller marks it untrusted; this
   * method never interprets it.
   */
  async fetchMessageBody(messageId: string): Promise<string | undefined> {
    const url = new URL(`${GMAIL_BASE}/messages/${messageId}`)
    url.searchParams.set('format', 'full')
    const message = GmailFullMessageSchema.parse(await this.request('GET', url.toString()))

    const plain = findMessagePart(message.payload, 'text/plain')
    if (plain?.body?.data !== undefined) return capBody(decodeBase64Url(plain.body.data))

    const html = findMessagePart(message.payload, 'text/html')
    if (html?.body?.data !== undefined)
      return capBody(stripHtmlTags(decodeBase64Url(html.body.data)))

    return undefined
  }

  private async fetchMessageMetadata(id: string): Promise<ExternalEvent> {
    const url = new URL(`${GMAIL_BASE}/messages/${id}`)
    url.searchParams.set('format', 'metadata')
    for (const header of METADATA_HEADERS) url.searchParams.append('metadataHeaders', header)
    const message = GmailMessageSchema.parse(await this.request('GET', url.toString()))
    const headers: Record<string, string> = {}
    for (const header of message.payload?.headers ?? []) {
      headers[header.name.toLowerCase()] = header.value
    }
    const from = headers['from']
    const subject = headers['subject']
    return {
      source: this.source,
      kind: 'email',
      externalId: message.id,
      type: 'message.received',
      headers,
      fetchRef: { provider: 'gmail', id: message.id },
      ...(from === undefined ? {} : { sender: from }),
      ...(subject === undefined ? {} : { subject }),
      ...(message.internalDate === undefined
        ? {}
        : { occurredAt: new Date(Number(message.internalDate)).toISOString() }),
    }
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    return okJson(
      await this.requestRaw(method, url, body),
      `gmail ${method} ${new URL(url).pathname}`,
    )
  }

  private async requestRaw(method: string, url: string, body?: unknown): Promise<Response> {
    const token = await this.tokens.accessToken()
    return this.fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

const CalendarWatchResponseSchema = z.object({
  resourceId: z.string().min(1),
  expiration: z.string().regex(/^\d+$/),
})

const CalendarEventsPageSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.string().min(1),
        updated: z.string().optional(),
        summary: z.string().optional(),
        creator: z.object({ email: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
})

export class CalendarSource {
  private readonly source: string
  private readonly tokens: GoogleTokenProvider
  private readonly fetchFn: FetchLike
  private readonly now: () => Date

  constructor(options: GoogleSourceOptions) {
    this.source = options.source
    this.tokens = options.tokens
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  /** `events.watch`: open a fresh push channel; the old one lapses on its TTL. */
  async renewWatch(input: {
    calendarId: string
    address: string
    channelToken: string
  }): Promise<{ expiresAt: string; channelId: string; resourceId: string }> {
    const channelId = randomUUID()
    const response = await this.request(
      'POST',
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
      { id: channelId, type: 'web_hook', address: input.address, token: input.channelToken },
    )
    const parsed = CalendarWatchResponseSchema.parse(response)
    return {
      expiresAt: new Date(Number(parsed.expiration)).toISOString(),
      channelId,
      resourceId: parsed.resourceId,
    }
  }

  /**
   * `channels.stop`: close a superseded push channel after a successful
   * renewal, so stale channels do not keep pushing until their TTL.
   */
  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    const token = await this.tokens.accessToken()
    const response = await this.fetchFn(`${CALENDAR_BASE}/channels/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: channelId, resourceId }),
    })
    if (!response.ok) {
      throw new Error(`calendar channels.stop failed with status ${response.status}`)
    }
  }

  /** List events changed since the cursor; the next cursor is the sweep start. */
  async fetchChangedEvents(
    calendarId: string,
    cursor: string | undefined,
  ): Promise<FetchStageResult> {
    const sweepStart = this.now().toISOString()
    if (cursor === undefined) return { events: [], nextCursor: sweepStart }

    const events: ExternalEvent[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`)
      url.searchParams.set('updatedMin', cursor)
      url.searchParams.set('showDeleted', 'true')
      url.searchParams.set('singleEvents', 'false')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const page = CalendarEventsPageSchema.parse(await this.request('GET', url.toString()))
      for (const item of page.items ?? []) {
        const sender = item.creator?.email?.toLowerCase()
        events.push({
          source: this.source,
          kind: 'calendar',
          externalId: `${item.id}:${item.updated ?? 'unknown'}`,
          type: `calendar.${item.status}`,
          fetchRef: { provider: 'calendar', id: item.id },
          ...(sender === undefined ? {} : { sender }),
          ...(item.summary === undefined ? {} : { subject: item.summary }),
          ...(item.updated === undefined ? {} : { occurredAt: item.updated }),
        })
      }
      pageToken = page.nextPageToken
    } while (pageToken)

    return { events, nextCursor: sweepStart }
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await this.tokens.accessToken()
    const response = await this.fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return okJson(response, `calendar ${method} ${new URL(url).pathname}`)
  }
}

/** The Pub/Sub push envelope Gmail notifications arrive in. */
export const PubSubPushSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1),
  }),
  subscription: z.string().min(1),
})

const GmailNotificationSchema = z.object({
  emailAddress: z.string().min(1),
  historyId: z.union([z.string().min(1), z.number()]),
})

/** Decode and validate the base64 Gmail notification inside a Pub/Sub push. */
export function decodeGmailPush(
  body: unknown,
  expectedSubscription: string,
): { ok: true; messageId: string } | { ok: false; reason: string } {
  const envelope = PubSubPushSchema.safeParse(body)
  if (!envelope.success) return { ok: false, reason: 'malformed pub/sub envelope' }
  if (envelope.data.subscription !== expectedSubscription) {
    return { ok: false, reason: 'unexpected pub/sub subscription' }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(envelope.data.message.data, 'base64').toString('utf8'))
  } catch {
    return { ok: false, reason: 'undecodable pub/sub payload' }
  }
  if (!GmailNotificationSchema.safeParse(decoded).success) {
    return { ok: false, reason: 'malformed gmail notification' }
  }
  return { ok: true, messageId: envelope.data.message.messageId }
}

async function okJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what} failed with status ${response.status}`)
  return response.json()
}
