import { z } from 'zod'
import type { GmailConnections } from './gmail-connections.ts'
import type { MailboxAccount, MailboxScope } from './mailbox-scope.ts'
import { gmailQuery } from './mailbox-scope.ts'

export interface RawMail {
  providerId: string
  sender: string
  subject: string
  body: string
  receivedAt?: string
}

const ListSchema = z.object({
  messages: z
    .array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
    .max(20)
    .optional(),
  nextPageToken: z.string().optional(),
})

interface MessagePart {
  mimeType?: string | undefined
  headers?: { name: string; value: string }[] | undefined
  body?: { data?: string | undefined } | undefined
  parts?: MessagePart[] | undefined
}

const PartSchema: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(PartSchema).optional(),
  }),
)

const FullSchema = z.object({
  id: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().regex(/^\d+$/).optional(),
  payload: PartSchema.optional(),
})

function header(part: MessagePart | undefined, name: string): string {
  return part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function bodyPart(part: MessagePart | undefined, mime: string): MessagePart | undefined {
  if (!part) return undefined
  if (part.mimeType === mime && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const found = bodyPart(child, mime)
    if (found) return found
  }
  return undefined
}

function decodedBody(payload: MessagePart | undefined): string {
  const plain = bodyPart(payload, 'text/plain')
  const html = plain ? undefined : bodyPart(payload, 'text/html')
  const data = plain?.body?.data ?? html?.body?.data
  if (!data) return ''
  const decoded = Buffer.from(data, 'base64url').toString('utf8')
  const text = html ? decoded.replace(/<[^>]*>/g, ' ') : decoded
  return text.slice(0, 16_384)
}

export class GmailMailbox {
  constructor(private readonly connections: GmailConnections) {}

  accounts(): MailboxAccount[] {
    return this.connections
      .snapshot()
      .connections.filter((connection) => connection.state === 'ready' && connection.accountEmail)
      .map((connection) => ({
        id: connection.id,
        provider: 'gmail' as const,
        name: connection.name,
        address: connection.accountEmail!,
      }))
  }

  async search(
    scope: MailboxScope,
    signal?: AbortSignal,
    authorize: () => void = () => {},
  ): Promise<RawMail[]> {
    if (scope.account.provider !== 'gmail') throw new Error('Mailbox provider mismatch')
    authorize()
    const list = ListSchema.parse(
      await this.connections.listMessageIds(
        scope.account.id,
        gmailQuery(scope),
        scope.newest ? 20 : scope.limit,
        signal,
      ),
    )
    const ids = scope.newest
      ? await this.newestIds(scope, list, signal, authorize)
      : (list.messages ?? []).slice(0, scope.limit)
    const result: RawMail[] = []
    for (const { id } of ids) {
      authorize()
      const message = FullSchema.parse(
        await this.connections.getMessage(scope.account.id, id, signal),
      )
      if (message.id !== id) throw new Error('Gmail returned the wrong message')
      if (scope.unreadOnly && !message.labelIds?.includes('UNREAD')) continue
      result.push({
        providerId: id,
        sender: header(message.payload, 'From').slice(0, 500),
        subject: header(message.payload, 'Subject').slice(0, 500),
        body: decodedBody(message.payload),
        ...(message.internalDate === undefined
          ? {}
          : { receivedAt: new Date(Number(message.internalDate)).toISOString() }),
      })
    }
    authorize()
    return result
  }

  private async newestIds(
    scope: MailboxScope,
    initial: z.infer<typeof ListSchema>,
    signal: AbortSignal | undefined,
    authorize: () => void,
  ): Promise<{ id: string }[]> {
    // Gmail documents internalDate as Inbox order, but messages.list has no sort contract.
    // Find a complete recent interval before comparing metadata; never trust its first result.
    let list = initial
    let after = 0
    let lower = 0
    let upper = Math.floor(Date.now() / 1000) + 1
    for (
      let probe = 0;
      list.nextPageToken || (after > 0 && (list.messages?.length ?? 0) < scope.limit);
      probe++
    ) {
      if (probe >= 32 || upper - lower <= 1)
        throw new Error(
          'The newest messages could not be established within the read limit. Choose a narrower folder or time window.',
        )
      if (after > 0) {
        if (list.nextPageToken) lower = after
        else upper = after
      }
      after = probe === 0 ? Math.max(1, upper - 86_400) : Math.floor((lower + upper) / 2)
      authorize()
      signal?.throwIfAborted()
      list = ListSchema.parse(
        await this.connections.listMessageIds(
          scope.account.id,
          [gmailQuery(scope) ? `(${gmailQuery(scope)})` : '', `after:${after}`]
            .filter(Boolean)
            .join(' '),
          20,
          signal,
        ),
      )
    }
    const metadata: { id: string; received: number }[] = []
    for (const { id } of list.messages ?? []) {
      authorize()
      signal?.throwIfAborted()
      const message = FullSchema.parse(
        await this.connections.getMessage(scope.account.id, id, signal, 'metadata'),
      )
      const received = Number(message.internalDate)
      if (message.id !== id || !Number.isSafeInteger(received) || received < after * 1000)
        throw new Error(
          'Gmail did not provide a valid received timestamp for newest-message selection',
        )
      metadata.push({ id, received })
    }
    return metadata
      .sort((a, b) => b.received - a.received || a.id.localeCompare(b.id))
      .slice(0, scope.limit)
  }
}
